# Vectis

Leveraged trading on Gemini Prediction Markets, settled in USDC on Arc testnet.

A trader posts USDC margin, borrows the rest from a lending vault, and takes a leveraged Yes or No
position on a Gemini prediction-market contract (or a combo of several). A keeper mirrors the
position on Gemini, reports fills on-chain, posts prices and liquidates. Position events flow
through a QuickNode Stream into a live activity feed and back to the keeper.

- **Web app:** https://vectis-mauve.vercel.app
- **Chain:** Arc testnet, chain id `5042002`, explorer https://explorer.testnet.arc.io
- **Contracts:** see [Deployed addresses](#deployed-addresses)

> Testnet only. Hackathon MVP. Not audited. Do not use with real funds.

## Architecture

```
                         Gemini (public data, production)            Gemini sandbox
                         /v1/prediction-markets/events, /combos      /v1/prediction-markets/order
                         /v1/book/{symbol}                           (only with API keys)
                               |                |                          ^
                 cached proxy  |                | books, every 10 s        | signed orders
                               v                v                          |
  Browser  <---->  Web (Next.js on Vercel)     Keeper (Node, runs locally) -+
  wagmi/viem       /api/markets, /api/book       - posts bid/ask to PriceOracle
     |             /api/combos                   - fills opens/closes, calls recordFill
     |             /api/qn-stream  <---+         - liquidates and deleverages
     |             /api/activity  ----+|-------> - reads the stream feed for triggers
     |                  |              |
     |                  v              |  signed webhook (HMAC-SHA256)
     |             Neon Postgres       |
     |             stream_events,      +--- QuickNode Stream (Arc testnet, logs dataset,
     |             combos                   filtered to MarginManager + LendingVault,
     |                                      backfilled from the deploy block)
     v                                                    ^
  Arc testnet ------------------------------------------- | contract logs
    PriceOracle      keeper-posted best bid/ask per market, 60 s staleness limit
    LendingVault     ERC-4626 over USDC; only MarginManager can borrow and repay
    MarginManager    openPosition, recordFill, closePosition, liquidate
```

### Position lifecycle

```
openPosition  -> PendingOpen   PositionOpened      keeper buys on Gemini (or simulates)
recordFill    -> Open          FillRecorded        entry price, contracts, liquidation price set
closePosition -> PendingClose  PositionClosed      keeper sells
liquidate     -> PendingClose  PositionLiquidated  mark crossed liq price, or final-hour deleverage
recordFill    -> Closed        PositionSettled     vault repaid first, remainder to the trader
```

### Rules

| Rule | Value |
| --- | --- |
| Max leverage | `min(5, price / 0.12)` rounded down to 0.5, never below 1x |
| Liquidation price | borrowed per contract + $0.04 |
| Final hour before close | max leverage 1x; leveraged positions can be closed out by the keeper |
| Oracle staleness | prices older than 60 s are rejected |
| Open fee | 1% of the borrowed amount, paid by the trader on top of margin at open, sent to the vault |
| Open price / mark price | the side's ask / the side's bid (No = 1 − Yes) |

Units on-chain: USDC 6 decimals; prices `1e6` = $1.00; contract quantities 6 decimals; leverage in
tenths (`30` = 3x); `marketId = keccak256(instrumentSymbol)`.

### Combos

Gemini combos have their own symbol but almost never have a resting order book (they fill through a
private quote auction in the Gemini app), so Vectis prices a combo from its legs:
combo bid = product of the legs' bids, combo ask = product of the legs' asks. A combo's on-chain
close time is its **earliest** leg expiry, so leverage steps down to 1x before any leg can resolve.
Combos can be picked from Gemini's active list or built from 2 to 6 legs in different events.
Combo fills are always simulated at the leg-derived price.

### QuickNode Streams

One stream (`logs` dataset on Arc testnet) runs a filter that keeps only logs from the
MarginManager and LendingVault and skips empty batches. It posts to `/api/qn-stream`, which verifies
the `X-QN-Signature` HMAC, decodes the events and stores them idempotently in Postgres. The stream
backfills from the deploy block, so the feed holds the full history. `/api/activity` serves the
feed to the UI and to the keeper, which uses it as its primary trigger and falls back to RPC polling.

### Hedge agent

`/hedge` turns a plain-English description of any exposure into proposed positions. The exposure
can be a position (long or short), a loan, a business cost or revenue, or a holding in any market.
The holder can be anyone, from a laundromat paying for natural gas to a fund short copper miners.
`/api/hedge` runs a tool loop on Venice AI (OpenAI-compatible, through the `openai` client). The
tools are read-only: list categories, search markets, read an event, read the book and preview a
position. The model ends by asking one clarifying question or by calling `propose_hedge`. Each
proposed leg is direct or a proxy (for example cold-weather or Brent buckets as a stand-in for
natural gas) and comes with a rationale and a basis-risk note.

The server checks every leg against fresh Gemini data before it reaches the browser
(`web/src/lib/hedge/validate.ts`): the symbol must exist and be open, prices are recomputed, and
leverage is clamped to the contract's `maxLeverage`. The user can edit side, margin and leverage,
remove legs, or ask the agent to revise. The positions open only after a review step with an
explicit acknowledgement. If any price moves by more than 3 cents before the user confirms, the
review must be confirmed again. `useOpenBatch` then sends one USDC approval and opens the legs in
order. If a leg fails, the user can retry the legs that remain.

## Repository layout

```
contracts/   Foundry project: PriceOracle, LendingVault, MarginManager, tests, Deploy script
keeper/      Node + TypeScript keeper (runs locally, not on Vercel)
web/         Next.js App Router app (deployed to Vercel)
scripts/     export-abis.mjs (ABIs to web and keeper), stream.mjs (QuickNode Streams REST)
```

## Deployed addresses

<!-- ADDRESSES -->
Arc testnet, deployed at block `72414505`:

| Contract | Address |
| --- | --- |
| PriceOracle | [`0x30889d3459cA3bDa2aaBeb9516f11C58940a94BB`](https://explorer.testnet.arc.io/address/0x30889d3459cA3bDa2aaBeb9516f11C58940a94BB) |
| LendingVault (vUSDC) | [`0x6F11b4aCEC5815dACf6cbED8d189a8a647781E52`](https://explorer.testnet.arc.io/address/0x6F11b4aCEC5815dACf6cbED8d189a8a647781E52) |
| MarginManager | [`0xEe5D6bc01535383406E8395f7D3209012D5eBfb4`](https://explorer.testnet.arc.io/address/0xEe5D6bc01535383406E8395f7D3209012D5eBfb4) |
| Deployer / executor / poster | `0x1Ac6aE1bF55f5d6A548161A7E2bea4208A78507e` |

The deploy script's vault seeding step is skipped on Arc (`SEED_VAULT_USDC=0`): stock Foundry
cannot simulate Arc's USDC blocklist precompile locally, so the seed deposit was sent separately
with `cast send`.
This is the second deployment: the contracts were redeployed to add the open fee. The first
deployment (MarginManager `0xcb417122b26C44B1aB7f814b251B74707dc36b15`) is no longer used.
<!-- /ADDRESSES -->

USDC on Arc testnet is `0x3600000000000000000000000000000000000000` (ERC-20 view, 6 decimals).

## Running it

### Contracts

```bash
cd contracts
forge test                      # 104 tests: unit, fuzz on liquidation math, vm.warp pre-expiry
set -a; source ../.env; set +a
forge script script/Deploy.s.sol --rpc-url https://rpc.testnet.arc.io --broadcast
node ../scripts/export-abis.mjs # only if the interfaces change
```

The deploy script writes `web/src/config/addresses.ts` and `keeper/addresses.json`.
Local chain: add `DEPLOY_MOCK_USDC=true SEED_VAULT_USDC=50000000000` and point `--rpc-url` at anvil.

### Keeper

```bash
cd keeper
pnpm install
pnpm start        # loads ../.env
```

It selects the most active Gemini contracts, registers them on the oracle, posts prices when they
change (and at least every 45 s), fills pending opens and closes, and liquidates. With no
`GEMINI_API_KEY` it runs in **mock mode** and simulates fills at the Gemini book price. Stop it when
you are not demoing: every price post costs gas.

### Web

```bash
cd web
pnpm install
pnpm dev          # http://localhost:3000
```

With zero addresses in `src/config/addresses.ts` the app runs in demo mode on a local store.

### QuickNode Stream

```bash
node scripts/stream.mjs test      # run the filter against the deploy block
node scripts/stream.mjs create    # create the stream, backfilled from the deploy block
node scripts/stream.mjs list
```

## Environment variables

Root `.env` (git-ignored; see `.env.example`):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DEPLOYER_PRIVATE_KEY` | contracts, keeper | Testnet wallet: deployer, oracle poster and executor |
| `ARC_RPC_URL` | keeper | Default `https://rpc.testnet.arc.io` |
| `GEMINI_PUBLIC_BASE` | keeper, web | Public market data, default `https://api.gemini.com` |
| `GEMINI_TRADE_BASE` | keeper | Order placement, default `https://api.sandbox.gemini.com` |
| `GEMINI_API_KEY`, `GEMINI_API_SECRET` | keeper | Optional. Empty = mock mode |
| `KEEPER_MARKET_COUNT`, `KEEPER_POLL_MS`, `KEEPER_HEARTBEAT_MS` | keeper | Tracked markets, poll interval, forced re-post interval |
| `KEEPER_SYMBOLS`, `KEEPER_SCAN_EVENTS` | keeper | Optional explicit symbols; events scanned at startup |
| `VECTIS_APP_URL` | keeper, scripts | Deployed web URL: stream feed, combo registry, webhook target |
| `KEEPER_STREAM_POLL_MS`, `KEEPER_COMBO_POLL_MS`, `KEEPER_COMBO_COUNT` | keeper | Stream feed and combo tuning |
| `QUICKNODE_API_KEY` | scripts | Creates and manages the stream |
| `QN_STREAM_SECURITY_TOKEN` | scripts, web | Webhook signing secret |
| `DATABASE_URL` | web | Neon Postgres (stream events, combo registry) |
| `VENICE_API_KEY`, `VENICE_MODEL` | web | Hedge agent. Without the key `/api/hedge` returns 503. The model defaults to `kimi-k3` and must support function calling |

Vercel (production, server only): `GEMINI_PUBLIC_BASE`, `DATABASE_URL`, `QN_STREAM_SECURITY_TOKEN`,
`VENICE_API_KEY` (and optionally `VENICE_MODEL`).
No Gemini key, private key or `NEXT_PUBLIC_` secret is ever used by the web app.

## Known limits

- **Custodial executor.** One wallet is deployer, oracle poster and executor. It decides fill
  prices, and profitable closes are paid from its balance. A real system needs proof of execution.
- **Testnet only.** Arc testnet, faucet USDC, unaudited contracts.
- **Sandbox orders.** Orders target the Gemini sandbox, which lists few markets with thin books,
  so the keeper falls back to a simulated fill when the sandbox cannot fill. By default (no keys)
  every fill is simulated. Oracle prices and UI data come from Gemini **production** public data,
  so sandbox fills and oracle prices describe different books.
- **Combos are simulated.** Priced from legs, never sent to Gemini. The product ignores correlation
  between legs, which is why two legs from one event or one game are not allowed.
- **Lender yield is a flat fee.** Lenders earn a 1% open fee on every borrowed dollar, which raises
  the vault share price. There is no time-based borrow interest, so a loan held for a month pays
  the same as one held for a minute, and the fee is not sized to the bad-debt risk lenders bear.
  The fee is charged on the requested borrow and is not refunded if the fill uses less. It accrues
  to the share price at once, so a deposit made just before a large open shares in that fee.
- **No cancel for a pending open.** If the keeper is down, a position waits in PendingOpen with its
  margin locked until the keeper returns.
- **Gap risk.** The $0.04 buffer does not protect against a price that jumps past the liquidation
  price; the shortfall is written off against vault depositors.
- **Trusted oracle.** A single poster; no aggregation or dispute path.
- **Keeper gas.** Posting prices costs testnet USDC continuously while it runs.

## Assumptions made

- "Rounded down to 0.5" floors at 1x: below $0.12 a market is still tradable unleveraged. 1x
  positions borrow nothing and cannot be liquidated.
- "Steps down to 1x in the final hour" means new positions are capped at 1x and existing leveraged
  positions can be closed out by anyone through `liquidate` (reason 1), with no penalty.
- Position funds stay in the MarginManager; the executor settles the PnL difference at close.
- Unit tests use a 6-decimal mock USDC because a stock local EVM cannot emulate Arc's native USDC.
  All contract math uses the ERC-20 (6-decimal) view, never the 18-decimal native balance.
- OpenZeppelin is pinned to v5.4.0 (v5.7.0 needs a newer compiler and Osaka-only opcodes).
- Vault shares (vUSDC) have 12 decimals (6-decimal offset against the first-depositor attack).
- No git repository was initialised (not requested). `.gitignore` still protects `.env`.
- Stock Foundry is used for deployment, as Arc's docs allow; Arc Foundry was not needed.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Landing page: live trade panel on a real market, live numbers, how it works |
| `/markets` | Market grid with search, category filter and the live activity feed |
| `/market/[ticker]` | Order book and trade panel for one event |
| `/combos`, `/combo/[symbol]` | Gemini combos, the combo builder, and a combo trade page |
| `/portfolio` | Your positions, with distance to liquidation |
| `/vault` | Deposit and withdraw USDC as a lender |
| `/lend` | Lender entry point: how lenders earn, the risks, live vault numbers, first deposit |
| `/hedge` | Hedge agent: describe an exposure, edit the proposed legs, then confirm to open them |
| `/replay` | Replay a hypothetical leveraged position on a market's real one-minute Gemini price history, to a gain or a liquidation. Uses the contract rules for leverage cap, fee and liquidation price. Five histories are saved in `web/src/lib/fixtures-replays.json` so they replay after Gemini drops them; any live market replays from its page. Entries and exits use bar closes with no spread, and the final-hour step-down is not modelled |
| `/api/markets`, `/api/markets/[ticker]`, `/api/book/[symbol]` | Cached server-side proxies for Gemini public data |
| `/api/combos`, `/api/combos/[symbol]` | Combo list, registry and leg-derived prices |
| `/api/qn-stream`, `/api/activity` | QuickNode Streams webhook and the event feed |
| `/api/hedge` | Hedge agent (POST): conversation in, a question or a validated proposal out |

With zero addresses in `web/src/config/addresses.ts` every page runs on demo data.

## Design

Black and white UI: black ground (`#000000`), near-black surfaces (`#0A0A0A`, `#1A1A1A`), white text
and white for Yes, primary actions and gains. No, liquidation and losses are mid-grey (`#A6A6A6`), so
they are told apart by label, sign and fill, not hue. Host Grotesk for text, set light to medium with no bold, and Geist Mono for data. All colours
are Tailwind theme tokens. This replaced the palette and fonts in the original brief at the
user’s request. Corners are square throughout, and every control is at least 44px tall.
The landing hero sits on an interactive tile grid that lights up under the cursor.

Components follow the `design-taste-frontend` skill adapted to an app: one button pair, one card
style, equal content edges, its hover and press motion, its copy rules, and its accessibility
checks. Skipped because they only fit a marketing site built from its kit: static export, dealt
palette and fonts, its asset kit and starter, shader scenes, photographs, and its finish gate.

Presentation-only items from the UI spec that have no backing feature: the Sell tab links to the
portfolio (selling means closing a position), the order type is a fixed "Market" label, "Add
margin" is disabled (the contract has no such function), the vault shows the open-fee rate and fees earned in place of a
Supply APR (there is no history to annualise), and there is no price chart (no price history is stored).
