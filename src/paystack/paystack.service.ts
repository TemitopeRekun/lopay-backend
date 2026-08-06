import {
  Injectable,
  Logger,
  BadGatewayException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import CircuitBreaker from 'opossum';
import { errorMessage } from '../common/errors';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const REQUEST_TIMEOUT_MS = 15_000;

/** HTTP verbs this client issues against the Paystack REST API. */
type HttpMethod = 'GET' | 'POST' | 'PUT';

/** The `data` field of a Paystack `transaction/verify` response (fields we read). */
export interface PaystackVerifyData {
  status: string;
  reference: string;
  amount: number;
  fees?: number | null;
  /**
   * Paystack's human-readable outcome, e.g. "Successful",
   * "Insufficient funds", "Declined by financial institution". The only source
   * of WHY a charge failed — `status` alone is just "failed".
   */
  gateway_response?: string | null;
  subaccount?: { subaccount_code?: string } | null;
  metadata?: Record<string, unknown> | null;
}

/** A verified inbound Paystack webhook payload (only the fields we dispatch on). */
export interface PaystackWebhookEvent {
  event: string;
  data?: {
    id?: number | string;
    reference?: string;
    fees?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PaystackBank {
  name: string;
  code: string;
  currency: string;
}

export interface CreateSubaccountParams {
  businessName: string;
  settlementBank: string; // bank code, e.g. "058"
  accountNumber: string;
  percentageCharge?: number; // default 0 — we override per-transaction with transaction_charge
}

export interface InitializeTransactionParams {
  email: string;
  amountKobo: number;
  reference: string;
  subaccount: string;
  transactionChargeKobo: number; // flat to main account
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
}

export interface InitializeTransactionResult {
  authorizationUrl: string;
  accessCode: string;
  reference: string;
}

export interface VerifyTransactionResult {
  status: string; // "success" | "failed" | "abandoned" | ...
  reference: string;
  amount: number; // kobo
  fees: number | null; // kobo — authoritative Paystack fee
  /** Paystack's reason for the outcome; null when it sent none. */
  gatewayResponse: string | null;
  subaccount?: { subaccount_code?: string } | null;
  metadata?: Record<string, unknown> | null;
  raw: unknown;
}

/**
 * Thin wrapper over the Paystack REST API using the built-in fetch (Node 18+).
 * One retry on network/5xx errors with a short timeout — Paystack is a hard
 * dependency for first payments, so we fail loudly rather than silently.
 */
@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly secretKey: string;
  private banksCache: { at: number; banks: PaystackBank[] } | null = null;

  /**
   * Circuit breaker around the Paystack HTTP call (Milestone 4). When Paystack is
   * down, repeated transport/5xx failures OPEN the circuit so subsequent calls
   * fail fast (no thread/socket pile-up behind a dead dependency) until a 30s
   * cooldown lets a probe through. 4xx business errors are excluded via
   * `errorFilter` so a bad account number can't trip the breaker.
   */
  private readonly breaker: CircuitBreaker<
    [method: HttpMethod, path: string, body: unknown],
    unknown
  >;

  constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
    if (!this.secretKey) {
      this.logger.warn(
        'PAYSTACK_SECRET_KEY is empty — Paystack calls will fail until it is set.',
      );
    }

    this.breaker = new CircuitBreaker(
      (method: HttpMethod, path: string, body: unknown) =>
        this.doRequest(method, path, body),
      {
        name: 'paystack',
        // Our own per-attempt timeout + retry already bound latency; let the
        // wrapped call settle rather than racing a second (shorter) timeout.
        timeout: false,
        errorThresholdPercentage: 50,
        volumeThreshold: 5, // need a few calls before a percentage is meaningful
        resetTimeout: 30_000, // probe again 30s after opening
        // Don't count expected 4xx client/business errors as breaker failures.
        errorFilter: (err: unknown) => err instanceof BadGatewayException,
      },
    );
    this.breaker.on('open', () =>
      this.logger.error('Paystack circuit OPEN — failing fast for ~30s.'),
    );
    this.breaker.on('halfOpen', () =>
      this.logger.warn('Paystack circuit HALF-OPEN — probing.'),
    );
    this.breaker.on('close', () =>
      this.logger.log('Paystack circuit CLOSED — recovered.'),
    );
  }

  /** Create a subaccount for a school. Returns the subaccount_code. */
  async createSubaccount(params: CreateSubaccountParams): Promise<string> {
    const body = {
      business_name: params.businessName,
      settlement_bank: params.settlementBank,
      account_number: params.accountNumber,
      percentage_charge: params.percentageCharge ?? 0,
    };
    const data = await this.request<{ subaccount_code: string }>(
      'POST',
      '/subaccount',
      body,
    );
    return data.subaccount_code;
  }

  /**
   * Point an existing subaccount at a different settlement account.
   *
   * A school that edits its bank details in the app changes where INSTALLMENTS are
   * paid immediately (parents read those details from our DB), but first-payment
   * splits keep settling wherever the subaccount points. Without this call the two
   * destinations silently diverge and the school's card money lands in an account
   * it may no longer control.
   */
  async updateSubaccount(
    subaccountCode: string,
    params: CreateSubaccountParams,
  ): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/subaccount/${encodeURIComponent(subaccountCode)}`,
      {
        business_name: params.businessName,
        settlement_bank: params.settlementBank,
        account_number: params.accountNumber,
        percentage_charge: params.percentageCharge ?? 0,
      },
    );
  }

  /** List Nigerian banks (cached ~24h). Used to populate the onboarding dropdown. */
  async listBanks(): Promise<PaystackBank[]> {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (this.banksCache && Date.now() - this.banksCache.at < DAY_MS) {
      return this.banksCache.banks;
    }
    const data = await this.request<
      Array<{ name: string; code: string; currency: string }>
    >('GET', '/bank?country=nigeria&currency=NGN');
    const banks = data.map((b) => ({
      name: b.name,
      code: b.code,
      currency: b.currency,
    }));
    this.banksCache = { at: Date.now(), banks };
    return banks;
  }

  /** Resolve an account number against a bank code → the registered account name. */
  async resolveAccount(
    accountNumber: string,
    bankCode: string,
  ): Promise<{ accountName: string; accountNumber: string }> {
    const data = await this.request<{
      account_name: string;
      account_number: string;
    }>(
      'GET',
      `/bank/resolve?account_number=${encodeURIComponent(
        accountNumber,
      )}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    return {
      accountName: data.account_name,
      accountNumber: data.account_number,
    };
  }

  /** Initialize a split transaction; the school subaccount nets the remainder. */
  async initializeTransaction(
    params: InitializeTransactionParams,
  ): Promise<InitializeTransactionResult> {
    const body: Record<string, unknown> = {
      email: params.email,
      amount: params.amountKobo,
      reference: params.reference,
      subaccount: params.subaccount,
      transaction_charge: params.transactionChargeKobo,
      bearer: 'account', // platform main account bears the Paystack fee
      metadata: params.metadata ?? {},
    };
    if (params.callbackUrl) body.callback_url = params.callbackUrl;

    const data = await this.request<{
      authorization_url: string;
      access_code: string;
      reference: string;
    }>('POST', '/transaction/initialize', body);

    return {
      authorizationUrl: data.authorization_url,
      accessCode: data.access_code,
      reference: data.reference,
    };
  }

  /** Verify a transaction by reference (used on return + as webhook fallback). */
  async verifyTransaction(reference: string): Promise<VerifyTransactionResult> {
    const data = await this.request<PaystackVerifyData>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return {
      status: data.status,
      reference: data.reference,
      amount: data.amount,
      fees: typeof data.fees === 'number' ? data.fees : null,
      gatewayResponse:
        typeof data.gateway_response === 'string' && data.gateway_response
          ? data.gateway_response
          : null,
      subaccount: data.subaccount ?? null,
      metadata: data.metadata ?? null,
      raw: data,
    };
  }

  /**
   * Issue a request to Paystack through the circuit breaker. Unwraps the
   * `{ status, message, data }` envelope and returns `data`. When the breaker is
   * OPEN (Paystack is failing) this rejects immediately with 503 instead of
   * piling up doomed calls.
   */
  private async request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    try {
      return (await this.breaker.fire(method, path, body)) as T;
    } catch (err) {
      // opossum rejects with code 'EOPENBREAKER' while the circuit is open.
      if ((err as { code?: string }).code === 'EOPENBREAKER') {
        this.logger.warn(
          `Paystack call short-circuited (open): ${method} ${path}`,
        );
        throw new ServiceUnavailableException(
          'Payment provider temporarily unavailable, please retry shortly',
        );
      }
      throw err;
    }
  }

  /**
   * The actual HTTP call with bounded retry. Retries network/5xx with backoff;
   * 4xx surfaces immediately as BadGatewayException (a client/business error,
   * excluded from the breaker), while an exhausted 5xx / transport failure
   * surfaces as a provider-outage error that DOES count toward the breaker.
   */
  private async doRequest<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Exponential backoff with jitter before retries (not before the first
      // attempt), so a Paystack brownout isn't hammered at the worst moment.
      if (attempt > 0) {
        const base = 200 * 2 ** (attempt - 1); // 200ms, 400ms
        const jitter = Math.floor(base * (0.5 + (attempt % 2) * 0.25));
        await new Promise((r) => setTimeout(r, base + jitter));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${PAYSTACK_BASE_URL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.secretKey}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        const json = (await res.json().catch(() => null)) as {
          status?: boolean;
          message?: string;
          data?: T;
        } | null;

        if (!res.ok || !json?.status) {
          if (res.status >= 500) {
            // Transient server-side outage — retry, then give up (and let the
            // breaker count it as a failure via the final outage throw below).
            lastErr = new Error(
              `Paystack ${res.status}: ${json?.message ?? 'server error'}`,
            );
            if (attempt < MAX_ATTEMPTS - 1) continue;
            break;
          }
          // 4xx — a real client/business error; surface immediately. Excluded
          // from the breaker by errorFilter so it can't open the circuit.
          throw new BadGatewayException(
            `Paystack error (${res.status}): ${json?.message ?? 'unknown error'}`,
          );
        }
        return json.data as T;
      } catch (err) {
        lastErr = err;
        if (err instanceof BadGatewayException) throw err;
        // network/abort error — retry with backoff
        if (attempt < MAX_ATTEMPTS - 1) continue;
      } finally {
        clearTimeout(timer);
      }
    }
    this.logger.error(
      `Paystack request failed: ${method} ${path}: ${errorMessage(lastErr)}`,
    );
    throw new InternalServerErrorException('Payment provider unavailable');
  }
}
