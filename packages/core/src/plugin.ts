import type { AgentEvent, AgentId } from "./schema.js";
import type { Store } from "./store/store.js";

/** A log file an adapter knows how to read. */
export interface SourceFile {
  agent: AgentId;
  path: string;
  size: number;
  mtimeMs: number;
}

/** Counters an adapter fills while reading, so format drift is visible instead of silent. */
export interface ReadStats {
  lines: number;
  /** Lines that were not valid JSON. */
  badLines: number;
  /** Record types the adapter does not know, by type name. */
  unknownTypes: Map<string, number>;
}

export function newReadStats(): ReadStats {
  return { lines: 0, badLines: 0, unknownTypes: new Map() };
}

/**
 * Module that brings data in: reads one agent's or product's logs.
 * Adapters must never throw on unexpected data: count it in `stats` and move on.
 * Throwing is reserved for I/O failures.
 */
export interface Adapter {
  id: AgentId;
  displayName: string;
  discover(): Promise<SourceFile[]>;
  read(file: SourceFile, stats: ReadStats): AsyncIterable<AgentEvent>;
}

/** What every analysis module gets: the store (with `ap_cost` registered) and its settings. */
export interface AnalysisContext {
  store: Store;
  /** Restrict analysis to these session ids (all when undefined). */
  sessionIds?: string[];
}

export type Severity = "info" | "warn" | "high";

/** Something worth the user's attention, always backed by evidence. */
export interface Finding {
  /** Id of the detector that produced it. */
  detector: string;
  severity: Severity;
  sessionId: string;
  /** Exact turns that show the problem. */
  turnIds: string[];
  /** One line, plain language. */
  title: string;
  /** Short facts that back the title: targets, counts, sizes. */
  evidence: string[];
  /** Estimate of tokens that bought nothing; for ranking. */
  wastedTokens: number;
  /** Same estimate in API-equivalent USD. */
  wastedUsd: number;
  /** What to change so it does not happen again. */
  suggestion?: string;
  /** Fix modules that can turn this finding into a patch. */
  fixIds?: string[];
}

/** Module that looks for one waste pattern. Pure function of the store. */
export interface Detector {
  id: string;
  title: string;
  /** One sentence: what pattern this detector catches and why it costs money. */
  description: string;
  run(ctx: AnalysisContext): Promise<Finding[]> | Finding[];
}

/** A proposed change the user reviews. Fixes never edit files silently. */
export interface Patch {
  filePath: string;
  description: string;
  diff: string;
}

/** Module that turns findings into reviewable patches. */
export interface Fix {
  id: string;
  appliesTo(finding: Finding): boolean;
  propose(finding: Finding, ctx: AnalysisContext): Promise<Patch>;
}

/** A bundle of modules. Built-in features are plugins too; third-party ones load the same way. */
export interface Plugin {
  name: string;
  adapters?: Adapter[];
  detectors?: Detector[];
  fixes?: Fix[];
}

/** Identity helper that gives plugin authors type checking. */
export const definePlugin = (plugin: Plugin): Plugin => plugin;
