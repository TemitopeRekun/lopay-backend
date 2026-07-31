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
import { SUPABASE_CLIENT } from '../supabase/supabase.module';
import type { SupabaseClient } from '@supabase/supabase-js';
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
const DEFAULT_DOWNLOAD_TTL_SECONDS = 600;
// Supabase signed *upload* URLs have a fixed ~2h validity (not configurable),
// unlike download URLs whose TTL we set per request.
const UPLOAD_URL_TTL_SECONDS = 7200;

/** Supabase storage calls resolve `{ data, error }` rather than throwing. */
type SupabaseResult<T> = { data: T | null; error: { message?: string } | null };

@Injectable()
export class DocumentsService {
  private readonly signedUrlTtlSeconds: number;
  private readonly maxUploadBytes: number;
  private readonly bucketName: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient | null,
  ) {
    const ttl = Number(
      this.config.get<string>('SUPABASE_SIGNED_URL_TTL_SECONDS') ??
        DEFAULT_DOWNLOAD_TTL_SECONDS,
    );
    this.signedUrlTtlSeconds = Number.isFinite(ttl)
      ? ttl
      : DEFAULT_DOWNLOAD_TTL_SECONDS;

    const maxBytes = Number(
      this.config.get<string>('SUPABASE_MAX_UPLOAD_BYTES') ??
        DEFAULT_MAX_UPLOAD_BYTES,
    );
    this.maxUploadBytes =
      Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : DEFAULT_MAX_UPLOAD_BYTES;

    this.bucketName =
      this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? 'receipts';
  }

  /** The storage bucket handle, or a clear error when Supabase isn't configured. */
  private bucket() {
    if (!this.supabase) {
      throw new BadRequestException('Receipt storage is not configured');
    }
    return this.supabase.storage.from(this.bucketName);
  }

  /**
   * Run a Supabase storage call (which resolves `{ data, error }` rather than
   * throwing) through a timeout + retry, unwrap it, and surface any failure as a
   * BadRequestException.
   */
  private async signed<T>(
    call: () => PromiseLike<SupabaseResult<T>>,
    label: string,
  ): Promise<T> {
    try {
      return await withRetry(
        () =>
          withTimeout(
            Promise.resolve(call()).then(({ data, error }) => {
              if (error) throw new Error(error.message ?? label);
              if (!data) throw new Error(`${label}: empty response`);
              return data;
            }),
            10_000,
            label,
          ),
        { maxAttempts: 2, label },
      );
    } catch (e: unknown) {
      throw new BadRequestException(errorMessage(e, `Failed to ${label}`));
    }
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

    const bucket = this.bucket();
    const safeName = this.sanitizeFileName(fileName);
    const objectPath = `receipts/${userId}/${randomUUID()}_${safeName}`;

    const data = await this.signed<{ signedUrl: string; token: string }>(
      () => bucket.createSignedUploadUrl(objectPath),
      'create the upload URL',
    );

    // The client uploads via `uploadToSignedUrl(path, token, file)` (or a PUT to
    // signedUrl). Max size + allowed MIME types are enforced by the bucket's own
    // config; maxUploadBytes is returned so the client can pre-validate. Persist
    // `path` as the payment's receiptUrl.
    return {
      path: objectPath,
      signedUrl: data.signedUrl,
      token: data.token,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      maxUploadBytes: this.maxUploadBytes,
    };
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

    const bucket = this.bucket();
    const data = await this.signed<{ signedUrl: string }>(
      () => bucket.createSignedUrl(receiptPath, this.signedUrlTtlSeconds),
      'create the download URL',
    );

    return {
      path: receiptPath,
      signedUrl: data.signedUrl,
      expiresIn: this.signedUrlTtlSeconds,
    };
  }

  async createSignedUrlForPath(filePath: string) {
    if (!filePath?.trim()) {
      throw new BadRequestException('Path is required');
    }

    const bucket = this.bucket();
    const data = await this.signed<{ signedUrl: string }>(
      () => bucket.createSignedUrl(filePath, this.signedUrlTtlSeconds),
      'create the download URL',
    );

    return {
      signedUrl: data.signedUrl,
      expiresIn: this.signedUrlTtlSeconds,
    };
  }

  private sanitizeFileName(fileName: string) {
    const base = path.basename(fileName);
    const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'receipt';
  }
}
