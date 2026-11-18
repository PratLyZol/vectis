import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeBuyFill, normalizeSellFill } from "../src/executor.js";
import {
  GeminiTrade,
  NonceSource,
  buildHeaders,
  buildOrderPayload,
  buildPayload,
  encodePayload,
  signPayload,
} from "../src/gemini/trade.js";

const SECRET = "test-secret-1234";
const KEY = "account-TESTKEY";
const NONCE = 1794719176;
const order = { symbol: "GEMI-FEDJAN26-DN25", side: "buy", outcome: "yes", quantity: "161.29", price: "0.62" } as const;

describe("order payload", () => {
  it("has the exact fields and order of the Gemini spec", () => {
    const payload = buildOrderPayload(order, NONCE, KEY);
    expect(JSON.stringify(payload)).toBe(
      '{"request":"/v1/prediction-markets/order","nonce":1794719176,"symbol":"GEMI-FEDJAN26-DN25",' +
        '"orderType":"limit","side":"buy","outcome":"yes","quantity":"161.29","price":"0.62",' +
        '"timeInForce":"immediate-or-cancel"}',
    );
  });
  it("adds account=primary for master keys only", () => {
    expect(buildOrderPayload(order, NONCE, "master-ABC").account).toBe("primary");
    expect("account" in buildOrderPayload(order, NONCE, KEY)).toBe(false);
    expect(buildPayload("/v1/prediction-markets/terms/status", 5, "master-ABC")).toEqual({
      request: "/v1/prediction-markets/terms/status",
      nonce: 5,
      account: "primary",
    });
  });
});

describe("signing", () => {
  it("base64-encodes the JSON and signs that string with HMAC-SHA384 (hex)", () => {
    const payload = buildOrderPayload(order, NONCE, KEY);
    const b64 = encodePayload(payload);
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual(payload);
    const expected = createHmac("sha384", SECRET).update(b64).digest("hex");
    expect(signPayload(b64, SECRET)).toBe(expected);
    expect(signPayload(b64, SECRET)).toMatch(/^[0-9a-f]{96}$/);
  });
  it("matches a known vector", () => {
    // Independently computed: printf '%s' "$B64" | openssl dgst -sha384 -hmac test-secret-1234
    const b64 = encodePayload({ request: "/v1/order/status", nonce: 1776294447, order_id: 105575824 });
    expect(b64).toBe("eyJyZXF1ZXN0IjoiL3YxL29yZGVyL3N0YXR1cyIsIm5vbmNlIjoxNzc2Mjk0NDQ3LCJvcmRlcl9pZCI6MTA1NTc1ODI0fQ==");
    expect(signPayload(b64, SECRET)).toBe(KNOWN_SIGNATURE);
  });
  it("builds the full header set with an empty-body contract", () => {
    const payload = buildOrderPayload(order, NONCE, KEY);
    const h = buildHeaders(payload, KEY, SECRET);
    expect(h).toEqual({
      "Content-Type": "text/plain",
      "Content-Length": "0",
      "X-GEMINI-APIKEY": KEY,
      "X-GEMINI-PAYLOAD": encodePayload(payload),
      "X-GEMINI-SIGNATURE": signPayload(encodePayload(payload), SECRET),
      "Cache-Control": "no-cache",
    });
  });
});

describe("NonceSource", () => {
  it("is epoch seconds and strictly increasing even within one second", () => {
    let now = 1_794_719_176_400;
    const n = new NonceSource(() => now);
    expect(n.next()).toBe(1_794_719_176);
    expect(n.next()).toBe(1_794_719_177);
    now += 5000;
    expect(n.next()).toBe(1_794_719_181);
    now -= 60_000; // clock stepping back must not reuse a nonce
    expect(n.next()).toBe(1_794_719_182);
  });
});

describe("GeminiTrade client", () => {
  it("checks terms, accepts them, then posts the order with no body", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown; payload: Record<string, unknown>; sigOk: boolean }> = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      const b64 = headers["X-GEMINI-PAYLOAD"]!;
      const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      calls.push({
        url: String(url),
        method: init!.method,
        body: init!.body,
        payload,
        sigOk: headers["X-GEMINI-SIGNATURE"] === signPayload(b64, SECRET) && headers["X-GEMINI-APIKEY"] === KEY,
      });
      const path = payload.request as string;
      const json = path.endsWith("/terms/status")
        ? { hasAcceptedLatest: false }
        : path.endsWith("/terms/accept")
          ? { hasAcceptedLatest: true }
          : { orderId: "1", status: "filled", filledQuantity: "161.29", avgExecutionPrice: "0.61", remainingQuantity: "0" };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;

    const client = new GeminiTrade("https://sandbox.invalid", KEY, SECRET, fake);
    const res = await client.placeOrder(order);
    expect(res.filledQuantity).toBe("161.29");
    expect(calls.map((c) => `${c.method} ${c.url.replace("https://sandbox.invalid", "")}`)).toEqual([
      "GET /v1/prediction-markets/terms/status",
      "POST /v1/prediction-markets/terms/accept",
      "POST /v1/prediction-markets/order",
    ]);
    expect(calls.every((c) => c.sigOk && c.body === undefined)).toBe(true);
    const nonces = calls.map((c) => c.payload.nonce as number);
    expect(nonces[1]! > nonces[0]! && nonces[2]! > nonces[1]!).toBe(true);
    expect(calls[2]!.payload).toMatchObject({ symbol: order.symbol, timeInForce: "immediate-or-cancel", orderType: "limit" });
  }, 15_000);
});

describe("live fill normalisation", () => {
  it("buy: floors quantity to 0.01, rounds price up, caps at the limit", () => {
    expect(normalizeBuyFill("161.295", "0.6100001", 620_000n, 161_290_000n)).toEqual({ price: 610_001n, contracts: 161_290_000n });
    expect(normalizeBuyFill("50", "0.7", 620_000n, 161_290_000n)).toEqual({ price: 620_000n, contracts: 50_000_000n });
    expect(normalizeBuyFill("999", "0.6", 620_000n, 161_290_000n)!.contracts).toBe(161_290_000n);
  });
  it("buy: nothing filled is null", () => {
    expect(normalizeBuyFill("0", "0", 620_000n, 1_000_000n)).toBeNull();
    expect(normalizeBuyFill(undefined, undefined, 620_000n, 1_000_000n)).toBeNull();
    expect(normalizeBuyFill("0.004", "0.5", 620_000n, 1_000_000n)).toBeNull();
  });
  it("sell: rounds price down and never goes below the limit", () => {
    expect(normalizeSellFill("10", "0.5199999", 510_000n, 10_000_000n)).toEqual({ price: 519_999n, contracts: 10_000_000n });
    expect(normalizeSellFill("4", "0.2", 380_000n, 10_000_000n)).toEqual({ price: 380_000n, contracts: 4_000_000n });
    expect(normalizeSellFill("0", "0.5", 380_000n, 10_000_000n)).toBeNull();
  });
});

const KNOWN_SIGNATURE = "8736784efe7c91168b2cb0e4457f1642182ac162a3eba309b43683f830bd40f98717e4b84143b5e581c96a52229ba1bc";
