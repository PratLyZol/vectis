#!/usr/bin/env node
// Copy the keeper's environment from the repo-root .env to the linked Railway service.
//
//   node scripts/railway-env.mjs [--service keeper] [--app-url https://...] [--dry-run]
//
// Run from the repo root after `railway link`. Only the names in KEEPER_VARS are read from .env
// (never the whole file); empty ones are skipped. Values go to `railway variable set KEY --stdin`
// through a pipe, so they never appear in argv, in a shell, or in this script's output. Prints
// only variable names. --dry-run prints what would be set without calling railway.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = resolve(ROOT, ".env");

/** Read from .env when non-empty. Mirrors keeper/src/config.ts. */
const KEEPER_VARS = [
  // required (secret)
  "DEPLOYER_PRIVATE_KEY",
  // optional; ARC_RPC_URL may carry a provider token, so it is treated as secret too
  "ARC_RPC_URL",
  "GEMINI_PUBLIC_BASE",
  "GEMINI_TRADE_BASE",
  // optional secrets: empty keeps the keeper in mock mode (simulated fills)
  "GEMINI_API_KEY",
  "GEMINI_API_SECRET",
  // optional tuning
  "KEEPER_MARKET_COUNT",
  "KEEPER_POLL_MS",
  "KEEPER_HEARTBEAT_MS",
  "KEEPER_REQUEST_COUNT",
  "KEEPER_SYMBOLS",
  "KEEPER_SCAN_EVENTS",
  "KEEPER_STREAM_POLL_MS",
  "KEEPER_COMBO_POLL_MS",
  "KEEPER_COMBO_COUNT",
];

const DEFAULT_APP_URL = "https://vectis-mauve.vercel.app";
const STATE_FILE = "/data/keeper-state.json"; // on the Railway volume mounted at /data

function parseArgs(argv) {
  const out = { service: "keeper", appUrl: DEFAULT_APP_URL, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--service" && argv[i + 1]) out.service = argv[++i];
    else if (a === "--app-url" && argv[i + 1]) out.appUrl = argv[++i].replace(/\/+$/, "");
    else {
      console.error(`unknown or incomplete argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(ENV_FILE)) {
  console.error(`no .env at ${ENV_FILE}`);
  process.exit(1);
}
const fromFile = parseEnv(readFileSync(ENV_FILE, "utf8"));

/** name -> value, in order. Fixed (non-secret) Railway settings last so they win. */
const toSet = new Map();
const skipped = [];
for (const name of KEEPER_VARS) {
  const value = (fromFile[name] ?? "").trim();
  if (value) toSet.set(name, value);
  else skipped.push(name);
}
// The web app on Vercel (stream feed, combo registry, market requests). A localhost value from
// .env would be useless on Railway, so this is set explicitly.
toSet.set("VECTIS_APP_URL", args.appUrl);
toSet.set("KEEPER_STATE_FILE", STATE_FILE);

if (!toSet.has("DEPLOYER_PRIVATE_KEY")) {
  console.error("DEPLOYER_PRIVATE_KEY is empty in .env; the keeper cannot start without it. Nothing was set.");
  process.exit(1);
}

const set = [];
const failed = [];
for (const [name, value] of toSet) {
  if (args.dryRun) {
    set.push(name);
    continue;
  }
  const res = spawnSync(
    "railway",
    ["variable", "set", name, "--stdin", "--skip-deploys", "--service", args.service],
    { input: value, stdio: ["pipe", "ignore", "pipe"], encoding: "utf8", shell: false },
  );
  if (res.error) {
    console.error(`could not run railway: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status === 0) {
    set.push(name);
  } else {
    // Never echo a value, even if the CLI did.
    const reason = (res.stderr ?? "").split(value).join("<redacted>").trim().split("\n")[0] ?? "";
    failed.push(`${name} (${reason || `exit ${res.status}`})`);
  }
}

console.log(`${args.dryRun ? "would set" : "set"} on service "${args.service}": ${set.join(", ") || "(none)"}`);
console.log(`skipped (empty in .env): ${skipped.join(", ") || "(none)"}`);
if (failed.length > 0) {
  console.error(`failed: ${failed.join("; ")}`);
  process.exit(1);
}
if (!args.dryRun) console.log("Variables staged without a deploy. Next: railway up ./keeper --path-as-root --service " + args.service);
