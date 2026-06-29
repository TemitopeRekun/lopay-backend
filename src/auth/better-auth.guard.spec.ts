// better-auth ships ESM that ts-jest doesn't transform; stub the only helper used.
jest.mock('better-auth/node', () => ({
  fromNodeHeaders: (headers: unknown) => headers,
}));

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BetterAuthGuard } from './better-auth.guard';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { UserRole } from '../generated/prisma/client';

type Req = {
  headers?: Record<string, unknown>;
  user?: unknown;
  session?: unknown;
};

function context(req: Req): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

describe('BetterAuthGuard', () => {
  const makeGuard = (opts: { isPublic?: boolean; session?: unknown }) => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(opts.isPublic ?? false),
    } as unknown as Reflector;
    const getSession = jest.fn().mockResolvedValue(opts.session ?? null);
    const authService = { api: { getSession } } as unknown as AuthService;
    return { guard: new BetterAuthGuard(reflector, authService), getSession };
  };

  it('allows public routes without a session lookup', async () => {
    const { guard, getSession } = makeGuard({ isPublic: true });
    await expect(guard.canActivate(context({}))).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('throws Unauthorized when there is no session', async () => {
    const { guard } = makeGuard({ isPublic: false, session: null });
    await expect(guard.canActivate(context({ headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('populates request.user with the {userId, role, schoolId} shape', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      session: {
        user: { id: 'u1', role: UserRole.SCHOOL_OWNER, schoolId: 's1' },
      },
    });
    const req: Req = { headers: {} };
    await expect(guard.canActivate(context(req))).resolves.toBe(true);
    expect(req.user).toEqual({
      userId: 'u1',
      role: UserRole.SCHOOL_OWNER,
      schoolId: 's1',
    });
  });

  it('defaults role to PARENT and schoolId to null when the session omits them', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      session: { user: { id: 'u2' } },
    });
    const req: Req = { headers: {} };
    await guard.canActivate(context(req));
    expect(req.user).toEqual({
      userId: 'u2',
      role: UserRole.PARENT,
      schoolId: null,
    });
  });
});
