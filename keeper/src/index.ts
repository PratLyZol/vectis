// Vectis keeper. One wallet acts as oracle poster and executor.
//
// Startup
//   1. Load ../.env and addresses.json (exits if the contracts are not deployed yet).
//   2. Build the chain from the RPC's chain id, check poster/executor roles, approve USDC to the
//      MarginManager once (profitable closes pull the difference from the executor).
//   3. Pick markets from Gemini (or KEEPER_SYMBOLS), add back any market that still has an active
//      position, and registerMarket where needed.
//
// Loops (each catches its own errors and keeps going; all writes share one nonce-managed queue)
//   - price    every KEEPER_POLL_MS: fetch Gemini books (oldest first, within the 1 request/s
//              budget), post changed quotes in one postPrices batch, and re-post every market and
//              combo before KEEPER_HEARTBEAT_MS elapses.
//   - stream   every KEEPER_STREAM_POLL_MS (only if VECTIS_APP_URL is set): poll the web app's
//              QuickNode Streams activity feed; PositionOpened / PositionClosed /
//              PositionLiquidated trigger execution at once. Primary trigger when available.
//   - events   every 2 s: getLogs cursor over the MarginManager (small ranges, HTTP polling);
//              same triggers, same handler. Fallback that always runs.
//   - combos   every KEEPER_COMBO_POLL_MS: read the web app's combo registry, keep the newest
//              requested combos plus any with an active position, register them. Combos are
//              priced in the price loop from their legs' books and their fills are always simulated.
//   - sweep    every KEEPER_POLL_MS: read activePositionIds, execute anything still PendingOpen or
//              PendingClose (restart safety), and liquidate Open positions that isLiquidatable.
//
// Execution: a Gemini order (live mode) or a simulated fill at the book price (mock mode, or an
// explicit fallback when the sandbox rejects or does not fill), then recordFill on-chain.
import { encodeFunctionData, erc20Abi, formatUnits, maxUint256, type Hex } from "viem";
import { marginManagerAbi, priceOracleAbi } from "./abis.js";
import { TxQueue, createClients } from "./chain.js";
import { ComboRegistry } from "./combos.js";
import { ConfigError, loadConfig } from "./config.js";
import { Executor } from "./executor.js";
import { GeminiPublic, type GeminiEvent } from "./gemini/public.js";
import { GeminiTrade } from "./gemini/trade.js";
import { errText, logger } from "./log.js";
import { findSymbols, selectMarkets, type TrackedMarket } from "./markets.js";
import { marketIdOf } from "./math.js";
import { OracleFeed, booksPerCycle, maxDistinctBooks } from "./oracle.js";
import { KeeperState } from "./state.js";
import { StreamWatcher } from "./stream.js";

const log = logger("keeper");
const EVENT_POLL_MS = 2000;

let stopping = false;
const wakers = new Set<() => void>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakers.add(done);
  });
}

async function runLoop(name: string, intervalMs: number, fn: () => Promise<void>): Promise<void> {
  const loopLog = logger(name);
  while (!stopping) {
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      loopLog.error("cycle failed", { err: errText(err) });
    }
    if (stopping) break;
    await sleep(Math.max(250, intervalMs - (Date.now() - started)));
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const { addresses } = cfg;

  const clients = await createClients(cfg.rpcUrl, cfg.privateKey);
  const { publicClient, account, chain } = clients;
  if (chain.id !== addresses.chainId) {
    throw new ConfigError(
      `RPC chain id ${chain.id} does not match addresses file chain id ${addresses.chainId} (${cfg.addressesFile})`,
    );
  }

  log.info("starting", { chain: chain.name, chainId: chain.id, keeper: account.address });
  log.info(
    cfg.mock
      ? "MOCK MODE: no GEMINI_API_KEY set, fills are simulated at the Gemini book price"
      : "LIVE MODE: orders go to the Gemini trade API, with simulated fallback when nothing fills",
    { tradeBase: cfg.mock ? undefined : cfg.geminiTradeBase },
  );

  const code = await publicClient.getCode({ address: addresses.marginManager });
  if (!code || code === "0x") {
    throw new ConfigError(`no contract code at marginManager ${addresses.marginManager} on chain ${chain.id}`);
  }

  const [isPoster, executor, gasBalance, usdcBalance, allowance] = await Promise.all([
    publicClient.readContract({
      address: addresses.priceOracle,
      abi: priceOracleAbi,
      functionName: "isPoster",
      args: [account.address],
    }),
    publicClient.readContract({ address: addresses.marginManager, abi: marginManagerAbi, functionName: "executor" }),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: addresses.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
    publicClient.readContract({
      address: addresses.usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, addresses.marginManager],
    }),
  ]);
  log.info("balances", { gas: formatUnits(gasBalance, 18), usdc: formatUnits(usdcBalance, 6) });
  if (!isPoster) log.error("keeper wallet is NOT an oracle poster; postPrices will revert");
  if (executor.toLowerCase() !== account.address.toLowerCase()) {
    log.error("keeper wallet is NOT the MarginManager executor; recordFill will revert", { executor });
  }

  const queue = new TxQueue(clients);
  if (allowance < maxUint256 / 2n) {
    log.info("approving USDC to MarginManager (max)");
    await queue.send(
      "approve USDC",
      addresses.usdc,
      encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addresses.marginManager, maxUint256] }),
    );
  }

  const gemini = new GeminiPublic(cfg.geminiPublicBase);
  const trade = cfg.mock ? null : new GeminiTrade(cfg.geminiTradeBase, cfg.geminiApiKey, cfg.geminiApiSecret);
  const state = new KeeperState(cfg.stateFile, `${chain.id}:${addresses.marginManager.toLowerCase()}`);
  const feed = new OracleFeed(clients, queue, gemini, addresses.priceOracle, cfg.pollMs, cfg.heartbeatMs);
  const exec = new Executor(clients, queue, feed, state, trade, addresses.marginManager, addresses.priceOracle);

  const stream = cfg.appUrl
    ? new StreamWatcher(cfg.appUrl, cfg.streamPollMs, addresses.marginManager, state, (t) => exec.trigger(t.positionId))
    : null;
  log.info(
    stream
      ? `events: QuickNode Stream feed at ${cfg.appUrl} (RPC polling as fallback)`
      : "events: RPC polling only (VECTIS_APP_URL not set)",
  );

  // Take the log cursor before anything else so no event between here and the first sweep is lost.
  await exec.initCursor();

  // Markets that still carry positions must stay priced even if selection changes across restarts.
  const carried: string[] = [];
  for (const marketId of await exec.activeMarketIds()) {
    const symbol = state.symbolOf(marketId);
    if (symbol) carried.push(symbol);
    else if (state.comboOf(marketId)) continue; // combos are carried by the combo registry below
    else log.warn("active position on a market with no known symbol; using on-chain prices for it", { marketId });
  }

  const markets = await chooseMarkets(gemini, cfg.symbols, carried, cfg.marketCount, cfg.scanEvents);
  if (markets.length === 0) log.warn("no markets selected; the keeper will only execute and liquidate");
  state.rememberSymbols(markets.map((m) => ({ marketId: marketIdOf(m.symbol), symbol: m.symbol })));
  await feed.addMarkets(markets);
  for (const m of markets) {
    log.info("tracking", {
      symbol: m.symbol,
      closes: m.closeTime ? new Date(m.closeTime * 1000).toISOString() : "unknown",
      market: `"${m.title} / ${m.label}"`,
    });
  }

  // Combos: definitions come from the web app's registry; prices are derived from the legs' books.
  const maxBooks = maxDistinctBooks(cfg.pollMs, cfg.heartbeatMs);
  const combos = new ComboRegistry(
    cfg.appUrl || null,
    cfg.comboCount,
    maxBooks,
    state,
    feed,
    () => exec.activeMarkets(),
  );
  if (markets.length > maxBooks) {
    log.warn("more single markets than the price loop can refresh inside the oracle window; some prices will go stale", {
      markets: markets.length,
      maxBooks,
      booksPerCycle: booksPerCycle(cfg.pollMs),
    });
  } else if (cfg.appUrl && markets.length + cfg.comboCount * 2 > maxBooks) {
    log.warn("book budget is tight: fewer than KEEPER_COMBO_COUNT combos may be tracked", {
      markets: markets.length,
      comboCount: cfg.comboCount,
      maxBooks,
    });
  }
  await combos.tick();
  const comboCount = combos.tracked.length;
  if (cfg.appUrl) {
    log.info(`combos: enabled, tracking ${comboCount} (max ${cfg.comboCount}, book budget ${maxBooks}) from ${cfg.appUrl}`);
  } else {
    log.info(
      comboCount > 0
        ? `combos: disabled (VECTIS_APP_URL not set); still pricing ${comboCount} with active positions from saved state`
        : "combos: disabled (VECTIS_APP_URL not set)",
    );
  }

  // Prices first so the startup sweep sees a fresh oracle, then the steady-state loops.
  try {
    await feed.prime();
  } catch (err) {
    log.error("initial price cycle failed", { err: errText(err) });
  }
  log.info("running", { pollMs: cfg.pollMs, heartbeatMs: cfg.heartbeatMs, markets: markets.length });

  await Promise.all([
    runLoop("sweep", cfg.pollMs, () => exec.sweep()),
    sleep(cfg.pollMs).then(() => runLoop("price", cfg.pollMs, () => feed.cycle())),
    runLoop("events", EVENT_POLL_MS, () => exec.pollEvents()),
    stream ? runStream(stream) : Promise.resolve(),
    sleep(cfg.comboPollMs).then(() => runLoop("combos", cfg.comboPollMs, () => combos.tick())),
  ]);

  // Let an in-flight transaction settle so its nonce is not left dangling.
  await Promise.race([queue.drain(), new Promise((r) => setTimeout(r, 8000))]);
  log.info("stopped");
}

/** Stream feed loop: the watcher picks its own delay (poll interval, or 10 s while unavailable). */
async function runStream(stream: StreamWatcher): Promise<void> {
  while (!stopping) {
    const waitMs = await stream.tick();
    if (stopping) break;
    await sleep(waitMs);
  }
}

async function chooseMarkets(
  gemini: GeminiPublic,
  explicit: string[],
  carried: string[],
  count: number,
  scanEvents: number,
): Promise<TrackedMarket[]> {
  const wanted = new Set([...explicit, ...carried]);
  const allFound = (events: GeminiEvent[]) => findSymbols(events, wanted).size === wanted.size;
  log.info("scanning Gemini events", { maxEvents: scanEvents, explicit: explicit.length, carried: carried.length });
  let events: GeminiEvent[] = [];
  try {
    // With an explicit list we can stop as soon as every symbol is found; otherwise scan it all.
    events = await gemini.scanEvents(scanEvents, 25, explicit.length > 0 ? allFound : undefined);
  } catch (err) {
    log.error("event scan failed", { err: errText(err) });
  }

  const found = findSymbols(events, wanted);
  const out = new Map<string, TrackedMarket>();
  if (explicit.length > 0) {
    for (const symbol of explicit) {
      const m = found.get(symbol);
      if (m) out.set(symbol, m);
      else log.warn("KEEPER_SYMBOLS entry not found in scanned events (raise KEEPER_SCAN_EVENTS?)", { symbol });
    }
  } else {
    for (const m of selectMarkets(events, { count, nowMs: Date.now() })) out.set(m.symbol, m);
  }
  for (const symbol of carried) {
    if (out.has(symbol)) continue;
    // Not in the scan: still track it (already registered on-chain), close time unknown.
    out.set(symbol, found.get(symbol) ?? { symbol, eventTicker: "", title: "(carried position)", label: "", closeTime: 0 });
  }
  return [...out.values()];
}

function shutdown(signal: string): void {
  if (stopping) {
    log.warn("second signal, exiting now");
    process.exit(1);
  }
  stopping = true;
  log.info(`${signal} received, shutting down`);
  for (const wake of [...wakers]) wake();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { err: errText(reason) }));
process.on("uncaughtException", (err) => log.error("uncaught exception", { err: errText(err) }));

main().then(
  () => process.exit(0),
  (err) => {
    if (err instanceof ConfigError) log.error(err.message);
    else log.error("fatal", { err: errText(err) });
    process.exit(1);
  },
);
