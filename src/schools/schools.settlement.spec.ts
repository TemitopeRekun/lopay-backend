import { BadRequestException } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import { PaymentType } from '../generated/prisma/client';

/**
 * Keeping the two settlement destinations in step.
 *
 * A school has two places money can land: the bank account we show parents for
 * INSTALLMENTS, and the Paystack subaccount that FIRST-PAYMENT splits settle into.
 * Editing bank details used to move only the first, so card money kept arriving in
 * an account the school may no longer control — with nothing in the product to
 * reveal the divergence.
 */
describe('SchoolPaymentsService — settlement changes', () => {
  const SCHOOL_ID = 'school-1';

  let prisma: {
    school: { findUnique: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
    user: { findMany: jest.Mock };
    payment: { findMany: jest.Mock };
    withTenant: jest.Mock;
  };
  let notifications: { create: jest.Mock };
  let paystack: { resolveAccount: jest.Mock; updateSubaccount: jest.Mock };
  let service: SchoolPaymentsService;

  const existing: {
    id: string;
    name: string;
    bankCode: string | null;
    accountNumber: string;
    accountName: string;
    bankName: string;
    paystackSubaccountCode: string | null;
  } = {
    id: SCHOOL_ID,
    name: 'Acme School',
    bankCode: '058',
    accountNumber: '0001112223',
    accountName: 'ACME SCHOOLS LTD',
    bankName: 'GTBank',
    paystackSubaccountCode: 'ACCT_old',
  };

  const build = (school: Partial<typeof existing> = {}) => {
    const merged = { ...existing, ...school };
    prisma.school.findUnique.mockResolvedValue(merged);
    prisma.school.findFirst.mockResolvedValue(merged);
    prisma.school.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...merged, ...data }),
    );
    return merged;
  };

  beforeEach(() => {
    prisma = {
      school: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([{ id: 'admin-1' }]),
      },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
      withTenant: jest.fn(),
    };
    prisma.withTenant.mockReturnValue(prisma);
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    paystack = {
      resolveAccount: jest
        .fn()
        .mockResolvedValue({ accountName: 'ACME SCHOOLS LIMITED' }),
      updateSubaccount: jest.fn().mockResolvedValue(undefined),
    };

    service = new SchoolPaymentsService(
      prisma as never,
      notifications as never,
      {} as never, // documents
      {} as never, // events
      {} as never, // audit
      {} as never, // ledger
      {} as never, // onboarding
      {} as never, // cache
      paystack as never,
    );
  });

  describe('when the settlement account is unchanged', () => {
    it('touches Paystack for nothing (a rename is not a settlement change)', async () => {
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        bankName: 'GTBank Plc',
      });

      expect(paystack.resolveAccount).not.toHaveBeenCalled();
      expect(paystack.updateSubaccount).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('when the settlement account changes', () => {
    it('verifies the new account with Paystack BEFORE persisting it', async () => {
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(paystack.resolveAccount).toHaveBeenCalledWith('9998887776', '057');
      const resolveOrder =
        paystack.resolveAccount.mock.invocationCallOrder[0] ?? 0;
      const updateOrder = prisma.school.update.mock.invocationCallOrder[0] ?? 0;
      expect(resolveOrder).toBeLessThan(updateOrder);
    });

    it('refuses to persist an account Paystack cannot resolve', async () => {
      build();
      paystack.resolveAccount.mockRejectedValue(
        new BadRequestException('Cannot resolve account'),
      );

      await expect(
        service.updateSchoolBankDetails(SCHOOL_ID, {
          accountNumber: '0000000000',
          bankCode: '057',
        }),
      ).rejects.toThrow('Cannot resolve account');

      expect(prisma.school.update).not.toHaveBeenCalled();
      expect(paystack.updateSubaccount).not.toHaveBeenCalled();
    });

    it('stores the bank’s registered name, not the submitted one', async () => {
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
        accountName: 'Whatever I Typed',
      });

      expect(prisma.school.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            accountName: 'ACME SCHOOLS LIMITED',
          }),
        }),
      );
    });

    it('deactivates online payments in the SAME write as the new details', async () => {
      // The crash case: if the details were saved first and the flag only cleared
      // in a catch block, a restart mid-request would leave the new account on
      // display while card money kept settling to the OLD one.
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(prisma.school.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            accountNumber: '9998887776',
            paystackSubaccountActive: false,
          }),
        }),
      );
    });

    it('restores online payments only after Paystack confirms the new destination', async () => {
      build();

      const result = await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      const repointOrder =
        paystack.updateSubaccount.mock.invocationCallOrder[0] ?? 0;
      const reactivateOrder =
        prisma.school.update.mock.invocationCallOrder[1] ?? 0;
      expect(repointOrder).toBeLessThan(reactivateOrder);
      expect(prisma.school.update).toHaveBeenLastCalledWith({
        where: { id: SCHOOL_ID },
        data: { paystackSubaccountActive: true },
      });
      expect(result).toEqual(
        expect.objectContaining({ paystackSubaccountActive: true }),
      );
    });

    it('does not touch the active flag when there is no subaccount to re-point', async () => {
      build({ paystackSubaccountCode: null });

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      const [{ data }] = prisma.school.update.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(data).not.toHaveProperty('paystackSubaccountActive');
      expect(prisma.school.update).toHaveBeenCalledTimes(1);
    });

    it('re-points the Paystack subaccount at the new account', async () => {
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(paystack.updateSubaccount).toHaveBeenCalledWith('ACCT_old', {
        businessName: 'Acme School',
        settlementBank: '057',
        accountNumber: '9998887776',
        percentageCharge: 0,
      });
    });

    it('requires a bank code — it is what identifies the destination bank', async () => {
      build({ bankCode: null });

      await expect(
        service.updateSchoolBankDetails(SCHOOL_ID, {
          accountNumber: '9998887776',
        }),
      ).rejects.toThrow(/bankCode is required/i);

      expect(prisma.school.update).not.toHaveBeenCalled();
    });

    it('alerts the admins — settlement redirection is the classic payment fraud', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'a1' }, { id: 'a2' }]);
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(notifications.create).toHaveBeenCalledTimes(2);
      const [alert] = notifications.create.mock.calls[0] as [
        { message: string },
      ];
      // Masked: the alert must be actionable without leaking the full account.
      expect(alert.message).toContain('7776');
      expect(alert.message).not.toContain('9998887776');
    });

    it('reuses the existing bank code when only the account number moves', async () => {
      build();

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
      });

      expect(paystack.resolveAccount).toHaveBeenCalledWith('9998887776', '058');
    });

    it('persists without a Paystack call when the school has no subaccount yet', async () => {
      build({ paystackSubaccountCode: null });

      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(prisma.school.update).toHaveBeenCalled();
      expect(paystack.updateSubaccount).not.toHaveBeenCalled();
    });
  });

  describe('when re-pointing the subaccount fails', () => {
    beforeEach(() => {
      build();
      paystack.updateSubaccount.mockRejectedValue(new Error('Paystack down'));
    });

    it('fails CLOSED: online payments are disabled rather than mis-settled', async () => {
      const result = await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(result).toEqual(
        expect.objectContaining({ paystackSubaccountActive: false }),
      );
      // No second write is needed: the flag went false in the SAME write as the
      // details, so there is no window in which they disagree.
      expect(prisma.school.update).toHaveBeenCalledTimes(1);
    });

    it('tells the admins the subaccount is out of sync', async () => {
      await service.updateSchoolBankDetails(SCHOOL_ID, {
        accountNumber: '9998887776',
        bankCode: '057',
      });

      const titles = notifications.create.mock.calls.map(
        ([n]: [{ title: string }]) => n.title,
      );
      expect(titles).toContain('Paystack subaccount out of sync');
    });

    it('does not throw — the new details are already saved and correct', async () => {
      await expect(
        service.updateSchoolBankDetails(SCHOOL_ID, {
          accountNumber: '9998887776',
          bankCode: '057',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('updateSchool (admin path)', () => {
    it('runs the same settlement sync, not a bare column write', async () => {
      build();

      await service.updateSchool(SCHOOL_ID, {
        schoolName: 'Acme School v2',
        accountNumber: '9998887776',
        bankCode: '057',
      });

      expect(paystack.resolveAccount).toHaveBeenCalled();
      expect(paystack.updateSubaccount).toHaveBeenCalled();
    });
  });

  describe('getPendingPayments', () => {
    it('never offers a card first payment as an owner approval', async () => {
      await service.getPendingPayments(SCHOOL_ID, false, 'ALL', 100, 'ALL');

      expect(prisma.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            NOT: {
              paymentType: PaymentType.FIRST_PAYMENT,
              paystackReference: { not: null },
            },
          }),
        }),
      );
    });
  });
});
