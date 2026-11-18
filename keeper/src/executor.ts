// Position execution: fills for PendingOpen / PendingClose positions, plus liquidation checks.
import { encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import { marginManagerAbi, priceOracleAbi } from "./abis.js";
import { type Clients, type TxQueue } from "./chain.js";
import { GeminiTradeError, type GeminiTrade } from "./gemini/trade.js";
import { InFlight } from "./inflight.js";
import { errText, logger } from "./log.js";
import {
  ONE,
  blendPrice,
  clampQuote,
  contractsForSize,
  fillCost,
  floorToStep,
  microToDecimal,
  sideAsk,
  sideBid,
  toMicro,
  toSide,
  type Quote,
  type Side,
} from "./math.js";
import { type OracleFeed } from "./oracle.js";
import { type KeeperState } from "./state.js";

const log = logger("exec");

const comboOrigin = (source: string): string => (source.includes("leg-derived") ? "leg-derived" : "on-chain oracle price");

export const STATUS = { None: 0, PendingOpen: 1, Open: 2, PendingClose: 3, Closed: 4 } as const;

export interface Fill {
  /** Side-space price, 1e6. */
  price: bigint;
  /** 6 decimals. */
  contracts: bigint;
  source: string;
}

/**
 * Normalise a live open (buy) result into a recordable fill, or null when nothing usable filled.
 * The average price is rounded up and capped at the limit (an IOC limit buy cannot fill above it),
 * so the recorded cost can never exceed what was sized for, whatever the API reports.
 */
export function normalizeBuyFill(
  filledQuantity: string | number | undefined,
  avgExecutionPrice: string | number | undefined,
  limitPrice: bigint,
  orderedContracts: bigint,
): { price: bigint; contracts: bigint } | null {
  let contracts = floorToStep(toMicro(filledQuantity, "down") ?? 0n);
  if (contracts > orderedContracts) contracts = orderedContracts;
  let price = toMicro(avgExecutionPrice, "up") ?? 0n;
  if (contracts <= 0n || price <= 0n) return null;
  if (price > limitPrice) price = limitPrice;
  return { price, contracts };
}

/** Same for a close (sell): average rounded down, floored at the limit price. */
export function normalizeSellFill(
  filledQuantity: string | number | undefined,
  avgExecutionPrice: string | number | undefined,
  limitPrice: bigint,
  orderedContracts: bigint,
): { price: bigint; contracts: bigint } | null {
  let contracts = toMicro(filledQuantity, "down") ?? 0n;
  if (contracts > orderedContracts) contracts = orderedContracts;
  let price = toMicro(avgExecutionPrice, "down") ?? 0n;
  if (contracts <= 0n || price <= 0n) return null;
  if (price < limitPrice) price = limitPrice;
  if (price > ONE) price = ONE;
  return { price, contracts };
}

export class Executor {
  private readonly inflight = new InFlight();
  private readonly retry = new Map<bigint, { failures: number; notBefore: number }>();
  private cursor: bigint | null = null;
  /** Market ids (lowercase) with an active position, refreshed by every sweep. */
  private active = new Set<string>();

  constructor(
    private readonly clients: Clients,
    private readonly queue: TxQueue,
    private readonly feed: OracleFeed,
    private readonly state: KeeperState,
    private readonly trade: GeminiTrade | null,
    private readonly marginManager: Address,
    private readonly oracle: Address,
  ) {}

  private read() {
    return { address: this.marginManager, abi: marginManagerAbi } as const;
  }

  /** Start the event cursor at the current head; history is covered by the startup sweep. */
  async initCursor(): Promise<void> {
    this.cursor = await this.clients.publicClient.getBlockNumber();
  }

  /** Poll new MarginManager logs in small ranges and act on open/close/liquidate requests. */
  async pollEvents(): Promise<void> {
    if (this.cursor === null) await this.initCursor();
    const head = await this.clients.publicClient.getBlockNumber();
    while (this.cursor! < head) {
      const fromBlock = this.cursor! + 1n;
      const toBlock = head - fromBlock > 999n ? fromBlock + 999n : head;
      const logs = await this.clients.publicClient.getLogs({ address: this.marginManager, fromBlock, toBlock });
      this.cursor = toBlock;
      const events = parseEventLogs({
        abi: marginManagerAbi,
        logs,
        eventName: ["PositionOpened", "PositionClosed", "PositionLiquidated"],
      });
      const ids = new Set<bigint>();
      for (const ev of events) {
        log.info(`event ${ev.eventName}`, { id: ev.args.id, block: ev.blockNumber });
        ids.add(ev.args.id);
      }
      for (const id of ids) this.trigger(id);
    }
  }

  /**
   * Read every active position: execute anything pending (covers restarts and missed events) and
   * liquidate Open positions the contract reports as liquidatable.
   */
  async sweep(): Promise<void> {
    const ids = await this.clients.publicClient.readContract({ ...this.read(), functionName: "activePositionIds" });
    const active = new Set<string>();
    let complete = true;
    try {
      await this.sweepPositions(ids, active, () => (complete = false));
    } finally {
      // Only shrink the set after a clean pass, so a read error never makes a combo look abandoned.
      this.active = complete ? active : new Set([...this.active, ...active]);
    }
  }

  /** Market ids with an active position (combos among them must stay priced). */
  activeMarkets(): ReadonlySet<string> {
    return this.active;
  }

  private async sweepPositions(ids: readonly bigint[], active: Set<string>, onError: () => void): Promise<void> {
    for (const id of ids) {
      try {
        const pos = await this.clients.publicClient.readContract({
          ...this.read(),
          functionName: "getPosition",
          args: [id],
        });
        active.add(pos.marketId.toLowerCase());
        if (pos.status === STATUS.PendingOpen || pos.status === STATUS.PendingClose) {
          await this.process(id);
        } else if (pos.status === STATUS.Open) {
          await this.checkLiquidation(id);
        }
      } catch (err) {
        onError();
        log.error("sweep failed for position", { id, err: errText(err) });
      }
    }
  }

  /** Market ids of all active positions (so their markets stay priced after a restart). */
  async activeMarketIds(): Promise<Hex[]> {
    const ids = await this.clients.publicClient.readContract({ ...this.read(), functionName: "activePositionIds" });
    const out = new Set<Hex>();
    for (const id of ids) {
      const pos = await this.clients.publicClient.readContract({ ...this.read(), functionName: "getPosition", args: [id] });
      out.add(pos.marketId.toLowerCase() as Hex);
    }
    this.active = new Set(out);
    return [...out];
  }

  private async checkLiquidation(id: bigint): Promise<void> {
    let liquidatable: boolean;
    let reason: number;
    try {
      [liquidatable, reason] = await this.clients.publicClient.readContract({
        ...this.read(),
        functionName: "isLiquidatable",
        args: [id],
      });
    } catch (err) {
      // Typically a stale or missing oracle price; the next cycle retries.
      log.warn("isLiquidatable failed", { id, err: errText(err, 160) });
      return;
    }
    if (!liquidatable) return;
    log.info("liquidating", { id, reason });
    try {
      await this.queue.send(
        `liquidate #${id}`,
        this.marginManager,
        encodeFunctionData({ abi: marginManagerAbi, functionName: "liquidate", args: [id] }),
      );
    } catch (err) {
      log.error("liquidate failed", { id, err: errText(err) });
      return;
    }
    await this.process(id);
  }

  /**
   * A fresh on-chain request for this position, from either event path (QuickNode Stream feed or
   * RPC getLogs). Clears any retry backoff and processes at once. Safe to call twice for one event.
   */
  trigger(id: bigint): void {
    this.retry.delete(id);
    void this.process(id);
  }

  /**
   * Idempotent and single-flight per position: concurrent calls for the same id never run side by
   * side (so the stream and RPC paths cannot both submit recordFill for one pending state); a call
   * that lands mid-flight schedules one re-read after the current run instead.
   */
  async process(id: bigint): Promise<void> {
    await this.inflight.run(id.toString(), () => this.processOnce(id));
  }

  /** Re-reads the position and only acts on PendingOpen / PendingClose. Never throws. */
  private async processOnce(id: bigint): Promise<void> {
    const backoff = this.retry.get(id);
    if (backoff && Date.now() < backoff.notBefore) return;
    try {
      const pos = await this.clients.publicClient.readContract({ ...this.read(), functionName: "getPosition", args: [id] });
      if (pos.status !== STATUS.PendingOpen && pos.status !== STATUS.PendingClose) return;
      const phase = pos.status === STATUS.PendingOpen ? "open" : "close";
      const side = toSide(pos.side);
      const marketId = pos.marketId;
      this.active.add(marketId.toLowerCase());
      const combo = this.feed.comboOf(marketId) ?? this.state.comboOf(marketId);
      const symbol = combo?.symbol ?? this.feed.symbolOf(marketId) ?? this.state.symbolOf(marketId);

      let fill: Fill | null = null;
      const saved = this.state.getFill(id, phase);
      if (saved) {
        // A live order already filled for this step but its on-chain record did not land.
        fill = { price: BigInt(saved.price), contracts: BigInt(saved.contracts), source: `${saved.source} (resumed)` };
      } else {
        const priced = await this.quote(marketId);
        if (!priced) throw new SkipFill(`no price available for ${combo ? "combo" : "market"} ${symbol ?? marketId}`);
        // Combos are always simulated, even in live mode: no Gemini order is ever sent for one.
        const trade = tradeFor(this.trade, combo !== undefined);
        fill =
          phase === "open"
            ? await openFill(trade, id, symbol, side, pos.margin + pos.borrowed, priced.quote)
            : await closeFill(trade, id, symbol, side, pos.contracts, priced.quote);
        if (combo) fill.source = priced.origin === "legs" ? "simulated (combo, leg-derived)" : "simulated (combo, on-chain oracle price)";
        if (fill.source.startsWith("gemini")) {
          this.state.putFill(id, phase, {
            price: fill.price.toString(),
            contracts: fill.contracts.toString(),
            source: fill.source,
          });
        }
      }

      await this.queue.send(
        `recordFill #${id} ${phase}`,
        this.marginManager,
        encodeFunctionData({
          abi: marginManagerAbi,
          functionName: "recordFill",
          args: [id, fill.price, fill.contracts],
        }),
      );
      this.state.clearFill(id, phase);
      this.retry.delete(id);
      const fields = {
        id,
        symbol: symbol ?? marketId,
        side: side === 0 ? "YES" : "NO",
        price: microToDecimal(fill.price),
        contracts: microToDecimal(fill.contracts),
        source: fill.source,
      };
      if (combo) {
        log.info(`fill #${id} SIMULATED (combo, ${comboOrigin(fill.source)}) price=${microToDecimal(fill.price)}`, {
          phase,
          symbol: combo.symbol,
          side: fields.side,
          contracts: fields.contracts,
          legs: combo.legs.length,
        });
      } else {
        log.info(`${phase} filled`, fields);
      }
    } catch (err) {
      const failures = (this.retry.get(id)?.failures ?? 0) + 1;
      const waitMs = Math.min(60_000, 5000 * 2 ** (failures - 1));
      this.retry.set(id, { failures, notBefore: Date.now() + waitMs });
      const fields = { id, attempt: failures, retryInMs: waitMs, err: errText(err) };
      if (err instanceof SkipFill) log.warn("cannot fill yet; will retry", fields);
      else log.error("execution failed; will retry", fields);
    }
  }

  /**
   * Fill quote: the Gemini book for tracked markets or the leg-derived price for combos, otherwise
   * the last on-chain oracle price.
   */
  private async quote(marketId: Hex): Promise<{ quote: Quote; origin: "book" | "legs" | "onchain" } | null> {
    const live = await this.feed.quoteFor(marketId);
    if (live) return { quote: live, origin: this.feed.comboOf(marketId) ? "legs" : "book" };
    try {
      const [bid, ask, updatedAt] = await this.clients.publicClient.readContract({
        address: this.oracle,
        abi: priceOracleAbi,
        functionName: "peekPrice",
        args: [marketId],
      });
      if (updatedAt === 0n) return null;
      log.warn("using last on-chain oracle price for fill", { marketId, updatedAt });
      return { quote: clampQuote(bid, ask), origin: "onchain" };
    } catch {
      return null;
    }
  }
}

/** Raised when a step cannot be filled right now and should simply be retried later. */
export class SkipFill extends Error {}

/**
 * Where a fill is executed. Combos never go to Gemini (their books are empty; real fills happen in
 * a private quote auction), so they get no trade client even in live mode.
 */
export function tradeFor<T>(trade: T | null, isCombo: boolean): T | null {
return isCombo ? null : trade;
}

type OrderPlacer = Pick<GeminiTrade, "placeOrder">;

/** Fill for a PendingOpen position: a Gemini buy when `trade` is given, otherwise simulated at the side ask. */
export async function openFill(
trade: OrderPlacer | null,
id: bigint,
symbol: string | undefined,
side: Side,
size: bigint,
quote: Quote,
): Promise<Fill> {
  const price = sideAsk(quote, side);
  const contracts = contractsForSize(size, price);
  // Never record an open at a zero price or for zero contracts; leave it PendingOpen and retry.
  if (price <= 0n || contracts <= 0n) {
    throw new SkipFill(`open skipped: size=${microToDecimal(size)} price=${microToDecimal(price)} gives no fill`);
  }
  const simulated: Fill = { price, contracts, source: "simulated" };
  if (!trade) return simulated;
  if (!symbol) {
    log.warn("FALLBACK simulated fill: no Gemini symbol known for market", { id });
    return { ...simulated, source: "simulated-fallback" };
  }
  try {
    const res = await trade.placeOrder({
      symbol,
      side: "buy",
      outcome: side === 0 ? "yes" : "no",
      quantity: microToDecimal(contracts),
      price: microToDecimal(price),
    });
    const live = normalizeBuyFill(res.filledQuantity, res.avgExecutionPrice, price, contracts);
    if (live && fillCost(live.contracts, live.price) <= size) {
      log.info("gemini order filled", {
        id,
        orderId: res.orderId,
        status: res.status,
        filled: microToDecimal(live.contracts),
        avg: microToDecimal(live.price),
      });
      return { ...live, source: "gemini" };
    }
    log.warn("FALLBACK simulated fill at oracle price: Gemini order filled nothing", {
      id,
      symbol,
      orderId: res.orderId,
      status: res.status,
    });
  } catch (err) {
    log.warn("FALLBACK simulated fill at oracle price: Gemini order rejected", {
      id,
      symbol,
      err: err instanceof GeminiTradeError ? err.message : errText(err),
    });
  }
  return { ...simulated, source: "simulated-fallback" };
}

/** Fill for a PendingClose position: a Gemini sell when `trade` is given, otherwise simulated at the side bid (0 is allowed). */
export async function closeFill(
trade: OrderPlacer | null,
id: bigint,
symbol: string | undefined,
side: Side,
contracts: bigint,
quote: Quote,
): Promise<Fill> {
  const price = sideBid(quote, side);
  const simulated: Fill = { price, contracts, source: "simulated" };
  if (!trade) return simulated;
  if (!symbol || price <= 0n) {
    log.warn("FALLBACK simulated fill: no Gemini symbol or zero bid", { id });
    return { ...simulated, source: "simulated-fallback" };
  }
  try {
    const res = await trade.placeOrder({
      symbol,
      side: "sell",
      outcome: side === 0 ? "yes" : "no",
      quantity: microToDecimal(contracts),
      price: microToDecimal(price),
    });
    const live = normalizeSellFill(res.filledQuantity, res.avgExecutionPrice, price, contracts);
    if (live) {
      const rest = contracts - live.contracts;
      if (rest > 0n) {
        // The contract requires the full quantity on close: value the unfilled part at the bid.
        log.warn("PARTIAL gemini close: remainder simulated at oracle bid", {
          id,
          filled: microToDecimal(live.contracts),
          simulated: microToDecimal(rest),
        });
      }
      return {
        price: blendPrice(live.contracts, live.price, rest, price),
        contracts,
        source: rest > 0n ? "gemini-partial" : "gemini",
      };
    }
    log.warn("FALLBACK simulated fill at oracle price: Gemini order filled nothing", {
      id,
      symbol,
      orderId: res.orderId,
      status: res.status,
    });
  } catch (err) {
    log.warn("FALLBACK simulated fill at oracle price: Gemini order rejected", {
      id,
      symbol,
      err: err instanceof GeminiTradeError ? err.message : errText(err),
    });
  }
  return { ...simulated, source: "simulated-fallback" };
}
