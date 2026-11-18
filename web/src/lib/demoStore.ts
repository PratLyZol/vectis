"use client";

// Demo-mode state: a wallet balance, positions and a vault, held in memory and mirrored to
// localStorage. Mirrors the contract lifecycle (PendingOpen -> Open -> PendingClose -> Closed)
// with a short simulated keeper delay. Also holds the marketId -> market name registry used in
// both modes.
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { liquidationPrice, notional, openFee, settle, type Side } from "./math";
import { STATUS, type MarketMeta, type PositionView } from "./positions";
import type { ActivityEvent } from "./activity";
import type { Combo } from "./combo";

const KEY = "vectis.demo.v2";
const META_KEY = "vectis.markets.v1";
const FILL_DELAY_MS = 2500;
const USDC = 1_000_000n;
// vUSDC has 12 decimals (a 6-decimal offset over USDC): 1 USDC mints 1e12 share wei at par.
const SHARE_OFFSET = 1_000_000n;
export const SHARE_UNIT = 10n ** 12n;

type DemoPosition = PositionView & { pendingSince: number; exitRef?: bigint };

export type DemoState = {
  balance: bigint; // demo wallet USDC
  nextId: bigint;
  positions: DemoPosition[];
  vault: { cash: bigint; borrowed: bigint; shares: bigint; userShares: bigint; fees: bigint };
  meta: Record<string, MarketMeta>;
  activity: ActivityEvent[]; // the demo store's own recent actions, newest first
  combos: Record<string, Combo>; // combos built or opened in this browser, by symbol (demo mode)
};

const initial = (): DemoState => ({
  balance: 10_000n * USDC,
  nextId: 1n,
  positions: [],
  vault: { cash: 250_000n * USDC, borrowed: 0n, shares: 250_000n * USDC * SHARE_OFFSET, userShares: 0n, fees: 0n },
  meta: {},
  activity: [],
  combos: {},
});

const SERVER_STATE = initial();
let state: DemoState = SERVER_STATE;
let hydrated = false;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

// bigint <-> JSON
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);

function persist() {
  try {
    const { meta, ...rest } = state;
    window.localStorage.setItem(KEY, JSON.stringify(rest, replacer));
    window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {
    // Storage can be blocked or full; the in-memory state still works.
  }
}

function set(next: DemoState) {
  state = next;
  persist();
  listeners.forEach((l) => l());
  schedule();
}

/** Load saved state once, in the browser, after the first render. */
export function hydrateDemoStore() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  let next = initial();
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw, reviver) as Partial<DemoState>;
      if (typeof saved.balance === "bigint" && Array.isArray(saved.positions) && saved.vault) {
        next = { ...next, ...saved, meta: {} } as DemoState;
        if (!Array.isArray(next.activity)) next.activity = [];
        if (typeof next.vault.fees !== "bigint") next.vault = { ...next.vault, fees: 0n };
        if (!next.combos || typeof next.combos !== "object") next.combos = {};
      }
    }
    const rawMeta = window.localStorage.getItem(META_KEY);
    if (rawMeta) next.meta = JSON.parse(rawMeta) as Record<string, MarketMeta>;
  } catch {
    next = initial();
  }
  state = next;
  listeners.forEach((l) => l());
  schedule();
}

const ACTIVITY_LIMIT = 30;

/** Record demo actions in the same shape the activity API serves. They never touched a chain. */
function logged(
  activity: ActivityEvent[],
  entries: { eventName: string; positionId?: bigint; marketId?: Hex; args: Record<string, unknown> }[],
): ActivityEvent[] {
  let seq = activity[0]?.seq ?? 0;
  const added = entries.map((e): ActivityEvent => {
    seq += 1;
    return {
      seq,
      id: `demo:${seq}`,
      blockNumber: 0,
      txHash: null,
      logIndex: 0,
      address: "demo",
      eventName: e.eventName,
      positionId: e.positionId?.toString() ?? null,
      owner: "demo",
      marketId: e.marketId ?? null,
      args: e.args,
      receivedAt: new Date().toISOString(),
    };
  });
  return [...added.reverse(), ...activity].slice(0, ACTIVITY_LIMIT);
}

function vaultAssets(v: DemoState["vault"]) {
  return v.cash + v.borrowed;
}

/** Apply every simulated keeper fill that is due. */
function resolveDue() {
  const now = Date.now();
  let { balance } = state;
  let vault = { ...state.vault };
  let changed = false;
  const events: Parameters<typeof logged>[1] = [];
  const positions = state.positions.map((p) => {
    if (now - p.pendingSince < FILL_DELAY_MS) return p;
    if (p.status === STATUS.PendingOpen) {
      changed = true;
      const price = p.refPrice ?? 0n;
      const size = p.margin + p.borrowed;
      const contracts = price > 0n ? (size * USDC) / price : 0n;
      const cost = notional(contracts, price);
      // Unused size goes back at once: first to the vault, then to the owner.
      const unused = size - cost;
      const toVault = unused < p.borrowed ? unused : p.borrowed;
      const borrowed = p.borrowed - toVault;
      vault = { ...vault, cash: vault.cash + toVault, borrowed: vault.borrowed - toVault };
      balance += unused - toVault;
      const liq = liquidationPrice(borrowed, contracts);
      events.push({
        eventName: "FillRecorded",
        positionId: p.id,
        marketId: p.marketId,
        args: { entryPrice: price.toString(), contracts: contracts.toString(), borrowed: borrowed.toString(), liqPrice: liq.toString() },
      });
      return {
        ...p,
        status: STATUS.Open,
        entryPrice: price,
        contracts,
        cost,
        borrowed,
        liqPrice: liq,
      };
    }
    if (p.status === STATUS.PendingClose) {
      changed = true;
      const exitPrice = p.exitRef ?? p.entryPrice;
      const s = settle(p.contracts, exitPrice, p.borrowed);
      vault = { ...vault, cash: vault.cash + s.repaid, borrowed: vault.borrowed - p.borrowed };
      balance += s.payout;
      events.push({
        eventName: "PositionSettled",
        positionId: p.id,
        marketId: p.marketId,
        args: {
          exitPrice: exitPrice.toString(),
          proceeds: s.proceeds.toString(),
          repaid: s.repaid.toString(),
          loss: s.loss.toString(),
          payout: s.payout.toString(),
        },
      });
      return { ...p, status: STATUS.Closed, exitPrice, payout: s.payout, settledDebt: p.borrowed };
    }
    return p;
  });
  if (changed) set({ ...state, balance, vault, positions, activity: logged(state.activity, events) });
}

function schedule() {
  if (typeof window === "undefined") return;
  if (timer) clearTimeout(timer);
  timer = null;
  const pending = state.positions.filter(
    (p) => p.status === STATUS.PendingOpen || p.status === STATUS.PendingClose,
  );
  if (pending.length === 0) return;
  const next = Math.min(...pending.map((p) => p.pendingSince + FILL_DELAY_MS));
  timer = setTimeout(resolveDue, Math.max(0, next - Date.now()) + 20);
}

export class DemoError extends Error {}

export const demo = {
  /** Keep a combo's definition in this browser so its page and positions can be priced. */
  saveCombo(combo: Combo) {
    if (typeof window === "undefined") return;
    set({ ...state, combos: { ...state.combos, [combo.symbol]: combo } });
  },

  saveMeta(marketId: Hex, meta: MarketMeta) {
    if (typeof window === "undefined") return;
    set({ ...state, meta: { ...state.meta, [marketId]: meta } });
  },

  open(args: { marketId: Hex; side: Side; margin: bigint; leverage: bigint; refPrice: bigint }): bigint {
    const size = (args.margin * args.leverage) / 10n;
    const borrowed = size - args.margin;
    // The open fee is paid to the vault on top of the margin and mints no shares, so it raises
    // the share price for everyone who has supplied.
    const fee = openFee(borrowed);
    if (args.margin + fee > state.balance) throw new DemoError("Margin plus the open fee is more than the demo balance.");
    if (borrowed > state.vault.cash) throw new DemoError("The vault does not hold enough USDC to lend.");
    const id = state.nextId;
    const position: DemoPosition = {
      id,
      marketId: args.marketId,
      side: args.side,
      status: STATUS.PendingOpen,
      liquidated: false,
      margin: args.margin,
      leverage: args.leverage,
      borrowed,
      cost: 0n,
      entryPrice: 0n,
      contracts: 0n,
      liqPrice: 0n,
      openedAt: BigInt(Math.floor(Date.now() / 1000)),
      refPrice: args.refPrice,
      pendingSince: Date.now(),
    };
    set({
      ...state,
      balance: state.balance - args.margin - fee,
      nextId: id + 1n,
      vault: {
        ...state.vault,
        cash: state.vault.cash - borrowed + fee,
        borrowed: state.vault.borrowed + borrowed,
        fees: state.vault.fees + fee,
      },
      positions: [...state.positions, position],
      activity: logged(state.activity, [
        {
          eventName: "PositionOpened",
          positionId: id,
          marketId: args.marketId,
          args: {
            side: args.side,
            margin: args.margin.toString(),
            leverage: args.leverage.toString(),
            borrowed: borrowed.toString(),
            refPrice: args.refPrice.toString(),
          },
        },
        ...(fee > 0n
          ? [{ eventName: "OpenFeePaid", positionId: id, marketId: args.marketId, args: { fee: fee.toString() } }]
          : []),
      ]),
    });
    return id;
  },

  /** Request a close; the simulated fill settles at `exitPrice` (the side bid now). */
  close(id: bigint, exitPrice: bigint) {
    const target = state.positions.find((p) => p.id === id);
    if (!target || target.status !== STATUS.Open) throw new DemoError("Only an open position can be closed.");
    set({
      ...state,
      positions: state.positions.map((p) =>
        p.id === id ? { ...p, status: STATUS.PendingClose, pendingSince: Date.now(), exitRef: exitPrice } : p,
      ),
      activity: logged(state.activity, [{ eventName: "PositionClosed", positionId: id, marketId: target.marketId, args: {} }]),
    });
  },

  deposit(assets: bigint) {
    if (assets <= 0n) throw new DemoError("Enter an amount.");
    if (assets > state.balance) throw new DemoError("Amount is more than the demo balance.");
    const v = state.vault;
    const total = vaultAssets(v);
    const shares = v.shares === 0n || total === 0n ? assets * SHARE_OFFSET : (assets * v.shares) / total;
    set({
      ...state,
      balance: state.balance - assets,
      vault: { ...v, cash: v.cash + assets, shares: v.shares + shares, userShares: v.userShares + shares },
      activity: logged(state.activity, [{ eventName: "Deposit", args: { assets: assets.toString(), shares: shares.toString() } }]),
    });
  },

  withdraw(assets: bigint) {
    if (assets <= 0n) throw new DemoError("Enter an amount.");
    const v = state.vault;
    const total = vaultAssets(v);
    const owned = v.shares === 0n ? 0n : (v.userShares * total) / v.shares;
    if (assets > owned) throw new DemoError("Amount is more than your vault balance.");
    if (assets > v.cash) throw new DemoError("The vault does not hold enough idle USDC right now.");
    // Burn shares rounded up, capped at what the user holds.
    let shares = total === 0n ? 0n : (assets * v.shares + total - 1n) / total;
    if (shares > v.userShares) shares = v.userShares;
    set({
      ...state,
      balance: state.balance + assets,
      vault: { ...v, cash: v.cash - assets, shares: v.shares - shares, userShares: v.userShares - shares },
      activity: logged(state.activity, [{ eventName: "Withdraw", args: { assets: assets.toString(), shares: shares.toString() } }]),
    });
  },

  reset() {
    set({ ...initial(), meta: state.meta, combos: state.combos });
  },
};

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDemoState(): DemoState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => SERVER_STATE,
  );
}

/** Derived vault figures in the same shape the live hooks produce. */
export function demoVaultFigures(s: DemoState) {
  const v = s.vault;
  const totalAssets = vaultAssets(v);
  const sharePrice = v.shares === 0n ? USDC : (totalAssets * SHARE_UNIT) / v.shares;
  const userAssets = v.shares === 0n ? 0n : (v.userShares * totalAssets) / v.shares;
  const maxWithdraw = userAssets < v.cash ? userAssets : v.cash;
  return {
    totalAssets,
    totalBorrowed: v.borrowed,
    available: v.cash,
    sharePrice,
    userAssets,
    maxWithdraw,
    totalFees: v.fees as bigint | undefined,
    userShares: v.userShares,
    shareUnit: SHARE_UNIT,
  };
}
