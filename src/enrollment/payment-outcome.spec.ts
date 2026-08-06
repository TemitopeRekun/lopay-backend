import { derivePaymentOutcomeState } from './payment-outcome';

/**
 * The parent-facing verdict. The rule that matters is that `isConfirmed`, not
 * `status`, decides success — the same rule the whole ledger projection rests
 * on (see `toEnrollmentView`). Getting this wrong in either direction is a
 * money bug the parent acts on: telling someone their charge failed when the
 * bank debited them pushes them into paying twice.
 */
describe('derivePaymentOutcomeState', () => {
  it('treats a confirmed payment as succeeded regardless of status text', () => {
    for (const status of ['SUCCESS', 'PENDING', 'anything']) {
      expect(derivePaymentOutcomeState({ status, isConfirmed: true })).toBe(
        'succeeded',
      );
    }
  });

  /**
   * An installment sits at PENDING until a school owner approves it. That is a
   * healthy submission mid-flight, not a failure and not a success.
   */
  it('holds an unconfirmed PENDING payment as processing', () => {
    expect(
      derivePaymentOutcomeState({ status: 'PENDING', isConfirmed: false }),
    ).toBe('processing');
  });

  /**
   * A SUCCESS row that is not yet confirmed is still in flight as far as the
   * parent is concerned. Reporting it as done would claim money had settled on
   * the strength of a status column the ledger does not treat as authoritative.
   */
  it('does not call an unconfirmed SUCCESS row succeeded', () => {
    expect(
      derivePaymentOutcomeState({ status: 'SUCCESS', isConfirmed: false }),
    ).toBe('processing');
  });

  it('reports terminal states as failed', () => {
    for (const status of ['FAILED', 'REVERSED']) {
      expect(derivePaymentOutcomeState({ status, isConfirmed: false })).toBe(
        'failed',
      );
    }
  });

  /**
   * Fail SAFE on anything unrecognised. A status this function has never seen
   * must degrade to "we're checking", never to "your payment failed".
   */
  it('degrades an unknown status to processing, not failed', () => {
    expect(
      derivePaymentOutcomeState({
        status: 'SOME_NEW_STATE',
        isConfirmed: false,
      }),
    ).toBe('processing');
  });
});
