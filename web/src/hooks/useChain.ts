"use client";

// Wallet and contract access. Every hook has a demo path (isMock) backed by the local store and a
// live path through wagmi; the two return the same shapes. isMock is a build-time constant, so the
// branch a hook takes never changes between renders.
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { erc20Abi, erc4626Abi, parseEventLogs, type Hex } from "viem";
import {
  useAccount,
  useConfig,
  useConnect,
  useDisconnect,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
} from "wagmi";
import { readContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { marginManagerAbi, lendingVaultAbi, priceOracleAbi } from "@/config/abis";
import { contracts, isMock } from "@/config/contracts";
import { demo, demoVaultFigures, useDemoState } from "@/lib/demoStore";
import type { Combo } from "@/lib/combo";
import { errorMessage } from "@/lib/format";
import { openWalletChooser } from "@/lib/walletChooser";
import { useCombos } from "./useMarketData";
import type { Side } from "@/lib/math";
import { STATUS, type MarketMeta, type PositionView, type Status } from "@/lib/positions";

const chainId = contracts.chainId as 5042002;
const POLL = 5_000;
const noopSubscribe = () => () => {};

// ---------------------------------------------------------------------------------------------
// Wallet

export function useWallet() {
  const { address, isConnected, chainId: walletChain } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const { disconnect } = useDisconnect();
  const wrongChain = isConnected && walletChain !== chainId;
  // Wallets that announced themselves (EIP-6963) are addressed directly. The generic injected
  // connector reads window.ethereum, which several installed wallets fight over, so it is only
  // used when nothing announced itself and window.ethereum exists.
  // Read after hydration (false on the server and the first client render) so the markup matches.
  const hasProvider = useSyncExternalStore(
    noopSubscribe,
    () => "ethereum" in window,
    () => false,
  );
  const options = useMemo(() => {
    const announced = connectors.filter((c) => c.id !== "injected");
    if (announced.length > 0) return announced;
    return hasProvider ? connectors.slice(0, 1) : [];
  }, [connectors, hasProvider]);
  const connectWith = useCallback(
    (connector: (typeof connectors)[number]) =>
      connect({ connector, chainId }, { onError: () => openWalletChooser() }),
    [connect],
  );
  return {
    options,
    connectWith,
    address,
    connected: isConnected,
    wrongChain,
    ready: isConnected && !wrongChain,
    connecting,
    switching,
    // True on the server and first render too, so the buttons match; the chooser explains a missing wallet.
    hasConnector: true,
    error: connectError ?? switchError ?? null,
    // One wallet: connect to it. Several, or none: open the chooser.
    connect: () => {
      const only = options.length === 1 ? options[0] : undefined;
      if (only) connectWith(only);
      else openWalletChooser();
    },
    switchToArc: () => switchChain({ chainId }),
    disconnect: () => disconnect(),
  };
}

/** ERC-20 USDC balance (6 decimals) of the connected wallet; undefined when not connected. */
export function useWalletUsdc(): bigint | undefined {
  const { address } = useAccount();
  const { data } = useReadContract({
    abi: erc20Abi,
    address: contracts.usdc,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
  });
  return address ? data : undefined;
}

/** The USDC balance trades and deposits spend: the demo balance, or the wallet's. */
export function useSpendableUsdc(): bigint | undefined {
  const demoState = useDemoState();
  const wallet = useWalletUsdc();
  return isMock ? demoState.balance : wallet;
}

// ---------------------------------------------------------------------------------------------
// Market names

/** marketId -> market name: what this browser recorded, plus every combo the server or the demo store knows. */
export function useMarketMeta(): Record<string, MarketMeta> {
  const state = useDemoState();
  const { data } = useCombos();
  return useMemo(() => {
    const out: Record<string, MarketMeta> = {};
    for (const c of [...(data?.combos ?? []), ...Object.values(state.combos)]) {
      out[c.marketId] = { symbol: c.symbol, eventTicker: "", title: c.label, label: "Combo", expiry: c.expiry, kind: "combo" };
    }
    return { ...out, ...state.meta };
  }, [data, state.combos, state.meta]);
}

/** Every combo known here, by symbol: the server's list plus the demo store's. */
export function useKnownCombos(): Record<string, Combo> {
  const state = useDemoState();
  const { data } = useCombos();
  return useMemo(() => {
    const out: Record<string, Combo> = {};
    for (const c of data?.combos ?? []) out[c.symbol] = c;
    return { ...out, ...state.combos };
  }, [data, state.combos]);
}

// ---------------------------------------------------------------------------------------------
// Oracle

export type OracleQuote = {
  registered: boolean;
  yesBid: bigint;
  yesAsk: bigint;
  updatedAt: bigint; // 0 when never posted
  closeTime: bigint;
};

/** Last oracle price, registration and close time per market. Empty in demo mode. */
export function useOracleQuotes(marketIds: Hex[]): Map<Hex, OracleQuote> {
  const ids = useMemo(() => [...new Set(marketIds)], [marketIds]);
  const calls = useMemo(
    () =>
      isMock
        ? []
        : ids.flatMap((id) => {
            const base = { abi: priceOracleAbi, address: contracts.priceOracle, chainId, args: [id] } as const;
            return [
              { ...base, functionName: "isRegistered" } as const,
              { ...base, functionName: "peekPrice" } as const,
              { ...base, functionName: "closeTime" } as const,
            ];
          }),
    [ids],
  );
  const { data } = useReadContracts({
    contracts: calls,
    allowFailure: true,
    query: { enabled: calls.length > 0, refetchInterval: POLL },
  });
  return useMemo(() => {
    const out = new Map<Hex, OracleQuote>();
    if (!data) return out;
    ids.forEach((id, i) => {
      const registered = data[i * 3]?.result as boolean | undefined;
      const price = data[i * 3 + 1]?.result as readonly [bigint, bigint, bigint] | undefined;
      const closeTime = data[i * 3 + 2]?.result as bigint | undefined;
      if (registered === undefined || !price) return;
      out.set(id, {
        registered,
        yesBid: price[0],
        yesAsk: price[1],
        updatedAt: price[2],
        closeTime: closeTime ?? 0n,
      });
    });
    return out;
  }, [data, ids]);
}

// ---------------------------------------------------------------------------------------------
// Positions

type RawPosition = {
  owner: string;
  marketId: Hex;
  side: number;
  status: number;
  liquidated: boolean;
  margin: bigint;
  leverage: bigint;
  borrowed: bigint;
  cost: bigint;
  entryPrice: bigint;
  contracts: bigint;
  liqPrice: bigint;
  openedAt: bigint;
};

const toView = (id: bigint, p: RawPosition): PositionView => ({
  id,
  marketId: p.marketId,
  side: (p.side === 1 ? 1 : 0) as Side,
  status: p.status as Status,
  liquidated: p.liquidated,
  margin: p.margin,
  leverage: p.leverage,
  borrowed: p.borrowed,
  cost: p.cost,
  entryPrice: p.entryPrice,
  contracts: p.contracts,
  liqPrice: p.liqPrice,
  openedAt: p.openedAt,
});

export type PositionsState = {
  positions: PositionView[];
  loading: boolean;
  needsWallet: boolean; // live mode with no wallet connected
  closingId: bigint | null;
  error: string | null;
  close: (id: bigint, exitPrice: bigint) => Promise<void>;
};

function useDemoPositions(): PositionsState {
  const state = useDemoState();
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(async (id: bigint, exitPrice: bigint) => {
    setError(null);
    try {
      demo.close(id, exitPrice);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  return { positions: state.positions, loading: false, needsWallet: false, closingId: null, error, close };
}

function useLivePositions(): PositionsState {
  const { address } = useAccount();
  const config = useConfig();
  const queryClient = useQueryClient();
  const client = usePublicClient({ chainId });
  const [closingId, setClosingId] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idsQuery = useReadContract({
    abi: marginManagerAbi,
    address: contracts.marginManager,
    functionName: "positionsOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: Boolean(address), refetchInterval: POLL },
  });
  const ids = useMemo(() => (address ? [...(idsQuery.data ?? [])] : []), [address, idsQuery.data]);

  const posQuery = useReadContracts({
    contracts: ids.map(
      (id) =>
        ({
          abi: marginManagerAbi,
          address: contracts.marginManager,
          functionName: "getPosition",
          args: [id],
          chainId,
        }) as const,
    ),
    allowFailure: true,
    query: { enabled: ids.length > 0, refetchInterval: POLL },
  });

  // Exit price and payout for settled positions come from PositionSettled logs. Best effort: an
  // RPC that refuses the range just leaves those two fields blank.
  const closedIds = useMemo(
    () =>
      ids.filter((_, i) => (posQuery.data?.[i]?.result as RawPosition | undefined)?.status === STATUS.Closed),
    [ids, posQuery.data],
  );
  const settled = useQuery({
    queryKey: ["settled", address, closedIds.map(String).join(",")],
    enabled: Boolean(client) && closedIds.length > 0,
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      if (!client) return {};
      const logs = await client.getContractEvents({
        abi: marginManagerAbi,
        address: contracts.marginManager,
        eventName: "PositionSettled",
        args: { id: closedIds },
        fromBlock: contracts.deployBlock,
        toBlock: "latest",
      });
      const out: Record<string, { exitPrice: bigint; payout: bigint; settledDebt: bigint }> = {};
      for (const log of logs) {
        const a = log.args;
        if (a.id !== undefined && a.exitPrice !== undefined && a.payout !== undefined) {
          out[a.id.toString()] = {
            exitPrice: a.exitPrice,
            payout: a.payout,
            settledDebt: (a.repaid ?? 0n) + (a.loss ?? 0n),
          };
        }
      }
      return out;
    },
  });

  const positions = useMemo(() => {
    const out: PositionView[] = [];
    ids.forEach((id, i) => {
      const raw = posQuery.data?.[i]?.result as RawPosition | undefined;
      if (!raw || raw.status === STATUS.None) return;
      out.push({ ...toView(id, raw), ...settled.data?.[id.toString()] });
    });
    return out;
  }, [ids, posQuery.data, settled.data]);

  const close = useCallback(
    async (id: bigint) => {
      setError(null);
      setClosingId(id);
      try {
        const hash = await writeContract(config, {
          abi: marginManagerAbi,
          address: contracts.marginManager,
          functionName: "closePosition",
          args: [id],
          chainId,
        });
        await waitForTransactionReceipt(config, { hash, chainId });
        await queryClient.invalidateQueries();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setClosingId(null);
      }
    },
    [config, queryClient],
  );

  return {
    positions,
    loading: Boolean(address) && (idsQuery.isLoading || (ids.length > 0 && posQuery.isLoading)),
    needsWallet: !address,
    closingId,
    error,
    close,
  };
}

export const usePositions: () => PositionsState = isMock ? useDemoPositions : useLivePositions;

// ---------------------------------------------------------------------------------------------
// Opening a position

export type OpenPhase = "idle" | "approving" | "opening" | "pending" | "filled" | "error";
export type OpenArgs = {
  marketId: Hex;
  side: Side;
  margin: bigint;
  leverage: bigint;
  refPrice: bigint;
  fee: bigint; // open fee the contract pulls on top of the margin
};
export type OpenState = {
  phase: OpenPhase;
  error: string | null;
  position: PositionView | null; // the position being tracked, once it exists
  open: (args: OpenArgs) => Promise<void>;
  reset: () => void;
};

const phaseOf = (base: OpenPhase, position: PositionView | null): OpenPhase => {
  if (!position) return base;
  return position.status === STATUS.PendingOpen ? "pending" : "filled";
};

function useDemoOpen(): OpenState {
  const state = useDemoState();
  const [id, setId] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const position = id === null ? null : (state.positions.find((p) => p.id === id) ?? null);
  const open = useCallback(async (args: OpenArgs) => {
    setError(null);
    try {
      setId(demo.open(args));
    } catch (e) {
      setId(null);
      setError(errorMessage(e));
    }
  }, []);
  const reset = useCallback(() => {
    setId(null);
    setError(null);
  }, []);
  return { phase: error ? "error" : phaseOf("idle", position), error, position, open, reset };
}

function useLiveOpen(): OpenState {
  const { address } = useAccount();
  const config = useConfig();
  const queryClient = useQueryClient();
  const [base, setBase] = useState<OpenPhase>("idle");
  const [id, setId] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Poll the new position until the keeper's FillRecorded moves it from PendingOpen to Open.
  const tracked = useReadContract({
    abi: marginManagerAbi,
    address: contracts.marginManager,
    functionName: "getPosition",
    args: id !== null ? [id] : undefined,
    chainId,
    query: { enabled: id !== null, refetchInterval: 2_000 },
  });
  const position = id !== null && tracked.data ? toView(id, tracked.data as RawPosition) : null;

  const open = useCallback(
    async (args: OpenArgs) => {
      if (!address) return;
      setError(null);
      setId(null);
      try {
        const allowance = await readContract(config, {
          abi: erc20Abi,
          address: contracts.usdc,
          functionName: "allowance",
          args: [address, contracts.marginManager],
          chainId,
        });
        // openPosition pulls the margin plus the open fee, so the approval has to cover both.
        const needed = args.margin + args.fee;
        if (allowance < needed) {
          setBase("approving");
          const approveHash = await writeContract(config, {
            abi: erc20Abi,
            address: contracts.usdc,
            functionName: "approve",
            args: [contracts.marginManager, needed],
            chainId,
          });
          await waitForTransactionReceipt(config, { hash: approveHash, chainId });
        }
        setBase("opening");
        const hash = await writeContract(config, {
          abi: marginManagerAbi,
          address: contracts.marginManager,
          functionName: "openPosition",
          args: [args.marketId, args.side, args.margin, args.leverage],
          chainId,
        });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId });
        if (receipt.status !== "success") throw new Error("The transaction reverted.");
        const opened = parseEventLogs({ abi: marginManagerAbi, eventName: "PositionOpened", logs: receipt.logs });
        const newId = opened[0]?.args.id;
        if (newId === undefined) throw new Error("The position id was not found in the receipt.");
        setId(newId);
        setBase("pending");
        await queryClient.invalidateQueries();
      } catch (e) {
        setBase("error");
        setError(errorMessage(e));
      }
    },
    [address, config, queryClient],
  );

  const reset = useCallback(() => {
    setBase("idle");
    setId(null);
    setError(null);
  }, []);

  return { phase: phaseOf(base, position), error, position, open, reset };
}

export const useOpenPosition: () => OpenState = isMock ? useDemoOpen : useLiveOpen;

export function saveMarketMeta(marketId: Hex, meta: MarketMeta) {
  demo.saveMeta(marketId, meta);
}

// ---------------------------------------------------------------------------------------------
// Vault

export type VaultState = {
  loaded: boolean;
  totalAssets: bigint;
  totalBorrowed: bigint;
  available: bigint; // idle USDC that can be withdrawn or lent
  sharePrice: bigint; // USDC per share, 1e6 = 1.00
  userAssets: bigint; // the caller's share balance valued in USDC
  maxWithdraw: bigint;
  totalFees: bigint | undefined; // open fees paid into the vault so far; undefined when not readable
  userShares: bigint; // the caller's vault shares, in share units
  shareUnit: bigint; // one whole share (10 ** share decimals)
  busy: "deposit" | "withdraw" | "approve" | null;
  error: string | null;
  deposit: (assets: bigint) => Promise<boolean>;
  withdraw: (assets: bigint) => Promise<boolean>;
};

function useDemoVault(): VaultState {
  const state = useDemoState();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => void) => async () => {
    setError(null);
    try {
      fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };
  return {
    loaded: true,
    ...demoVaultFigures(state),
    busy: null,
    error,
    deposit: (assets) => run(() => demo.deposit(assets))(),
    withdraw: (assets) => run(() => demo.withdraw(assets))(),
  };
}

function useLiveVault(): VaultState {
  const { address } = useAccount();
  const config = useConfig();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<VaultState["busy"]>(null);
  const [error, setError] = useState<string | null>(null);
  const vault = { address: contracts.lendingVault, chainId } as const;

  const shared = useReadContracts({
    contracts: [
      { ...vault, abi: erc4626Abi, functionName: "totalAssets" },
      { ...vault, abi: lendingVaultAbi, functionName: "totalBorrowed" },
      { ...vault, abi: lendingVaultAbi, functionName: "availableLiquidity" },
      { ...vault, abi: erc20Abi, functionName: "decimals" },
    ],
    allowFailure: false,
    query: { refetchInterval: POLL },
  });
  // vUSDC has 12 decimals; the value is read from the vault, never assumed.
  const shareUnit = 10n ** BigInt(shared.data?.[3] ?? 12);

  const price = useReadContract({
    ...vault,
    abi: erc4626Abi,
    functionName: "convertToAssets",
    args: [shareUnit],
    query: { enabled: shared.data !== undefined, refetchInterval: POLL },
  });

  const mine = useReadContracts({
    contracts: address
      ? [
          { ...vault, abi: erc4626Abi, functionName: "balanceOf", args: [address] },
          { ...vault, abi: erc4626Abi, functionName: "maxWithdraw", args: [address] },
        ]
      : [],
    allowFailure: false,
    query: { enabled: Boolean(address), refetchInterval: POLL },
  });
  const userShares = (address ? (mine.data?.[0] as bigint | undefined) : undefined) ?? 0n;
  const maxWithdraw = (address ? (mine.data?.[1] as bigint | undefined) : undefined) ?? 0n;
  const sharePrice = price.data ?? 1_000_000n;

  // Read on its own: a vault deployed before the open fee existed has no such function, and
  // that must not take the other figures down with it.
  const fees = useReadContract({
    ...vault,
    abi: lendingVaultAbi,
    functionName: "totalFeesCollected",
    query: { refetchInterval: POLL, retry: false },
  });

  const send = useCallback(
    async (kind: "deposit" | "withdraw", assets: bigint) => {
      if (!address) return false;
      setError(null);
      try {
        if (kind === "deposit") {
          const allowance = await readContract(config, {
            abi: erc20Abi,
            address: contracts.usdc,
            functionName: "allowance",
            args: [address, contracts.lendingVault],
            chainId,
          });
          if (allowance < assets) {
            setBusy("approve");
            const approveHash = await writeContract(config, {
              abi: erc20Abi,
              address: contracts.usdc,
              functionName: "approve",
              args: [contracts.lendingVault, assets],
              chainId,
            });
            await waitForTransactionReceipt(config, { hash: approveHash, chainId });
          }
        }
        setBusy(kind);
        const hash =
          kind === "deposit"
            ? await writeContract(config, {
                ...vault,
                abi: erc4626Abi,
                functionName: "deposit",
                args: [assets, address],
              })
            : await writeContract(config, {
                ...vault,
                abi: erc4626Abi,
                functionName: "withdraw",
                args: [assets, address, address],
              });
        const receipt = await waitForTransactionReceipt(config, { hash, chainId });
        if (receipt.status !== "success") throw new Error("The transaction reverted.");
        await queryClient.invalidateQueries();
        return true;
      } catch (e) {
        setError(errorMessage(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [address, config, queryClient],
  );

  return {
    loaded: shared.data !== undefined,
    totalAssets: shared.data?.[0] ?? 0n,
    totalBorrowed: shared.data?.[1] ?? 0n,
    available: shared.data?.[2] ?? 0n,
    sharePrice,
    userAssets: (userShares * sharePrice) / shareUnit,
    maxWithdraw,
    totalFees: fees.data,
    userShares,
    shareUnit,
    busy,
    error,
    deposit: (assets) => send("deposit", assets),
    withdraw: (assets) => send("withdraw", assets),
  };
}

export const useVault: () => VaultState = isMock ? useDemoVault : useLiveVault;
