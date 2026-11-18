// Small on-disk state so a restart can (a) keep pricing markets that still have positions even if
// auto-selection changes and (b) avoid re-sending a live Gemini order whose on-chain record failed.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { type ComboDef } from "./combos.js";
import { errText, logger } from "./log.js";

const log = logger("state");

export interface SavedFill {
  price: string; // side space, 1e6
  contracts: string; // 6 decimals
  source: string;
}

interface StateFile {
  key: string;
  symbols: Record<string, string>; // marketId -> instrumentSymbol
  fills: Record<string, SavedFill>; // "<positionId>:<open|close>"
  /** Last seq consumed from the QuickNode Streams activity feed. */
  streamCursor?: number;
  /** Combo definitions currently tracked (with legs), so pricing survives a restart or registry outage. */
  combos?: Record<string, ComboDef>;
}

export class KeeperState {
  private data: StateFile;

  /** `key` scopes the file to one deployment (chain id + MarginManager); a mismatch resets it. */
  constructor(
    private readonly file: string,
    key: string,
  ) {
    this.data = { key, symbols: {}, fills: {} };
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<StateFile>;
      if (raw.key === key) {
        this.data = { key, symbols: raw.symbols ?? {}, fills: raw.fills ?? {} };
        if (typeof raw.streamCursor === "number") this.data.streamCursor = raw.streamCursor;
        if (raw.combos && typeof raw.combos === "object") this.data.combos = raw.combos;
      } else {
        log.info("state file is for another deployment; starting fresh");
      }
    } catch (err) {
      log.warn("could not read state file; starting fresh", { err: errText(err) });
    }
  }

  private save(): void {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch (err) {
      log.warn("could not write state file", { err: errText(err) });
    }
  }

  symbolOf(marketId: string): string | undefined {
    return this.data.symbols[marketId.toLowerCase()];
  }

  rememberSymbols(entries: Array<{ marketId: string; symbol: string }>): void {
    let changed = false;
    for (const { marketId, symbol } of entries) {
      const k = marketId.toLowerCase();
      if (this.data.symbols[k] !== symbol) {
        this.data.symbols[k] = symbol;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  getCombos(): ComboDef[] {
    return Object.values(this.data.combos ?? {});
  }

  comboOf(marketId: string): ComboDef | undefined {
    return this.data.combos?.[marketId.toLowerCase()];
  }

  setCombos(defs: ComboDef[]): void {
    const next: Record<string, ComboDef> = {};
    for (const def of defs) next[def.marketId.toLowerCase()] = def;
    if (JSON.stringify(next) === JSON.stringify(this.data.combos ?? {})) return;
    this.data.combos = next;
    this.save();
  }

  getStreamCursor(): number | undefined {
    return this.data.streamCursor;
  }

  setStreamCursor(cursor: number): void {
    if (this.data.streamCursor === cursor) return;
    this.data.streamCursor = cursor;
    this.save();
  }

  getFill(id: bigint, phase: "open" | "close"): SavedFill | undefined {
    return this.data.fills[`${id}:${phase}`];
  }

  putFill(id: bigint, phase: "open" | "close", fill: SavedFill): void {
    this.data.fills[`${id}:${phase}`] = fill;
    this.save();
  }

  clearFill(id: bigint, phase: "open" | "close"): void {
    if (this.data.fills[`${id}:${phase}`] === undefined) return;
    delete this.data.fills[`${id}:${phase}`];
    this.save();
  }
}
