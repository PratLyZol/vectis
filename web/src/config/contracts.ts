import { zeroAddress, type Address } from "viem";
import { addresses } from "./addresses";

// addresses.ts is rewritten by the deploy script with literal types, so widen before comparing.
const marginManager: string = addresses.marginManager;

/** Mock mode: contracts are not deployed, the app runs on a local demo store. */
export const isMock = marginManager.toLowerCase() === zeroAddress;

export const contracts = {
  chainId: addresses.chainId as number,
  usdc: addresses.usdc as Address,
  priceOracle: addresses.priceOracle as Address,
  lendingVault: addresses.lendingVault as Address,
  marginManager: addresses.marginManager as Address,
  deployBlock: BigInt(addresses.deployBlock),
};
