// Manages the Vectis QuickNode Stream through the Streams REST API.
//
//   node scripts/stream.mjs test [block]   run the filter against one block (default: deploy block)
//   node scripts/stream.mjs create         create the stream (backfills from the deploy block)
//   node scripts/stream.mjs list           list streams on the account
//   node scripts/stream.mjs pause <id> | activate <id> | delete <id>
//
// Reads from the root .env: QUICKNODE_API_KEY, QN_STREAM_SECURITY_TOKEN, VECTIS_APP_URL,
// and optionally QN_STREAM_NETWORK (default arc-testnet). Contract addresses and the deploy
// block come from keeper/addresses.json. Secrets are never printed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.quicknode.com/streams/rest/v1";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(root, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k in env)) };
}

const env = loadEnv();
const addresses = JSON.parse(readFileSync(join(root, "keeper", "addresses.json"), "utf8"));
const network = env.QN_STREAM_NETWORK || "arc-testnet";
const ZERO = "0x0000000000000000000000000000000000000000";

function need(name) {
  if (!env[name]) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return env[name];
}

// The filter runs on QuickNode's side for every batch. It keeps only logs emitted by the
// MarginManager and the LendingVault, and skips delivery entirely when a batch has none.
function filterSource() {
  const targets = [addresses.marginManager, addresses.lendingVault].map((a) => a.toLowerCase());
  return `function main(stream) {
  var targets = ${JSON.stringify(targets)};
  var logs = [];
  function walk(x) {
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) walk(x[i]); return; }
    if (x && typeof x === 'object' && x.address && Array.isArray(x.topics)) {
      if (targets.indexOf(String(x.address).toLowerCase()) !== -1) logs.push(x);
    }
  }
  walk(stream.data);
  if (logs.length === 0) return null;
  var m = stream.metadata || {};
  return { logs: logs, network: m.network, batchStart: m.batch_start_range, batchEnd: m.batch_end_range };
}`;
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { "x-api-key": need("QUICKNODE_API_KEY"), "content-type": "application/json", accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    console.error(`${method} ${path} -> ${res.status}`);
    console.error(JSON.stringify(json, null, 2).slice(0, 2000));
    process.exit(1);
  }
  return json;
}

function requireDeployed() {
  if (addresses.marginManager === ZERO) {
    console.error("keeper/addresses.json has zero addresses. Deploy the contracts first.");
    process.exit(1);
  }
}

const [cmd, arg] = process.argv.slice(2);
const filter_function = Buffer.from(filterSource()).toString("base64");

if (cmd === "test") {
  requireDeployed();
  const block = String(arg || addresses.deployBlock);
  const out = await api("POST", "/streams/test_filter", { network, dataset: "logs", filter_function, block });
  console.log(JSON.stringify(out, null, 2).slice(0, 4000));
} else if (cmd === "create") {
  requireDeployed();
  const appUrl = need("VECTIS_APP_URL").replace(/\/$/, "");
  const body = {
    name: "vectis-margin-events",
    network,
    dataset: "logs",
    region: "usa_east",
    // Arc has sub-second blocks, so QuickNode requires a batch size of at least 5.
    dataset_batch_size: 5,
    elastic_batch_enabled: true,
    // Arc blocks are final on inclusion: no reorg handling needed.
    fix_block_reorgs: 0,
    keep_distance_from_tip: 0,
    start_range: Number(addresses.deployBlock),
    filter_function,
    destination: "webhook",
    destination_attributes: {
      url: `${appUrl}/api/qn-stream`,
      compression: "none",
      max_retry: 3,
      retry_interval_sec: 1,
      post_timeout_sec: 10,
      security_token: need("QN_STREAM_SECURITY_TOKEN"),
    },
    status: "active",
  };
  const out = await api("POST", "/streams", body);
  console.log("created stream", out.id ?? out.stream_id ?? "(id not in response)", "status", out.status);
  console.log("network", network, "start_range", body.start_range, "webhook", body.destination_attributes.url);
} else if (cmd === "list") {
  const out = await api("GET", "/streams");
  const list = Array.isArray(out) ? out : out.data ?? out.streams ?? [];
  for (const s of list) console.log(s.id, s.status, s.network, s.dataset, s.name);
  if (!list.length) console.log("no streams");
} else if (cmd === "pause" || cmd === "activate") {
  if (!arg) throw new Error("stream id required");
  await api("POST", `/streams/${arg}/${cmd}`);
  console.log(cmd, arg, "ok");
} else if (cmd === "delete") {
  if (!arg) throw new Error("stream id required");
  await api("DELETE", `/streams/${arg}`);
  console.log("deleted", arg);
} else {
  console.log("usage: node scripts/stream.mjs test [block] | create | list | pause <id> | activate <id> | delete <id>");
}
