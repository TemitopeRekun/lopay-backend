import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/client';
import type { AuthUser } from '../common/types/auth-user';
import { errorMessage } from '../common/errors';
import { FIREBASE_STORAGE } from '../firebase/firebase.module';
import type { Storage } from 'firebase-admin/storage';
import { withTimeout, withRetry } from '../common/resilience';

const ALLOWED_RECEIPT_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

// Canonical principal shape lives in common/types/auth-user.ts. Aliased here so
// existing `user: CurrentUser` references in this file keep reading naturally.
type CurrentUser = AuthUser;

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

@Injectable()
export class DocumentsService {
  private readonly signedUrlTtlSeconds: number;
  private readonly maxUploadBytes: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(FIREBASE_STORAGE) private readonly storage: Storage,
  ) {
    const ttl = Number(
      this.config.get<string>('FIREBASE_SIGNED_URL_TTL_SECONDS') ?? 600,
    );
    this.signedUrlTtlSeconds = Number.isFinite(ttl) ? ttl : 600;

    const maxBytes = Number(
      this.config.get<string>('FIREBASE_MAX_UPLOAD_BYTES') ??
        DEFAULT_MAX_UPLOAD_BYTES,
    );
    this.maxUploadBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_MAX_UPLOAD_BYTES;
  }

  private get bucket() {
    return this.storage.bucket();
  }

  async createReceiptUploadUrl(
    userId: string,
    fileName: string,
    contentType?: string,
  ) {
    if (!fileName?.trim()) {
      throw new BadRequestException('fileName is required');
    }

    if (contentType && !ALLOWED_RECEIPT_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException(
        `Unsupported contentType. Allowed: ${[
          ...ALLOWED_RECEIPT_CONTENT_TYPES,
        ].join(', ')}`,
      );
    }

    const safeName = this.sanitizeFileName(fileName);
    const objectPath = `receipts/${userId}/${randomUUID()}_${safeName}`;

    // Bind a max content-length into the signature. The client must echo this
    // exact header on the PUT; GCS then rejects any upload larger than the cap.
    const contentLengthRange = `0,${this.maxUploadBytes}`;

    try {
      const [signedUrl] = await withRetry(
        () =>
          withTimeout(
            this.bucket.file(objectPath).getSignedUrl({
              version: 'v4',
              action: 'write',
              expires: Date.now() + this.signedUrlTtlSeconds * 1000,
              contentType: contentType ?? 'image/jpeg',
              extensionHeaders: {
                'x-goog-content-length-range': contentLengthRange,
              },
            }),
            10_000,
            'createReceiptUploadUrl',
          ),
        { maxAttempts: 2, label: 'createReceiptUploadUrl' },
      );

      return {
        path: objectPath,
        signedUrl,
        expiresIn: this.signedUrlTtlSeconds,
        maxUploadBytes: this.maxUploadBytes,
        requiredHeaders: {
          'x-goog-content-length-range': contentLengthRange,
        },
      };
    } catch (e: unknown) {
      throw new BadRequestException(
        errorMessage(e, 'Failed to create signed upload URL'),
      );
    }
  }

  async createReceiptDownloadUrl(paymentId: string, user: CurrentUser) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        enrollment: {
          include: {
            child: { include: { parent: true } },
            school: true,
          },
        },
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (!payment.receiptUrl) {
      throw new NotFoundException('Receipt not available');
    }

    const receiptPath: string = payment.receiptUrl;

    const isParent =
      user.role === UserRole.PARENT &&
      payment.enrollment?.child?.parent?.userId === user.userId;
    const isSchoolOwner =
      user.role === UserRole.SCHOOL_OWNER &&
      payment.enrollment?.school?.ownerId === user.userId;
    const isAdmin = user.role === UserRole.SUPER_ADMIN;

    if (!isParent && !isSchoolOwner && !isAdmin) {
      throw new ForbiddenException('Not authorized to access this receipt');
    }

    try {
      const [signedUrl] = await withRetry(
        () =>
          withTimeout(
            this.bucket.file(receiptPath).getSignedUrl({
              version: 'v4',
              action: 'read',
              expires: Date.now() + this.signedUrlTtlSeconds * 1000,
            }),
            10_000,
            'createReceiptDownloadUrl',
          ),
        { maxAttempts: 2, label: 'createReceiptDownloadUrl' },
      );

      return {
        path: receiptPath,
        signedUrl,
        expiresIn: this.signedUrlTtlSeconds,
      };
    } catch (e: unknown) {
      throw new BadRequestException(
        errorMessage(e, 'Failed to create signed download URL'),
      );
    }
  }

  async createSignedUrlForPath(path: string) {
    if (!path?.trim()) {
      throw new BadRequestException('Path is required');
    }

    try {
      const [signedUrl] = await withRetry(
        () =>
          withTimeout(
            this.bucket.file(path).getSignedUrl({
              version: 'v4',
              action: 'read',
              expires: Date.now() + this.signedUrlTtlSeconds * 1000,
            }),
            10_000,
            'createSignedUrlForPath',
          ),
        { maxAttempts: 2, label: 'createSignedUrlForPath' },
      );

      return {
        signedUrl,
        expiresIn: this.signedUrlTtlSeconds,
      };
    } catch (e: unknown) {
      throw new BadRequestException(
        errorMessage(e, 'Failed to create signed download URL'),
      );
    }
  }

  private sanitizeFileName(fileName: string) {
    const base = path.basename(fileName);
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'receipt';
  }
}
