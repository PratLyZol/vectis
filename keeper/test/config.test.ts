import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, PACKAGE_ROOT, loadConfig } from "../src/config.js";

// A throwaway, well-formed key that controls nothing. An explicit env object never reads ../.env.
const FAKE_KEY = `0x${"11".repeat(32)}`;

describe("loadConfig from a plain environment (container)", () => {
  it("names the missing wallet key", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DEPLOYER_PRIVATE_KEY is not set/);
  });

  it("starts with only the wallet key, using defaults", () => {
    const cfg = loadConfig({ DEPLOYER_PRIVATE_KEY: FAKE_KEY });
    expect(cfg.mock).toBe(true);
    expect(cfg.appUrl).toBe("");
    expect(cfg.stateFile).toBe(`${PACKAGE_ROOT}/.keeper-state.json`);
    expect(isAbsolute(cfg.addressesFile)).toBe(true);
  });

  it("puts the state file where KEEPER_STATE_FILE says", () => {
    const cfg = loadConfig({
      DEPLOYER_PRIVATE_KEY: FAKE_KEY,
      KEEPER_STATE_FILE: "/data/keeper-state.json",
      VECTIS_APP_URL: "https://example.test/",
    });
    expect(cfg.stateFile).toBe("/data/keeper-state.json");
    expect(cfg.appUrl).toBe("https://example.test");
  });
});
