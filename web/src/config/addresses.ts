// Written by contracts/script/Deploy.s.sol. Zero addresses mean "not deployed": the UI runs on mock data.
export const addresses = {
  chainId: 5042002,
  usdc: "0x3600000000000000000000000000000000000000",
  priceOracle: "0x30889d3459cA3bDa2aaBeb9516f11C58940a94BB",
  lendingVault: "0x6F11b4aCEC5815dACf6cbED8d189a8a647781E52",
  marginManager: "0xEe5D6bc01535383406E8395f7D3209012D5eBfb4",
  deployBlock: 72414505,
} as const;
