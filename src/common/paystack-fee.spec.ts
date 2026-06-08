import {
  paystackFee,
  grossUp,
  PAYSTACK_FLAT_KOBO,
  PAYSTACK_FEE_CAP_KOBO,
  PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO,
} from './paystack-fee';

describe('paystackFee (forward)', () => {
  it('waives the flat fee below ₦2,500', () => {
    // ₦1,000 charged → 1.5% = ₦15, no flat
    expect(paystackFee(1_000_00)).toBe(15_00);
  });

  it('applies the flat fee at/above ₦2,500', () => {
    // ₦3,000 → round(1.5%*300000)=4500 + 10000 flat = 14500
    expect(paystackFee(3_000_00)).toBe(4_500 + PAYSTACK_FLAT_KOBO);
  });

  it('caps the fee at ₦2,000', () => {
    // ₦1,000,000 → 1.5% = ₦15,000 + ₦100 = ₦15,100 → capped at ₦2,000
    expect(paystackFee(1_000_000_00)).toBe(PAYSTACK_FEE_CAP_KOBO);
  });

  it('is exactly at the waiver boundary', () => {
    const justBelow = PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO - 1;
    expect(paystackFee(justBelow)).toBe(Math.round(justBelow * 0.015)); // no flat
    expect(paystackFee(PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO)).toBe(
      Math.round(PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO * 0.015) + PAYSTACK_FLAT_KOBO,
    );
  });
});

describe('grossUp (inverse) — exact net identity', () => {
  // The core invariant: amountCharged − fee == base, to the kobo.
  const bases = [
    1_00, // ₦1 (region 1, tiny)
    50_000, // ₦500 (region 1)
    220_000, // ₦2,200 (region 1, near waiver)
    246_250, // boundary base where region flips
    2_750_000, // ₦27,500 (the ₦100k-fee minimum deposit — worked example)
    5_500_000, // ₦55,000 (region 2)
    55_000_000, // ₦550,000 (region 3, capped)
  ];

  it.each(bases)('nets base=%d exactly', (base) => {
    const { amountCharged, paystackFee: fee } = grossUp(base);
    expect(amountCharged - fee).toBe(base);
    expect(Number.isInteger(amountCharged)).toBe(true);
    expect(Number.isInteger(fee)).toBe(true);
    expect(amountCharged).toBeGreaterThanOrEqual(base);
  });

  it('matches the worked example (₦100,000 fee, 25% deposit)', () => {
    // base = deposit = ₦27,500 = 2,750,000 kobo
    const { amountCharged, paystackFee: fee } = grossUp(2_750_000);
    expect(amountCharged).toBe(2_802_030); // ₦28,020.30
    expect(fee).toBe(52_030); // ₦520.30
    expect(amountCharged - fee).toBe(2_750_000);
  });

  it('is consistent: fee(amountCharged) equals the returned fee', () => {
    for (const base of bases) {
      const { amountCharged, paystackFee: fee } = grossUp(base);
      expect(paystackFee(amountCharged)).toBe(fee);
    }
  });

  it('rejects non-positive or non-integer bases', () => {
    expect(() => grossUp(0)).toThrow();
    expect(() => grossUp(-100)).toThrow();
    expect(() => grossUp(100.5)).toThrow();
  });
});
