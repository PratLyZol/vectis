// Signed Gemini private REST client for prediction-market orders (sandbox by default).
// Auth: JSON payload -> base64 -> X-GEMINI-PAYLOAD; hex HMAC-SHA384 of that base64 string with the
// API secret -> X-GEMINI-SIGNATURE; empty HTTP body. Secrets are never logged.
import { createHmac } from "node:crypto";
import { errText, logger } from "../log.js";

const log = logger("gemini-trade");

export const ORDER_PATH = "/v1/prediction-markets/order";
export const TERMS_STATUS_PATH = "/v1/prediction-markets/terms/status";
export const TERMS_ACCEPT_PATH = "/v1/prediction-markets/terms/accept";

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  outcome: "yes" | "no";
  /** Decimal string, contracts. */
  quantity: string;
  /** Decimal string, 0-1, in the outcome's own price space. */
  price: string;
}

export interface OrderResponse {
  orderId?: string | number;
  status?: string;
  filledQuantity?: string | number;
  avgExecutionPrice?: string | number;
  remainingQuantity?: string | number;
}

export interface SignedHeaders {
  "Content-Type": "text/plain";
  "Content-Length": "0";
  "X-GEMINI-APIKEY": string;
  "X-GEMINI-PAYLOAD": string;
  "X-GEMINI-SIGNATURE": string;
  "Cache-Control": "no-cache";
}

/** Payload object in wire order: request, nonce, [account], then endpoint fields. */
export function buildPayload(
  request: string,
  nonce: number,
  apiKey: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  const payload: Record<string, unknown> = { request, nonce };
  if (apiKey.startsWith("master-")) payload.account = "primary";
  return { ...payload, ...fields };
}

export function buildOrderPayload(order: OrderRequest, nonce: number, apiKey: string): Record<string, unknown> {
  return buildPayload(ORDER_PATH, nonce, apiKey, {
    symbol: order.symbol,
    orderType: "limit",
    side: order.side,
    outcome: order.outcome,
    quantity: order.quantity,
    price: order.price,
    timeInForce: "immediate-or-cancel",
  });
}

export function encodePayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function signPayload(b64Payload: string, apiSecret: string): string {
  return createHmac("sha384", apiSecret).update(b64Payload).digest("hex");
}

export function buildHeaders(payload: Record<string, unknown>, apiKey: string, apiSecret: string): SignedHeaders {
  const b64 = encodePayload(payload);
  return {
    "Content-Type": "text/plain",
    "Content-Length": "0",
    "X-GEMINI-APIKEY": apiKey,
    "X-GEMINI-PAYLOAD": b64,
    "X-GEMINI-SIGNATURE": signPayload(b64, apiSecret),
    "Cache-Control": "no-cache",
  };
}

/** Time-based nonce in epoch seconds, strictly increasing within the process. */
export class NonceSource {
  private last = 0;
  constructor(private readonly nowMs: () => number = Date.now) {}
  next(): number {
    const now = Math.floor(this.nowMs() / 1000);
    this.last = now > this.last ? now : this.last + 1;
    return this.last;
  }
}

export class GeminiTradeError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Gemini ${status}: ${reason}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GeminiTrade {
  private readonly nonces = new NonceSource();
  private chain: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  private termsOk = false;

  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * One signed request at a time, at least 1.1 s apart, so the per-second nonce stays inside the
   * server's +/-30 s window while still strictly increasing.
   */
  private signed<T>(method: "POST" | "GET", path: string, fields: Record<string, unknown> = {}): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastAt + 1100 - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        const payload = buildPayload(path, this.nonces.next(), this.apiKey, fields);
        const headers = buildHeaders(payload, this.apiKey, this.apiSecret);
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.base}${path}`, {
            method,
            headers: { ...headers },
            signal: AbortSignal.timeout(20_000),
          });
        } catch (err) {
          throw new GeminiTradeError(0, `network: ${errText(err)}`);
        }
        const text = await res.text().catch(() => "");
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : {};
        } catch {
          body = { message: text.slice(0, 200) };
        }
        if (!res.ok) {
          const b = body as { reason?: string; message?: string };
          throw new GeminiTradeError(res.status, [b.reason, b.message].filter(Boolean).join(": ") || "request failed");
        }
        return body as T;
      } finally {
        this.lastAt = Date.now();
      }
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Check the prediction-market terms once per process and accept them if needed. Best effort: if
   * the check itself fails we warn and let the order go out (it is rejected if terms are missing).
   */
  async ensureTerms(): Promise<void> {
    if (this.termsOk) return;
    try {
      let status: { hasAcceptedLatest?: boolean };
      try {
        // Documented as GET with the signed headers.
        status = await this.signed("GET", TERMS_STATUS_PATH);
      } catch (err) {
        if (!(err instanceof GeminiTradeError) || err.status === 0) throw err;
        status = await this.signed("POST", TERMS_STATUS_PATH);
      }
      if (status.hasAcceptedLatest !== true) {
        await this.signed("POST", TERMS_ACCEPT_PATH);
        log.info("accepted prediction-market terms");
      }
      this.termsOk = true;
    } catch (err) {
      log.warn("terms check failed; sending the order anyway", { err: errText(err) });
    }
  }

  async placeOrder(order: OrderRequest): Promise<OrderResponse> {
    await this.ensureTerms();
    const { request: _r, nonce: _n, account: _a, ...fields } = buildOrderPayload(order, 0, this.apiKey);
    return this.signed<OrderResponse>("POST", ORDER_PATH, fields);
  }
}
