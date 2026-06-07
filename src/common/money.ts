/**
 * Money value object — all arithmetic in integer kobo (1 Naira = 100 kobo).
 * Eliminates floating-point precision loss when multiplying or rounding Naira
 * values into integer DB columns.
 *
 * Convention:
 *   DB Int columns store kobo.
 *   DTOs accept/return Naira (user-facing).
 *   Service layer converts at the boundary using this class.
 */
export class Money {
  private constructor(private readonly _kobo: number) {
    if (!Number.isInteger(_kobo)) {
      throw new Error(`Money requires integer kobo, got ${_kobo}`);
    }
  }

  /** From a user-supplied Naira amount (e.g. DTO field). Rounds half-up. */
  static fromNaira(naira: number): Money {
    return new Money(Math.round(naira * 100));
  }

  /** From a stored kobo integer (e.g. DB column). */
  static fromKobo(kobo: number): Money {
    return new Money(Math.round(kobo)); // Math.round handles any accidental float
  }

  toKobo(): number {
    return this._kobo;
  }

  /** Divide by 100 for API responses / display. May have .xx decimal. */
  toNaira(): number {
    return this._kobo / 100;
  }

  add(other: Money): Money {
    return new Money(this._kobo + other._kobo);
  }

  subtract(other: Money): Money {
    return new Money(this._kobo - other._kobo);
  }

  /** Multiply by a percentage rate (e.g. 0.025 for 2.5%). Rounds half-up. */
  percent(rate: number): Money {
    return new Money(Math.round(this._kobo * rate));
  }

  isLessThan(other: Money): boolean {
    return this._kobo < other._kobo;
  }

  /** ₦1,187.50 — for notification messages. */
  formatNaira(): string {
    return `₦${this.toNaira().toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
