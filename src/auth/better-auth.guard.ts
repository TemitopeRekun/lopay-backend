import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'http';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import type { AuthUser } from '../common/types/auth-user';
import { UserRole } from '../generated/prisma/client';

/**
 * Global authentication guard backed by Better Auth.
 *
 * Drop-in replacement for the old JwtAuthGuard: it honors the existing
 * `@Public()` decorator and populates `request.user` with the SAME shape the
 * codebase already expects — `{ userId, role, schoolId }` — so every
 * `@CurrentUser()` consumer and the `RolesGuard` keep working unchanged.
 *
 * The session token arrives as `Authorization: Bearer <token>` (Better Auth
 * bearer plugin); `role` and `schoolId` are attached by the customSession plugin.
 */
@Injectable()
export class BetterAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<{
      headers: IncomingHttpHeaders;
      user?: AuthUser;
      session?: unknown;
    }>();
    const session = await this.authService.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!session) {
      throw new UnauthorizedException();
    }

    const user = session.user as {
      id: string;
      role?: UserRole;
      schoolId?: string | null;
    };
    request.user = {
      userId: user.id,
      role: user.role ?? UserRole.PARENT,
      schoolId: user.schoolId ?? null,
    };
    request.session = session;
    return true;
  }
}
