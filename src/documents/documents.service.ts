import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '../generated/prisma/client';

const ALLOWED_RECEIPT_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
]);

type CurrentUser = {
  userId: string;
  role: UserRole;
  schoolId?: string | null;
};

@Injectable()
export class DocumentsService {
  private readonly supabase: SupabaseClient;
  private readonly bucket: string;
  private readonly signedUrlTtlSeconds: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const url = this.config.get<string>('SUPABASE_URL');
    const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    }

    this.supabase = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    this.bucket = this.config.get<string>('SUPABASE_STORAGE_BUCKET') ?? 'lopay';
    const ttl = Number(
      this.config.get<string>('SUPABASE_SIGNED_URL_TTL_SECONDS') ?? 600,
    );
    this.signedUrlTtlSeconds = Number.isFinite(ttl) ? ttl : 600;
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

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUploadUrl(objectPath, { upsert: false });

    if (error || !data?.signedUrl) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create signed upload URL',
      );
    }

    return {
      path: data.path ?? objectPath,
      signedUrl: data.signedUrl,
      token: data.token ?? null,
      expiresIn: this.signedUrlTtlSeconds,
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

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUrl(payment.receiptUrl, this.signedUrlTtlSeconds);

    if (error || !data?.signedUrl) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create signed download URL',
      );
    }

    return {
      path: payment.receiptUrl,
      signedUrl: data.signedUrl,
      expiresIn: this.signedUrlTtlSeconds,
    };
  }

  async createSignedUrlForPath(path: string) {
    if (!path?.trim()) {
      throw new BadRequestException('Path is required');
    }

    const { data, error } = await this.supabase.storage
      .from(this.bucket)
      .createSignedUrl(path, this.signedUrlTtlSeconds);

    if (error || !data?.signedUrl) {
      throw new BadRequestException(
        error?.message ?? 'Failed to create signed download URL',
      );
    }

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
