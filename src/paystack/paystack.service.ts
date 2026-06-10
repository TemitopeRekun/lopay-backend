import {
  Injectable,
  Logger,
  BadGatewayException,
  InternalServerErrorException,
} from '@nestjs/common';

const PAYSTACK_BASE_URL = 'https://api.paystack.co';
const REQUEST_TIMEOUT_MS = 15_000;

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
  subaccount?: { subaccount_code?: string } | null;
  metadata?: Record<string, unknown> | null;
  raw: any;
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

  constructor() {
    this.secretKey = process.env.PAYSTACK_SECRET_KEY ?? '';
    if (!this.secretKey) {
      this.logger.warn(
        'PAYSTACK_SECRET_KEY is empty — Paystack calls will fail until it is set.',
      );
    }
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
    const data = await this.request<any>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );
    return {
      status: data.status,
      reference: data.reference,
      amount: data.amount,
      fees: typeof data.fees === 'number' ? data.fees : null,
      subaccount: data.subaccount ?? null,
      metadata: data.metadata ?? null,
      raw: data,
    };
  }

  /**
   * Issue a request to Paystack. Unwraps the `{ status, message, data }`
   * envelope and returns `data`. Retries once on network/5xx errors.
   */
  private async request<T>(
    method: 'GET' | 'POST',
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
          // 5xx is retryable; 4xx is a real error — surface immediately.
          if (res.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
            lastErr = new Error(`Paystack ${res.status}: ${json?.message}`);
            continue;
          }
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
    this.logger.error(`Paystack request failed: ${method} ${path}`, lastErr as any);
    throw new InternalServerErrorException('Payment provider unavailable');
  }
}
