import { Reflector } from '@nestjs/core';
import { UserRole } from '../generated/prisma/client';
import {
  EnrollmentInvitesController,
  INVITE_TOKEN_HEADER,
} from './enrollment-invites.controller';
import { ROLES_KEY } from '../auth/roles.decorator';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import type { AuthUser } from '../common/types/auth-user';

const OWNER: AuthUser = {
  userId: 'owner-1',
  role: UserRole.SCHOOL_OWNER,
  schoolId: 'school-1',
};
const PARENT: AuthUser = { userId: 'parent-1', role: UserRole.PARENT };

/**
 * The controller is a delegating shell, so these assert the two things a shell
 * can still get wrong: where each argument comes from, and what the route's
 * metadata says about who may reach it. The second matters most — a missing
 * `@Roles` or a stray `@Public()` is invisible in a service test and is exactly
 * the kind of mistake that ships.
 */
describe('EnrollmentInvitesController', () => {
  const service = {
    create: jest.fn().mockResolvedValue('created'),
    list: jest.fn().mockResolvedValue('listed'),
    revoke: jest.fn().mockResolvedValue('revoked'),
    amend: jest.fn().mockResolvedValue('amended'),
    preview: jest.fn().mockResolvedValue('previewed'),
    claim: jest.fn().mockResolvedValue('claimed'),
    dispute: jest.fn().mockResolvedValue('disputed'),
  };
  const controller = new EnrollmentInvitesController(service as never);
  const reflector = new Reflector();

  beforeEach(() => jest.clearAllMocks());

  describe('delegation', () => {
    it('passes the creating owner through from the session, never the body', async () => {
      const dto = { studentName: 'Ada' } as never;
      await expect(controller.create(dto, OWNER)).resolves.toBe('created');
      expect(service.create).toHaveBeenCalledWith(dto, OWNER);
    });

    it('reads the preview token from a header, not the query string', async () => {
      await expect(controller.preview('raw-token')).resolves.toBe('previewed');
      expect(service.preview).toHaveBeenCalledWith('raw-token');
      expect(INVITE_TOKEN_HEADER).toBe('x-invite-token');
    });

    it('reads the claim token from the body', async () => {
      await expect(
        controller.claim({ token: 'raw-token' } as never, PARENT),
      ).resolves.toBe('claimed');
      expect(service.claim).toHaveBeenCalledWith('raw-token', PARENT);
    });

    it('passes the dispute reason alongside the token', async () => {
      await controller.dispute(
        { token: 'raw-token', reason: 'wrong amount' } as never,
        PARENT,
      );
      expect(service.dispute).toHaveBeenCalledWith(
        'raw-token',
        PARENT,
        'wrong amount',
      );
    });

    it('forwards an optional revoke reason', async () => {
      await controller.revoke('invite-1', { reason: 'typo' }, OWNER);
      expect(service.revoke).toHaveBeenCalledWith('invite-1', OWNER, 'typo');
    });

    it('forwards the amend dto whole', async () => {
      const dto = { amountAlreadyPaid: 35_000, reason: 'statement' };
      await controller.amend('invite-1', dto, OWNER);
      expect(service.amend).toHaveBeenCalledWith('invite-1', dto, OWNER);
    });

    it('passes list filters through for server-side clamping', async () => {
      await controller.list({ limit: 9_999 }, OWNER);
      expect(service.list).toHaveBeenCalledWith(OWNER, { limit: 9_999 });
    });
  });

  describe('route metadata', () => {
    const rolesOn = (method: keyof EnrollmentInvitesController) =>
      reflector.get<UserRole[]>(
        ROLES_KEY,
        EnrollmentInvitesController.prototype[method],
      );
    const isPublic = (method: keyof EnrollmentInvitesController) =>
      reflector.get<boolean>(
        IS_PUBLIC_KEY,
        EnrollmentInvitesController.prototype[method],
      );

    it.each(['create', 'list', 'revoke', 'amend'] as const)(
      'restricts %s to school owners',
      (method) => {
        expect(rolesOn(method)).toEqual([UserRole.SCHOOL_OWNER]);
      },
    );

    it('leaves claim and dispute open to any authenticated user', () => {
      // Deliberate: a school owner may be a parent at another school, and
      // gating on UserRole.PARENT would lock them out of their own child's
      // plan. Authorisation is the phone match inside the service.
      expect(rolesOn('claim')).toBeUndefined();
      expect(rolesOn('dispute')).toBeUndefined();
    });

    it('exposes only the preview route publicly', () => {
      expect(isPublic('preview')).toBe(true);
      for (const method of [
        'create',
        'list',
        'revoke',
        'amend',
        'claim',
        'dispute',
      ] as const) {
        expect(isPublic(method)).toBeUndefined();
      }
    });
  });
});
