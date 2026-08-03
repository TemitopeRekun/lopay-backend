import {
  paystackFee,
  paystackFeeBeforeVat,
  paystackVatRate,
  grossUp,
  PAYSTACK_FLAT_KOBO,
  PAYSTACK_FEE_CAP_KOBO,
  PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO,
  DEFAULT_PAYSTACK_VAT_RATE,
} from './paystack-fee';

/** Every case is run against an explicit VAT rate so no test depends on env. */
const NO_VAT = 0;

describe('paystackFeeBeforeVat (processing fee)', () => {
  it('waives the flat fee below ₦2,500', () => {
    // ₦1,000 charged → 1.5% = ₦15, no flat
    expect(paystackFeeBeforeVat(1_000_00)).toBe(15_00);
  });

  it('applies the flat fee at/above ₦2,500', () => {
    // ₦3,000 → round(1.5%*300000)=4500 + 10000 flat = 14500
    expect(paystackFeeBeforeVat(3_000_00)).toBe(4_500 + PAYSTACK_FLAT_KOBO);
  });

  it('caps the processing fee at ₦2,000', () => {
    // ₦1,000,000 → 1.5% = ₦15,000 + ₦100 = ₦15,100 → capped at ₦2,000
    expect(paystackFeeBeforeVat(1_000_000_00)).toBe(PAYSTACK_FEE_CAP_KOBO);
  });

  it('is exactly at the waiver boundary', () => {
    const justBelow = PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO - 1;
    expect(paystackFeeBeforeVat(justBelow)).toBe(Math.round(justBelow * 0.015));
    expect(paystackFeeBeforeVat(PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO)).toBe(
      Math.round(PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO * 0.015) +
        PAYSTACK_FLAT_KOBO,
    );
  });
});

describe('paystackFee (processing fee + VAT)', () => {
  it('equals the processing fee when VAT is disabled', () => {
    expect(paystackFee(1_000_00, NO_VAT)).toBe(15_00);
    expect(paystackFee(3_000_00, NO_VAT)).toBe(4_500 + PAYSTACK_FLAT_KOBO);
  });

  it('adds VAT on top of the processing fee', () => {
    // ₦3,000 → processing 14,500 kobo → +7.5% VAT = 1,088 (rounded) → 15,588
    const processing = 4_500 + PAYSTACK_FLAT_KOBO;
    expect(paystackFee(3_000_00, 0.075)).toBe(
      processing + Math.round(processing * 0.075),
    );
  });

  it('applies VAT to the CAPPED processing fee, not the uncapped one', () => {
    // The cap bounds Paystack's fee; VAT is then charged on that capped figure.
    expect(paystackFee(1_000_000_00, 0.075)).toBe(
      PAYSTACK_FEE_CAP_KOBO + Math.round(PAYSTACK_FEE_CAP_KOBO * 0.075),
    );
  });

  it('is a strictly larger fee than the VAT-free model (the under-recovery)', () => {
    // This gap is what the platform was silently absorbing on every first payment.
    expect(paystackFee(100_000_00, 0.075)).toBeGreaterThan(
      paystackFee(100_000_00, NO_VAT),
    );
  });
});

describe('paystackVatRate (env-driven)', () => {
  const ORIGINAL = process.env.PAYSTACK_FEE_VAT_RATE;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.PAYSTACK_FEE_VAT_RATE;
    else process.env.PAYSTACK_FEE_VAT_RATE = ORIGINAL;
  });

  it('defaults to Nigeria’s 7.5% when unset', () => {
    delete process.env.PAYSTACK_FEE_VAT_RATE;
    expect(paystackVatRate()).toBe(DEFAULT_PAYSTACK_VAT_RATE);
  });

  it('honours an explicit 0 (VAT-inclusive pricing)', () => {
    process.env.PAYSTACK_FEE_VAT_RATE = '0';
    expect(paystackVatRate()).toBe(0);
  });

  it('honours a custom rate', () => {
    process.env.PAYSTACK_FEE_VAT_RATE = '0.05';
    expect(paystackVatRate()).toBe(0.05);
  });

  it.each(['', '   ', 'abc', '-0.1', '2', 'NaN'])(
    'falls back to the default for the invalid value %p rather than mispricing',
    (value) => {
      process.env.PAYSTACK_FEE_VAT_RATE = value;
      expect(paystackVatRate()).toBe(DEFAULT_PAYSTACK_VAT_RATE);
    },
  );

  it('is read per call, so a deploy-time change needs no rebuild', () => {
    process.env.PAYSTACK_FEE_VAT_RATE = '0';
    expect(paystackVatRate()).toBe(0);
    process.env.PAYSTACK_FEE_VAT_RATE = '0.075';
    expect(paystackVatRate()).toBe(0.075);
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

  describe.each([
    ['VAT off', NO_VAT],
    ['VAT 7.5%', 0.075],
  ])('%s', (_label, vat) => {
    it.each(bases)('nets base=%d exactly', (base) => {
      const { amountCharged, paystackFee: fee } = grossUp(base, vat);
      expect(amountCharged - fee).toBe(base);
      expect(Number.isInteger(amountCharged)).toBe(true);
      expect(Number.isInteger(fee)).toBe(true);
      expect(amountCharged).toBeGreaterThanOrEqual(base);
    });

    it('is consistent: fee(amountCharged) equals the returned fee', () => {
      for (const base of bases) {
        const { amountCharged, paystackFee: fee } = grossUp(base, vat);
        expect(paystackFee(amountCharged, vat)).toBe(fee);
      }
    });

    it('holds the identity across the whole waiver boundary, kobo by kobo', () => {
      // The fee jumps by the flat component here, which is exactly where an
      // off-by-one in the region selection would hide.
      for (
        let base = PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO - 5_000;
        base <= PAYSTACK_FLAT_WAIVER_THRESHOLD_KOBO + 5_000;
        base += 137 // a prime-ish step: hits varied rounding residues cheaply
      ) {
        const { amountCharged, paystackFee: fee } = grossUp(base, vat);
        expect(amountCharged - fee).toBe(base);
      }
    });

    it('holds the identity across the fee cap boundary', () => {
      const capBase = 130_000_00; // charged amounts here straddle the ₦2,000 cap
      for (let base = capBase - 3_000; base <= capBase + 3_000; base += 211) {
        const { amountCharged, paystackFee: fee } = grossUp(base, vat);
        expect(amountCharged - fee).toBe(base);
      }
    });
  });

  // Regression: `net(a) = a - fee(a)` is a step function and, once VAT rounds on
  // top of the percentage rounding, it is NOT monotonic — one extra kobo can raise
  // the fee by 2 and lower the net (a=433 net=427, a=434 net=426 at 7.5%). A linear
  // estimate plus a decrement-only correction could not cross that step and threw
  // for ~1 base in 800 — a 500 on payment initiation. Sampled bases missed it, so
  // this sweep is deliberately CONTIGUOUS.
  describe.each([
    ['VAT off', NO_VAT],
    ['VAT 5%', 0.05],
    ['VAT 7.5%', 0.075],
  ])('%s — every base in a contiguous range is solvable', (_label, vat) => {
    it('never throws and never nets less than the base', () => {
      const failures: Array<{ base: number; reason: string }> = [];
      for (let base = 1; base <= 20_000; base += 1) {
        try {
          const { amountCharged, paystackFee: fee } = grossUp(base, vat);
          const net = amountCharged - fee;
          if (net < base) failures.push({ base, reason: `net ${net} < base` });
          if (fee !== paystackFee(amountCharged, vat)) {
            failures.push({ base, reason: 'fee disagrees with forward fee' });
          }
        } catch (err) {
          failures.push({ base, reason: (err as Error).message });
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });

    it('nets EXACTLY, for every base in the range', () => {
      const inexact: number[] = [];
      for (let base = 1; base <= 20_000; base += 1) {
        const { amountCharged, paystackFee: fee } = grossUp(base, vat);
        if (amountCharged - fee !== base) inexact.push(base);
      }
      expect(inexact.slice(0, 5)).toEqual([]);
    });
  });

  it('solves the exact bases the previous implementation threw on', () => {
    // Captured from an exhaustive sweep of the old code.
    for (const base of [427, 1279, 1280, 1281, 3050, 3903, 5674, 6527]) {
      const { amountCharged, paystackFee: fee } = grossUp(base, 0.075);
      expect(amountCharged - fee).toBe(base);
    }
    for (const base of [624, 1936, 1937, 3248, 3249, 4561, 5873]) {
      const { amountCharged, paystackFee: fee } = grossUp(base, 0.05);
      expect(amountCharged - fee).toBe(base);
    }
  });

  it('charges the SMALLEST amount that nets the base (cheapest for the parent)', () => {
    const { amountCharged } = grossUp(427, 0.075);
    // 433 and 435 both net 427; the parent must be charged 433.
    expect(amountCharged).toBe(433);
    expect(amountCharged - paystackFee(amountCharged, 0.075)).toBe(427);
  });

  it('matches the worked example with VAT off (₦100,000 fee, 25% deposit)', () => {
    // base = deposit = ₦27,500 = 2,750,000 kobo
    const { amountCharged, paystackFee: fee } = grossUp(2_750_000, NO_VAT);
    expect(amountCharged).toBe(2_802_030); // ₦28,020.30
    expect(fee).toBe(52_030); // ₦520.30
    expect(amountCharged - fee).toBe(2_750_000);
  });

  it('charges the parent MORE once VAT is modelled, protecting the platform cut', () => {
    const withoutVat = grossUp(2_750_000, NO_VAT);
    const withVat = grossUp(2_750_000, 0.075);
    expect(withVat.amountCharged).toBeGreaterThan(withoutVat.amountCharged);
    // The extra covers at least the VAT on the old processing fee — the amount the
    // platform main account used to eat, once per first payment. It is slightly
    // more than that, because grossing up raises the charged amount and the 1.5%
    // is then taken on the larger figure.
    const vatOnOldFee = Math.round(withoutVat.paystackFee * 0.075);
    expect(withVat.paystackFee - withoutVat.paystackFee).toBeGreaterThanOrEqual(
      vatOnOldFee,
    );
    // Whatever the fee turns out to be, the school + platform still net exactly.
    expect(withVat.amountCharged - withVat.paystackFee).toBe(2_750_000);
  });

  it('rejects non-positive or non-integer bases', () => {
    expect(() => grossUp(0)).toThrow();
    expect(() => grossUp(-100)).toThrow();
    expect(() => grossUp(100.5)).toThrow();
  });

  // The two fallback paths, forced with a zero-width window so only the linear seed
  // is considered. At the real window neither is reachable (see the contiguous
  // sweeps above) — these exist so the guards are known to behave, not to pad
  // coverage.
  describe('fallback behaviour when the search window contains no exact solution', () => {
    it('never nets LESS than the base: takes the smallest surplus instead', () => {
      // base 200 @ no VAT: the seed (204) nets 201 — one kobo over.
      const { amountCharged, paystackFee: fee } = grossUp(200, NO_VAT, 0);
      expect(amountCharged).toBe(204);
      expect(amountCharged - fee).toBeGreaterThan(200);
      // A surplus lands with the school, never a deficit against it.
      expect(amountCharged - fee).toBe(201);
    });

    it('throws rather than charging an amount that nets too little', () => {
      // base 427 @ 7.5% VAT: the seed (434) nets 426 — one kobo short, and with no
      // window there is nowhere to look. Charging it would shortchange the school.
      expect(() => grossUp(427, 0.075, 0)).toThrow(/no charge that nets/i);
    });

    it('finds the exact solution once the window is opened', () => {
      const { amountCharged, paystackFee: fee } = grossUp(427, 0.075, 8);
      expect(amountCharged - fee).toBe(427);
    });
  });
});
