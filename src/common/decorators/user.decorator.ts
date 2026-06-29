import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from '../types/auth-user';

export type { AuthUser } from '../types/auth-user';

/**
 * Injects the authenticated principal populated by `BetterAuthGuard`.
 *
 * Returns the full {@link AuthUser} by default, or a single field when a key is
 * passed: `@CurrentUser('userId') userId: string`.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthUser }>();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);
