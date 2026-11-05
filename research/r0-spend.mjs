// R0: where the money goes, and does our price table agree with Claude Code's own accounting?
//
// Part A splits API-equivalent cost into input, cache reads, cache writes and output, for the main
// chain and for all calls (subagents included). Calls are de-duplicated by request id.
// Part B prices the tokens in Claude Code's own `cost-state` records with our table and compares the
// result with the cost Claude Code charged for the same tokens. Writes are not split by TTL there, so
// both bounds are shown: all writes at the 5-minute rate, and all at the 1-hour rate.
// Respects AGENTPRISM_UNTIL. Prints aggregates only.
import fs from "node:fs";
import { logFiles, PRICES, UNTIL } from "./lib.mjs";

const calls = new Map();
const costState = new Map(); // `${file}|${session}` -> latest record
for (const f of logFiles()) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line || line.startsWith('{"type":"api-request')) continue;
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"cost-state"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "cost-state") {
      costState.set(`${f}|${o.sessionId}`, o);
      continue;
    }
    if (Date.parse(o.timestamp) > UNTIL) continue;
    const u = o.message?.usage;
    const model = o.message?.model;
    if (!u || !PRICES[model]) continue;
    const key = o.requestId ?? o.message.id;
    const prev = calls.get(key);
    if (prev && (u.output_tokens ?? 0) < prev.out) continue;
    const cw = u.cache_creation ?? {};
    calls.set(key, {
      model,
      side: o.isSidechain === true,
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cr: u.cache_read_input_tokens ?? 0,
      w5: cw.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0,
      w1: cw.ephemeral_1h_input_tokens ?? 0,
    });
  }
}

const parts = (c) => {
  const p = PRICES[c.model];
  return {
    input: (c.in * p[0]) / 1e6,
    read: (c.cr * p[2]) / 1e6,
    write: (c.w5 * p[3] + c.w1 * p[4]) / 1e6,
    output: (c.out * p[1]) / 1e6,
  };
};
function split(name, filter) {
  const t = { input: 0, read: 0, write: 0, output: 0 };
  let n = 0;
  for (const c of calls.values()) {
    if (!filter(c)) continue;
    n++;
    const p = parts(c);
    for (const k of Object.keys(t)) t[k] += p[k];
  }
  const total = t.input + t.read + t.write + t.output;
  const pct = (x) => ((100 * x) / total).toFixed(1) + "%";
  console.log(
    `${name}: ${n} calls, $${total.toFixed(0)} — sending the prompt ${pct(t.input + t.read + t.write)} ` +
      `(cache reads ${pct(t.read)}, cache writes ${pct(t.write)}, input ${pct(t.input)}), output ${pct(t.output)}`,
  );
}
console.log("A. Cost split (API-equivalent, list prices)");
split("  main chain", (c) => !c.side);
split("  all calls ", () => true);

console.log("\nB. Our prices vs Claude Code's own cost-state records (same tokens)");
const byModel = new Map();
for (const r of costState.values()) {
  for (const [model, u] of Object.entries(r.modelUsage ?? {})) {
    if (!PRICES[model] || typeof u.costUSD !== "number") continue;
    const m = byModel.get(model) ?? { n: 0, in: 0, out: 0, cr: 0, cw: 0, usd: 0 };
    m.n++;
    m.in += u.inputTokens ?? 0;
    m.out += u.outputTokens ?? 0;
    m.cr += u.cacheReadInputTokens ?? 0;
    m.cw += u.cacheCreationInputTokens ?? 0;
    m.usd += u.costUSD;
    byModel.set(model, m);
  }
}
// Haiku 5.5 bills prompts above 100K at a higher tier; the record does not say which calls those were.
const LONG = { "claude-haiku-5-5": [0.5, 2.5, 0.05, 0.625, 1] };
for (const [model, m] of byModel) {
  const cost = (p, write) => (m.in * p[0] + m.out * p[1] + m.cr * p[2] + m.cw * p[write]) / 1e6;
  const p = PRICES[model];
  const at5 = cost(p, 3);
  const at1 = cost(p, 4);
  const top = LONG[model] ? cost(LONG[model], 4) : at1;
  const diff = (x) => ((100 * (x - m.usd)) / m.usd).toFixed(1) + "%";
  const inside = m.usd >= at5 && m.usd <= top;
  console.log(
    `  ${model.padEnd(18)} ${String(m.n).padStart(3)} records: Claude Code $${m.usd.toFixed(2)}; ours $${at5.toFixed(2)} (writes 5m, ${diff(at5)}) … $${at1.toFixed(2)} (writes 1h, ${diff(at1)})` +
      (LONG[model] ? ` … $${top.toFixed(2)} (long-prompt tier)` : "") +
      ` → ${inside ? "inside our bounds" : "OUTSIDE our bounds"}`,
  );
}
console.log("  (cost-state records are not cut by AGENTPRISM_UNTIL: they carry no per-call time.)");
