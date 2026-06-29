import { UserRole } from '../../generated/prisma/client';

/**
 * The authenticated principal attached to `request.user` by `BetterAuthGuard`
 * and surfaced to controllers via the `@CurrentUser()` decorator.
 *
 * Single source of truth for the shape — replaces the per-file `user: any`
 * annotations that used to proliferate across controllers.
 */
export interface AuthUser {
  userId: string;
  role: UserRole;
  schoolId?: string | null;
}
