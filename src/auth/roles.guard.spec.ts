import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { UserRole } from '../generated/prisma/client';

function context(user: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const makeGuard = (required: string[] | undefined) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(required),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  };

  it('allows the request when no roles are required (unguarded route)', () => {
    const guard = makeGuard(undefined);
    expect(guard.canActivate(context(undefined))).toBe(true);
  });

  it('allows a user whose role is in the required set', () => {
    const guard = makeGuard([UserRole.SCHOOL_OWNER]);
    expect(guard.canActivate(context({ role: UserRole.SCHOOL_OWNER }))).toBe(
      true,
    );
  });

  it('denies (403) when no authenticated user is present', () => {
    const guard = makeGuard([UserRole.SUPER_ADMIN]);
    expect(() => guard.canActivate(context(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('denies (403) a user whose role is not in the required set', () => {
    const guard = makeGuard([UserRole.SUPER_ADMIN]);
    expect(() => guard.canActivate(context({ role: UserRole.PARENT }))).toThrow(
      ForbiddenException,
    );
  });
});
