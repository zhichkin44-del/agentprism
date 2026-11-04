// R1: what share of the bill pays for carrying context after its last use?
//
// Ledger. Every block (tool result, tool call, assistant text, thinking, prompt, attachment) enters the
// context at its birth call and is re-sent on every later call until a compaction. Its size is the
// measured context growth of that interval, split between the blocks that entered it by weights fitted
// in r1-calibrate.mjs (R² 0.97). Each call's prompt cost is known exactly, so each block's carrying cost
// is size × Σ (price per prompt token of every call that carried it).
//
// Use. A block is used at call j when an output of call j (assistant text, tool input, visible thinking)
// or a user prompt just before it shares ≥ k rare identifiers with the block (rare: present in ≤ D
// blocks of the session), or when a tool call at j targets the same file. "Dead" cost is the carrying
// after max(first read, last use): what an oracle memory that dropped each block right after its last
// use would have saved, ignoring cache-prefix constraints. Prints aggregates only.
import { loadSessions } from "./lib.mjs";

// Fitted tokens per unit (r1-calibrate.mjs): output and thinking ~1:1; characters of tool results and
// prompts ~0.45 / 0.40 tokens; attachment records are mostly bookkeeping (0.004); images ~1,100 tokens.
const W = { vis: 1.04, think: 1.02, tr: 0.45, usr: 0.4, att: 0.004, image: 1100 };
const ALWAYS_LIVE = new Set(["base", "user_prompt", "compact_summary", "meta"]);
const TOKEN = /[\p{L}_][\p{L}\p{N}_-]{5,}/gu;

const grid = [
  { k: 1, D: 20 }, // liberal: any shared identifier counts as use → lower bound on dead
  { k: 2, D: 5 }, // middle
  { k: 3, D: 2 }, // strict: three very rare identifiers → upper bound on dead
];

const sessions = loadSessions();
const results = grid.map(() => ({
  dead: {},
  live: {},
  always: 0,
  neverUsed: 0,
  truth: 0,
  recall: 0,
  recallTok: 0,
}));
let totalCtxUsd = 0,
  totalOutUsd = 0,
  allocated = 0,
  measuredGrowth = 0,
  blocksN = 0;

for (const events of sessions.values()) {
  // --- Pass 1: calls, blocks, birth, sizes -------------------------------------------------------
  const calls = [];
  const blocks = [];
  let pending = [];
  let segStart = true;
  for (const e of events) {
    if (e.t === "compact") segStart = true;
    else if (e.t === "block") pending.push(e);
    else if (e.t === "call") {
      const prev = calls[calls.length - 1];
      const j = calls.length;
      e.idx = j;
      if (prev && prev.ctx > 100_000 && e.ctx < prev.ctx * 0.5) segStart = true;
      calls.push(e);
      totalCtxUsd += e.ctxUsd;
      totalOutUsd += e.outUsd;
      if (segStart || !prev) {
        e.seg = (prev?.seg ?? -1) + 1;
        // Everything already in the prompt at a segment start (system, tools, summary, first prompt).
        blocks.push({ kind: "base", size: e.ctx, birth: j, seg: e.seg, toks: [] });
        for (const b of pending) if (b.kind === "user_prompt") b.consumerAt = j;
        pending = [];
        segStart = false;
        continue;
      }
      e.seg = prev.seg;
      const delta = Math.max(0, e.ctx - prev.ctx);
      measuredGrowth += delta;
      // Weights: the previous call's output by its tokens, everything else by characters.
      const outBlocks = pending.filter((b) => b.by === prev.id);
      const thinkN = outBlocks.filter((b) => b.kind === "thinking").length;
      const visChars =
        outBlocks.filter((b) => b.kind !== "thinking").reduce((s, b) => s + b.text.length, 0) || 1;
      const vis = prev.usage.out - prev.usage.think;
      for (const b of pending) {
        if (b.by === prev.id)
          b.w =
            b.kind === "thinking"
              ? (W.think * prev.usage.think) / thinkN
              : (W.vis * vis * b.text.length) / visChars;
        else if (b.by)
          b.w = 0; // output of an earlier call already counted
        else if (b.kind === "attachment") b.w = W.att * b.text.length;
        else
          b.w =
            (b.kind === "tool_result" ? W.tr : W.usr) * b.text.length + W.image * (b.images ?? 0);
      }
      const wSum = pending.reduce((s, b) => s + b.w, 0);
      for (const b of pending) {
        const size = wSum > 0 ? (delta * b.w) / wSum : 0;
        allocated += size;
        if (b.kind === "user_prompt") b.consumerAt = j;
        if (size <= 0 && b.kind !== "user_prompt") continue;
        blocks.push({
          kind:
            b.kind === "tool_result" || b.kind === "tool_use" || b.kind === "attachment"
              ? `${b.kind}:${b.tool}`
              : b.kind,
          size,
          birth: j,
          seg: e.seg,
          target: b.target,
          text: b.text,
          by: b.by,
        });
      }
      if (wSum === 0 && delta > 0)
        blocks.push({ kind: "unattributed", size: delta, birth: j, seg: e.seg, toks: [] });
      // Prompts are consumers too: what the user refers to was needed at this call.
      pending = [];
    }
  }
  if (!calls.length) continue;
  blocksN += blocks.length;

  // Price per prompt token on each call, prefix sums, and the last call of each segment.
  const S = [0];
  const segEnd = new Map();
  for (const c of calls) {
    S.push(S[S.length - 1] + (c.ctx ? c.ctxUsd / c.ctx : 0));
    segEnd.set(c.seg, c.idx);
  }
  const carry = (size, from, to) => (to >= from ? size * (S[to + 1] - S[from]) : 0);

  // Identifier sets and document frequency within the session.
  const df = new Map();
  for (const b of blocks) {
    b.toks = b.text ? [...new Set(b.text.match(TOKEN) ?? [])] : [];
    for (const t of b.toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  // Consumers: assistant outputs, keyed by the call that produced them, and prompts.
  const callIdx = new Map(calls.map((c) => [c.id, c.idx]));
  const consumers = [];
  for (const e of events) {
    if (e.t !== "block") continue;
    if (e.by && callIdx.has(e.by))
      consumers.push({
        at: callIdx.get(e.by),
        text: e.text,
        target: e.kind === "tool_use" ? e.target : undefined,
      });
    else if (e.kind === "user_prompt" && e.consumerAt !== undefined)
      consumers.push({ at: e.consumerAt, text: e.text });
  }

  // Ground truth for one class of use: an Edit's old_string must have been in context, so the latest
  // Read result containing its first line was used at that call. Measures the recall of the proxy.
  const truth = [];
  for (const e of events) {
    if (e.t !== "block" || e.kind !== "tool_use" || e.tool !== "Edit" || !callIdx.has(e.by))
      continue;
    let needle;
    try {
      needle = (JSON.parse(e.text).old_string ?? "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length >= 15);
    } catch {
      continue;
    }
    if (!needle) continue;
    const at = callIdx.get(e.by);
    let src;
    for (const b of blocks)
      if (
        b.kind === "tool_result:Read" &&
        b.birth <= at &&
        b.seg === calls[at].seg &&
        b.text.includes(needle)
      )
        src = b;
    if (src && src.birth < at) truth.push({ b: src, at });
  }

  grid.forEach(({ k, D }, gi) => {
    const r = results[gi];
    const index = new Map(); // rare token -> blocks
    const byTarget = new Map();
    for (const b of blocks) {
      b.lastUse = -1;
      b.lastUseTok = -1;
      for (const t of b.toks) if (df.get(t) <= D) (index.get(t) ?? index.set(t, []).get(t)).push(b);
      if (b.target) (byTarget.get(b.target) ?? byTarget.set(b.target, []).get(b.target)).push(b);
    }
    for (const c of consumers) {
      const hits = new Map();
      for (const t of new Set(c.text.match(TOKEN) ?? [])) {
        if (df.get(t) > D) continue;
        for (const b of index.get(t) ?? []) {
          if (b.birth > c.at || b.seg !== calls[c.at].seg) continue;
          hits.set(b, (hits.get(b) ?? 0) + 1);
        }
      }
      for (const [b, n] of hits) if (n >= k && c.at > b.lastUseTok) b.lastUseTok = c.at;
      for (const b of byTarget.get(c.target) ?? [])
        if (b.birth <= c.at && b.seg === calls[c.at].seg) hits.set(b, k);
      for (const [b, n] of hits) if (n >= k && c.at > b.lastUse) b.lastUse = c.at;
    }
    for (const { b, at } of truth) {
      r.truth++;
      if (b.lastUseTok >= at) r.recallTok++;
      if (b.lastUse >= at) r.recall++;
    }
    for (const b of blocks) {
      const end = segEnd.get(b.seg);
      const total = carry(b.size, b.birth, end);
      if (ALWAYS_LIVE.has(b.kind)) {
        r.always += total;
        continue;
      }
      const group =
        b.kind.startsWith("tool_result:") ||
        b.kind.startsWith("tool_use:") ||
        b.kind.startsWith("attachment:")
          ? b.kind.replace(/:mcp__.*/, ":mcp")
          : b.kind;
      const u = Math.max(b.birth, b.lastUse); // the first read is always needed
      const dead = carry(b.size, u + 1, end);
      r.dead[group] = (r.dead[group] ?? 0) + dead;
      r.live[group] = (r.live[group] ?? 0) + (total - dead);
      if (b.lastUse < 0 && b.kind !== "thinking") r.neverUsed += dead;
    }
  });
}

const usd = (x) => "$" + x.toFixed(0);
console.log(
  `sessions ${sessions.size}, blocks ${blocksN}; main-chain prompt cost ${usd(totalCtxUsd)}, output ${usd(totalOutUsd)}`,
);
console.log(
  `growth allocated ${(allocated / 1e6).toFixed(1)}M of measured ${(measuredGrowth / 1e6).toFixed(1)}M tokens`,
);
grid.forEach(({ k, D }, gi) => {
  const r = results[gi];
  const dead = Object.values(r.dead).reduce((s, x) => s + x, 0);
  const live = Object.values(r.live).reduce((s, x) => s + x, 0);
  console.log(
    `\nk=${k} D=${D}: ledger ${usd(r.always + dead + live)} = always-live ${usd(r.always)} + used ${usd(live)} + dead ${usd(dead)}`,
  );
  console.log(
    `  recall on known uses (Edit old_string found in an earlier Read): identifiers only ${r.recallTok}/${r.truth}, with file targets ${r.recall}/${r.truth}`,
  );
  console.log(
    `  dead = ${((100 * dead) / totalCtxUsd).toFixed(1)}% of prompt cost, ${((100 * dead) / (totalCtxUsd + totalOutUsd)).toFixed(1)}% of main-chain spend; never used after first read (thinking excluded) ${usd(r.neverUsed)}`,
  );
  const rows = Object.keys(r.dead)
    .map((g) => [g, r.dead[g], r.live[g]])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [g, d, l] of rows)
    console.log(
      `  ${g.padEnd(28)} dead ${usd(d).padStart(5)}  used ${usd(l).padStart(5)}  dead share ${((100 * d) / (d + l)).toFixed(0)}%`,
    );
});
