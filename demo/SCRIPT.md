# Vectis demo video: script and shot list

Target length: 2:00 to 2:30. Screen recording at 1440×900 with voiceover. One take per shot,
cut together. Tracks this is aimed at: DeFi and Onchain Applications, Best use of Arc, the Gemini
Prediction Markets bounty, and (once the stream exists) Best Use of QuickNode Streams.

## Before recording

- [ ] Keeper running in a visible terminal: `cd keeper && pnpm start` (one instance).
- [ ] Browser wallet on Arc testnet (chain id 5042002) with faucet USDC, connected to the site.
- [ ] Vault has liquidity (currently 8 USDC, so keep margins small: 1 to 2 USDC).
- [ ] One position already open from an earlier take, so the portfolio is not empty.
- [ ] Explorer tab open on the MarginManager:
      https://explorer.testnet.arc.io/address/0xEe5D6bc01535383406E8395f7D3209012D5eBfb4
- [ ] QuickNode stream created, so the feed caption "Live from QuickNode Streams" is true on camera.
      If the stream does not exist yet, cut shot 6's stream line and say "live on-chain activity".
- [ ] Hide bookmarks bar, close other tabs, 100% zoom, do-not-disturb on.

## Shots

| # | Time | On screen | Voiceover |
|---|------|-----------|-----------|
| 1 | 0:00–0:12 | Landing page hero. Move the cursor across the tile grid, then rest on the trade panel. | "Prediction markets let you bet on outcomes, but only with the cash you put in. Vectis adds leverage: up to five times, on real Gemini prediction markets, settled in USDC on Arc." |
| 2 | 0:12–0:30 | Click "Open markets". Scroll the grid; hover a card to show Yes/No prices and "Up to 3.5x". Click Yes on a market. | "These are live Gemini markets, with live prices. Each one shows how much leverage it allows. The cheaper the contract, the less you can borrow: max leverage is the price divided by twelve cents, capped at five." |
| 3 | 0:30–0:55 | Market page. Order book on the left. In the trade panel: type a margin, tap 2x then 3x, watch position size, borrowed and liquidation price change. Click "Buy Yes at 3x", approve and confirm in the wallet. | "I post one dollar of margin and pick three times. Vectis borrows the other two from a USDC lending vault. Before I confirm, I can see my size, what I'm borrowing, and exactly where I'd be liquidated: what I borrowed per contract, plus a four cent buffer." |
| 4 | 0:55–1:15 | Split view or cut to the keeper terminal: the `PositionOpened` trigger line and the fill line. Back to the site: status goes Pending open → Open. | "A keeper picks up the position, executes it against the Gemini book, and reports the fill on-chain. Arc finalises in under a second and gas is paid in USDC, so the whole loop takes a couple of seconds and costs a fraction of a cent." |
| 5 | 1:15–1:35 | Portfolio. Point at the stats strip and the distance-to-liquidation bar. Click "Sell", confirm, watch it settle. | "My portfolio shows entry, current price, PnL and how far I am from liquidation. If the market moves against me, the keeper liquidates; in the last hour before a market closes, leverage steps down to one times. Closing repays the vault first, and I keep the rest." |
| 6 | 1:35–1:50 | Markets page activity feed updating; then the explorer tab showing the same transactions. | "Every event is streamed from Arc through QuickNode Streams into this live feed, and the keeper reacts to the same stream. Everything you see here is a real transaction on Arc testnet." |
| 7 | 1:50–2:08 | Combos page. Open the builder, add two legs from different games, show the combined price and max leverage. Open a listed Gemini combo. | "Vectis also handles combos. Pick legs from different events and Vectis prices the combo from its legs, since Gemini's combo books are usually empty, then lets you lever it the same way." |
| 8 | 2:08–2:20 | Vault page: total deposits, lent to traders bar, deposit button. | "On the other side, anyone can supply USDC to the vault that funds these positions. Lenders earn one percent of every dollar borrowed, paid when a position opens. It's a standard ERC-4626 vault, and only the margin contract can borrow from it." |
| 8b | optional, 20s | Replay page. Market "BTC price at 7pm EST". Click "Show a liquidation", let it run, then "Show a gain". | "This replays a position on real Gemini prices. Here a three and a half times Yes is liquidated at 34 cents, and the market then finishes at 95. Same market, different entry: a gain. Leverage means you have to be right the whole way, not just at the end." |
| 9 | 2:20–2:30 | Back to the landing hero, then the "built on" row. | "Vectis: leverage for prediction markets. Built on Arc, Gemini Prediction Markets and QuickNode Streams." |

## What to say honestly if a judge asks

- Fills are simulated at the live Gemini book price unless sandbox API keys are added; the signed
  order path is built but has not been run against the sandbox.
- Combo fills are always simulated: Gemini fills combos by private quote request.
- The executor is custodial and the oracle has one poster. Testnet only, unaudited.
- Lenders earn a flat 1% open fee on borrowed funds. There is no time-based interest, and the fee
  is not sized to the gap risk lenders carry.

## Assets still to capture

- [ ] Shots 1, 2, 7, 8, 9: no wallet needed; can be recorded any time the site is up.
- [ ] Shots 3, 4, 5: need the keeper running and a funded wallet.
- [ ] Shot 6: needs the QuickNode stream.
- [ ] Voiceover: record after the cut is locked, or generate it (an ElevenLabs voice would also
      qualify the project for that bounty, if wanted).
