import { callParts, priceFor, type PriceTable } from "../pricing/prices.js";
import type { BlockType, Timeline, TimelineBlock, TimelineCall } from "./timeline.js";

/**
 * Context ledger: what every block of content cost to carry in the prompt, and whether it was still
 * being used. Method and validation: docs/RESEARCH.md (R1).
 *
 * Sizes. The prompt growth between two calls is exact (usage). It is split between the blocks that
 * entered in between by weights fitted on real logs (R² 0.97): the previous call's output by its
 * tokens, everything else by characters. So the ledger adds up to the real prompt cost.
 *
 * Use. A block is used at call j when an output of j (or a prompt just before it) shares at least
 * `minShared` identifiers that occur in at most `maxDf` blocks of the session, or works on the same
 * file. Validated on known uses (an Edit's old_string must have been read): 98% recall.
 */
export interface LedgerOptions {
  minShared?: number;
  maxDf?: number;
}

/** Tokens per unit, fitted on 9,204 intervals (research/r1-calibrate.mjs). */
export const SIZE_WEIGHTS = {
  visibleOutput: 1.04,
  thinking: 1.02,
  toolResultChar: 0.45,
  promptChar: 0.4,
  attachmentChar: 0.004,
  image: 1100,
};

/** Always needed: what the agent must carry whatever it does (system, tools, summaries, prompts). */
const ALWAYS: ReadonlySet<string> = new Set(["base", "user_prompt", "compact_summary", "meta"]);
const IDENT = /[\p{L}_][\p{L}\p{N}_-]{5,}/gu;

export interface LedgerCall {
  index: number;
  ts: number;
  model: string;
  /** Prompt tokens of the call (input + cache read + cache writes). */
  ctx: number;
  /** Exact cost of the prompt part and of the output. */
  promptUsd: number;
  outputUsd: number;
  segment: number;
  /** A compaction happened right before this call. */
  compactedBefore: boolean;
  usage: TimelineCall["usage"];
}

export interface LedgerBlock {
  /** "tool_result:Bash", "thinking", "tool_use:mcp", ... (MCP tools collapsed). */
  label: string;
  type: BlockType | "base" | "unattributed";
  tool?: string;
  target?: string;
  size: number;
  birth: number;
  /** Last call that carried it (end of its segment). */
  end: number;
  /** Last call that used it, -1 if never after its first read. */
  lastUse: number;
  carryUsd: number;
  /** Carrying after max(first read, last use). Thinking: unknown use, kept apart. */
  deadUsd: number;
  always: boolean;
}

export interface ContextLedger {
  sessionId: string;
  calls: LedgerCall[];
  blocks: LedgerBlock[];
  totals: {
    promptUsd: number;
    outputUsd: number;
    alwaysUsd: number;
    usedUsd: number;
    deadUsd: number;
    thinkingUsd: number;
  };
  /** Per call, tokens by status, for charts: always, used, dead, thinking. */
  composition: { always: number[]; used: number[]; dead: number[]; thinking: number[] };
}

const labelOf = (b: TimelineBlock) => {
  if (b.type === "tool_use" || b.type === "tool_result" || b.type === "attachment") {
    const tool = b.tool?.startsWith("mcp__") ? "mcp" : (b.tool ?? "?");
    return `${b.type}:${tool}`;
  }
  return b.type;
};

export function contextLedger(
  timeline: Timeline,
  prices: PriceTable,
  options: LedgerOptions = {},
): ContextLedger {
  const k = options.minShared ?? 1;
  const maxDf = options.maxDf ?? 20;
  const W = SIZE_WEIGHTS;

  const calls: LedgerCall[] = [];
  const blocks: (LedgerBlock & { text?: string; byCall?: string })[] = [];
  const consumers: { at: number; text: string; target?: string }[] = [];
  const callIndex = new Map<string, number>();
  let pending: TimelineBlock[] = [];
  let compactNext = false;
  let prevCallId: string | undefined;

  for (const e of timeline.events) {
    if (e.kind === "compaction") {
      compactNext = true;
      continue;
    }
    if (e.kind === "block") {
      pending.push(e);
      continue;
    }
    const u = e.usage;
    const ctx = u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
    const parts = callParts(priceFor(prices, e.model), {
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheWrite5m: u.cacheWrite5mTokens,
      cacheWrite1h: u.cacheWrite1hTokens,
    });
    const prev = calls.at(-1);
    const j = calls.length;
    const dropped = !!prev && prev.ctx > 100_000 && ctx < prev.ctx * 0.5;
    const segStart = !prev || compactNext || dropped;
    const call: LedgerCall = {
      index: j,
      ts: e.ts,
      model: e.model,
      ctx,
      promptUsd: parts.input + parts.cacheRead + parts.cacheWrite,
      outputUsd: parts.output,
      segment: prev ? prev.segment + (segStart ? 1 : 0) : 0,
      compactedBefore: !!prev && segStart,
      usage: u,
    };
    calls.push(call);
    callIndex.set(e.id, j);
    const prevId = prevCallId;
    prevCallId = e.id;

    for (const b of pending) {
      if (b.type === "user_prompt") consumers.push({ at: j, text: b.text });
    }
    if (segStart) {
      blocks.push(newBlock("base", "base", undefined, undefined, ctx, j, call.segment));
      pending = [];
      compactNext = false;
      continue;
    }
    const delta = Math.max(0, ctx - prev.ctx);
    const own = pending.filter((b) => b.byCall !== undefined && b.byCall === prevId);
    const thinkBlocks = own.filter((b) => b.type === "thinking").length;
    const visChars = own
      .filter((b) => b.type !== "thinking")
      .reduce((s, b) => s + b.text.length, 0);
    const visible = Math.max(0, prev.usage.outputTokens - prev.usage.thinkingTokens);
    const weights = pending.map((b) => {
      if (b.byCall !== undefined && b.byCall === prevId) {
        if (b.type === "thinking")
          return thinkBlocks ? (W.thinking * prev.usage.thinkingTokens) / thinkBlocks : 0;
        return visChars ? (W.visibleOutput * visible * b.text.length) / visChars : 0;
      }
      if (b.byCall !== undefined) return 0;
      if (b.type === "attachment") return W.attachmentChar * b.text.length;
      const perChar = b.type === "tool_result" ? W.toolResultChar : W.promptChar;
      return perChar * b.text.length + W.image * b.images;
    });
    const total = weights.reduce((s, w) => s + w, 0);
    pending.forEach((b, i) => {
      const size = total > 0 ? (delta * (weights[i] ?? 0)) / total : 0;
      if (size <= 0) return;
      const lb = newBlock(labelOf(b), b.type, b.tool, b.target, size, j, call.segment);
      blocks.push({ ...lb, text: b.text, byCall: b.byCall });
    });
    if (total === 0 && delta > 0) {
      blocks.push(
        newBlock("unattributed", "unattributed", undefined, undefined, delta, j, call.segment),
      );
    }
    pending = [];
  }
  for (const e of timeline.events) {
    if (e.kind === "block" && e.byCall !== undefined && callIndex.has(e.byCall)) {
      consumers.push({
        at: callIndex.get(e.byCall) ?? 0,
        text: e.text,
        target: e.type === "tool_use" ? e.target : undefined,
      });
    }
  }

  // Segment ends and price per prompt token on every call, as prefix sums.
  const segEnd = new Map<number, number>();
  const S = [0];
  for (const c of calls) {
    segEnd.set(c.segment, c.index);
    S.push((S.at(-1) ?? 0) + (c.ctx ? c.promptUsd / c.ctx : 0));
  }
  const carry = (size: number, from: number, to: number) =>
    to >= from ? size * ((S[to + 1] ?? 0) - (S[from] ?? 0)) : 0;

  // Use: rare shared identifiers or the same file.
  const df = new Map<string, number>();
  const toks = blocks.map((b) => {
    const t = b.text ? [...new Set(b.text.match(IDENT) ?? [])] : [];
    for (const x of t) df.set(x, (df.get(x) ?? 0) + 1);
    return t;
  });
  const index = new Map<string, number[]>();
  const byTarget = new Map<string, number[]>();
  blocks.forEach((b, i) => {
    b.end = segEnd.get(segmentOf(b, calls)) ?? b.birth;
    for (const t of toks[i] ?? []) {
      if ((df.get(t) ?? 0) <= maxDf) (index.get(t) ?? index.set(t, []).get(t))?.push(i);
    }
    if (b.target) (byTarget.get(b.target) ?? byTarget.set(b.target, []).get(b.target))?.push(i);
  });
  for (const c of consumers) {
    const seg = calls[c.at]?.segment;
    const hits = new Map<number, number>();
    for (const t of new Set(c.text.match(IDENT) ?? [])) {
      if ((df.get(t) ?? 0) > maxDf) continue;
      for (const i of index.get(t) ?? []) hits.set(i, (hits.get(i) ?? 0) + 1);
    }
    for (const i of (c.target && byTarget.get(c.target)) || []) hits.set(i, k);
    for (const [i, n] of hits) {
      const b = blocks[i];
      if (!b || n < k || b.birth > c.at || calls[b.birth]?.segment !== seg) continue;
      if (c.at > b.lastUse) b.lastUse = c.at;
    }
  }

  const totals = {
    promptUsd: 0,
    outputUsd: 0,
    alwaysUsd: 0,
    usedUsd: 0,
    deadUsd: 0,
    thinkingUsd: 0,
  };
  for (const c of calls) {
    totals.promptUsd += c.promptUsd;
    totals.outputUsd += c.outputUsd;
  }
  const n = calls.length;
  const diff = {
    always: new Float64Array(n + 1),
    used: new Float64Array(n + 1),
    dead: new Float64Array(n + 1),
    thinking: new Float64Array(n + 1),
  };
  const add = (arr: Float64Array, from: number, to: number, v: number) => {
    if (to < from) return;
    arr[from] = (arr[from] ?? 0) + v;
    arr[to + 1] = (arr[to + 1] ?? 0) - v;
  };
  for (const b of blocks) {
    b.carryUsd = carry(b.size, b.birth, b.end);
    if (b.always) {
      totals.alwaysUsd += b.carryUsd;
      add(diff.always, b.birth, b.end, b.size);
    } else if (b.type === "thinking") {
      totals.thinkingUsd += b.carryUsd;
      add(diff.thinking, b.birth, b.end, b.size);
    } else {
      const u = Math.max(b.birth, b.lastUse);
      b.deadUsd = carry(b.size, u + 1, b.end);
      totals.deadUsd += b.deadUsd;
      totals.usedUsd += b.carryUsd - b.deadUsd;
      add(diff.used, b.birth, u, b.size);
      add(diff.dead, u + 1, b.end, b.size);
    }
    delete b.text;
    delete b.byCall;
  }
  const prefix = (a: Float64Array) => {
    const out: number[] = [];
    let acc = 0;
    for (let i = 0; i < n; i++) out.push((acc += a[i] ?? 0));
    return out;
  };
  return {
    sessionId: timeline.sessionId,
    calls,
    blocks,
    totals,
    composition: {
      always: prefix(diff.always),
      used: prefix(diff.used),
      dead: prefix(diff.dead),
      thinking: prefix(diff.thinking),
    },
  };
}

function newBlock(
  label: string,
  type: LedgerBlock["type"],
  tool: string | undefined,
  target: string | undefined,
  size: number,
  birth: number,
  _segment: number,
): LedgerBlock {
  return {
    label,
    type,
    tool,
    target,
    size,
    birth,
    end: birth,
    lastUse: -1,
    carryUsd: 0,
    deadUsd: 0,
    always: ALWAYS.has(type),
  };
}

const segmentOf = (b: LedgerBlock, calls: LedgerCall[]) => calls[b.birth]?.segment ?? 0;
