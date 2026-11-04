// R4: can signals in the logs alone predict whether an agent's edit survives into git?
//
// Outcome. For every applied Edit / Write of a file inside a git repository, take the first commit
// (any branch) after the edit that touches the file. The edit survived if at least half of its
// significant lines (trimmed, ≥ 12 chars) are present in that commit's version. Edits with no later
// commit of the file are "never committed" and left out of the scoring.
//
// Signals (from logs only): the edit was exactly undone later; the agent re-edited the same lines in
// the session (churn); a shell command failed within the next 5 tool calls; the owner's next message
// was a correction (broad / strict, from Q1's local dataset); the turn was interrupted; prompt size;
// subagent or main agent. Scoring: AUROC of each signal and of a logistic model, cross-validated with
// whole sessions held out, with a session-level bootstrap interval. Prints aggregates only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logFiles } from "./lib.mjs";

const MIN_LINE = 12;
const sig = (text) => [
  ...new Set(
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= MIN_LINE),
  ),
];

// ---------- edits and session signals from the logs --------------------------------------------
const edits = [];
const seenTool = new Set();
const results = new Map(); // tool_use id -> { error }
const toolSeq = new Map(); // session -> [{ ts, id, name }]
const usageAt = new Map(); // session -> [{ ts, ctx }]
for (const f of logFiles()) {
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line || line.startsWith('{"type":"api-request')) continue;
    if (
      !line.includes('"tool_use"') &&
      !line.includes('"tool_result"') &&
      !line.includes('"usage"')
    )
      continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(o.timestamp);
    const s = o.sessionId;
    if (o.type === "assistant") {
      const u = o.message?.usage;
      if (u && !o.isSidechain)
        (usageAt.get(s) ?? usageAt.set(s, []).get(s)).push({
          ts,
          ctx:
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0),
        });
      for (const b of o.message?.content ?? []) {
        if (b.type !== "tool_use" || seenTool.has(b.id)) continue;
        seenTool.add(b.id);
        (toolSeq.get(s) ?? toolSeq.set(s, []).get(s)).push({ ts, id: b.id, name: b.name });
        const inp = b.input ?? {};
        if (b.name === "Edit" && inp.file_path && inp.new_string)
          edits.push({
            id: b.id,
            s,
            ts,
            file: inp.file_path,
            lines: sig(inp.new_string),
            old: inp.old_string ?? "",
            neu: inp.new_string,
            side: !!o.isSidechain,
            tool: "Edit",
          });
        else if (b.name === "Write" && inp.file_path && inp.content)
          edits.push({
            id: b.id,
            s,
            ts,
            file: inp.file_path,
            lines: sig(inp.content),
            old: "",
            neu: inp.content,
            side: !!o.isSidechain,
            tool: "Write",
          });
      }
    } else if (o.type === "user" && Array.isArray(o.message?.content)) {
      for (const b of o.message.content)
        if (b.type === "tool_result")
          results.set(b.tool_use_id, { error: b.is_error === true, denied: !!o.toolDenialKind });
    }
  }
}

// Owner messages from Q1's local dataset (texts are not read here, only flags).
const owner = new Map(); // session -> [{ ts, broad, strict, interrupted }]
const pairsFile = path.resolve(".agentprism", "research", "owner-pairs.jsonl");
for (const l of fs.readFileSync(pairsFile, "utf8").split("\n").filter(Boolean)) {
  const p = JSON.parse(l);
  (owner.get(p.source.session) ?? owner.set(p.source.session, []).get(p.source.session)).push({
    ts: Date.parse(p.source.ts),
    broad: p.is_correction,
    strict: p.signals.strict_correction,
    interrupted: p.signals.interrupted,
  });
}

// ---------- git outcome ----------------------------------------------------------------------
const rootOf = new Map();
function gitRoot(file) {
  let d = path.dirname(file);
  const chain = [];
  while (d && !rootOf.has(d)) {
    chain.push(d);
    if (fs.existsSync(path.join(d, ".git"))) {
      rootOf.set(d, d);
      break;
    }
    const up = path.dirname(d);
    if (up === d) {
      rootOf.set(d, null);
      break;
    }
    d = up;
  }
  const r = rootOf.get(d) ?? null;
  for (const c of chain) rootOf.set(c, r);
  return r;
}
const git = (root, args) => {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
};
const commitsOf = new Map();
const blobCache = new Map();
function firstCommitAfter(root, rel, ts) {
  const key = root + "|" + rel;
  if (!commitsOf.has(key)) {
    const out = git(root, ["log", "--all", "--format=%H %ct", "--", rel]) ?? "";
    commitsOf.set(
      key,
      out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [h, t] = l.split(" ");
          return { h, t: +t * 1000 };
        })
        .sort((a, b) => a.t - b.t),
    );
  }
  return commitsOf.get(key).find((c) => c.t >= ts);
}
function linesAt(root, hash, rel) {
  const key = hash + ":" + rel;
  if (!blobCache.has(key)) {
    const txt = git(root, ["show", `${hash}:${rel}`]);
    blobCache.set(key, txt === null ? null : new Set(txt.split("\n").map((l) => l.trim())));
  }
  return blobCache.get(key);
}

let notInGit = 0,
  failed = 0,
  tooShort = 0,
  neverCommitted = 0,
  deletedInCommit = 0;
const rows = [];
for (const e of edits) {
  if (results.get(e.id)?.error || results.get(e.id)?.denied) {
    failed++;
    continue;
  }
  if (e.lines.length === 0) {
    tooShort++;
    continue;
  }
  const root = gitRoot(e.file);
  if (!root) {
    notInGit++;
    continue;
  }
  const rel = path.relative(root, e.file).split(path.sep).join("/");
  const c = firstCommitAfter(root, rel, e.ts);
  if (!c) {
    neverCommitted++;
    continue;
  }
  const at = linesAt(root, c.h, rel);
  // Second outcome: still in the current HEAD, for edits older than two days (durability).
  const head =
    Date.now() - e.ts > 2 * 86_400_000 ? (linesAt(root, "HEAD", rel) ?? new Set()) : null;
  const atHead = head
    ? e.lines.filter((l) => head.has(l)).length / e.lines.length >= 0.5
      ? 1
      : 0
    : null;
  if (!at) {
    deletedInCommit++;
    rows.push({ e, survived: 0, atHead });
    continue;
  }
  const kept = e.lines.filter((l) => at.has(l)).length / e.lines.length;
  rows.push({ e, survived: kept >= 0.5 ? 1 : 0, kept, atHead });
}

// ---------- signals ---------------------------------------------------------------------------
const bySession = new Map();
for (const e of edits) (bySession.get(e.s) ?? bySession.set(e.s, []).get(e.s)).push(e);
for (const list of bySession.values()) list.sort((a, b) => a.ts - b.ts);
for (const r of rows) {
  const e = r.e;
  const later = (bySession.get(e.s) ?? []).filter((x) => x.ts > e.ts && x.file === e.file);
  r.undone = later.some((x) => x.old === e.neu && x.neu === e.old) ? 1 : 0;
  r.churn = later.some((x) => x.old && e.lines.some((l) => x.old.includes(l))) ? 1 : 0;
  const seq = toolSeq.get(e.s) ?? [];
  const i = seq.findIndex((t) => t.id === e.id);
  r.failAfter = seq
    .slice(i + 1, i + 6)
    .some((t) => /Bash|PowerShell/.test(t.name) && results.get(t.id)?.error)
    ? 1
    : 0;
  const next = (owner.get(e.s) ?? []).filter((m) => m.ts > e.ts).sort((a, b) => a.ts - b.ts)[0];
  r.ownerBroad = next?.broad ? 1 : 0;
  r.ownerStrict = next?.strict ? 1 : 0;
  r.interrupted = next?.interrupted ? 1 : 0;
  const u = (usageAt.get(e.s) ?? []).filter((x) => x.ts <= e.ts).pop();
  r.ctx = u ? u.ctx / 1e6 : 0;
  r.side = e.side ? 1 : 0;
  r.write = e.tool === "Write" ? 1 : 0;
}

// ---------- scoring -------------------------------------------------------------------------
// AUROC with "risk" scores: higher score should mean "did not survive".
function auroc(scores, ys) {
  const pos = [],
    neg = [];
  scores.forEach((s, i) => (ys[i] ? neg : pos).push(s)); // pos = not survived
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  const negSorted = [...neg].sort((a, b) => a - b);
  for (const p of pos) {
    let lo = 0,
      hi = negSorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (negSorted[m] < p) lo = m + 1;
      else hi = m;
    }
    let eq = lo;
    while (eq < negSorted.length && negSorted[eq] === p) eq++;
    wins += lo + (eq - lo) / 2;
  }
  return wins / (pos.length * neg.length);
}
const FEATURES = [
  "undone",
  "churn",
  "failAfter",
  "ownerBroad",
  "ownerStrict",
  "interrupted",
  "ctx",
  "side",
  "write",
];
function fitLogit(train, feats) {
  const w = new Array(feats.length + 1).fill(0);
  for (let it = 0; it < 400; it++) {
    const g = new Array(w.length).fill(0);
    for (const r of train) {
      const z = w[0] + feats.reduce((s, f, k) => s + w[k + 1] * r[f], 0);
      const p = 1 / (1 + Math.exp(-z));
      const err = p - (1 - r.survived); // predict "not survived"
      g[0] += err;
      feats.forEach((f, k) => (g[k + 1] += err * r[f]));
    }
    for (let k = 0; k < w.length; k++)
      w[k] -= (0.5 * g[k]) / train.length + 0.001 * w[k] * (k > 0 ? 1 : 0);
  }
  return (r) => w[0] + feats.reduce((s, f, k) => s + w[k + 1] * r[f], 0);
}
function crossValidated(feats, data) {
  const sessions = [...new Set(data.map((r) => r.e.s))].sort();
  const fold = new Map(sessions.map((s, i) => [s, i % 5]));
  const scored = [];
  for (let k = 0; k < 5; k++) {
    const model = fitLogit(
      data.filter((r) => fold.get(r.e.s) !== k),
      feats,
    );
    for (const r of data.filter((r) => fold.get(r.e.s) === k)) scored.push({ r, score: model(r) });
  }
  return scored;
}
function bootstrapCI(scored) {
  const bySess = new Map();
  for (const x of scored) (bySess.get(x.r.e.s) ?? bySess.set(x.r.e.s, []).get(x.r.e.s)).push(x);
  const keys = [...bySess.keys()];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const vals = [];
  for (let b = 0; b < 300; b++) {
    const sample = [];
    for (let i = 0; i < keys.length; i++)
      sample.push(...bySess.get(keys[Math.floor(rnd() * keys.length)]));
    const v = auroc(
      sample.map((x) => x.score),
      sample.map((x) => x.r.survived),
    );
    if (!Number.isNaN(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return [vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]];
}

const n = rows.length,
  survived = rows.filter((r) => r.survived).length;
console.log(
  `edits: ${edits.length}; failed/denied ${failed}, no significant lines ${tooShort}, outside git ${notInGit}, never committed ${neverCommitted}`,
);
console.log(
  `scored ${n} edits in ${new Set(rows.map((r) => r.e.s)).size} sessions: survived ${survived} (${((100 * survived) / n).toFixed(1)}%), file gone in the next commit ${deletedInCommit}`,
);
for (const f of FEATURES) {
  const on = rows.filter((r) => (f === "ctx" ? r.ctx > 0.3 : r[f]));
  const sv = on.filter((r) => r.survived).length;
  console.log(
    `  ${f.padEnd(12)} on ${String(on.length).padStart(4)}  survival when on ${on.length ? ((100 * sv) / on.length).toFixed(0) + "%" : "-"}  AUROC ${auroc(
      rows.map((r) => r[f]),
      rows.map((r) => r.survived),
    ).toFixed(3)}`,
  );
}
for (const [name, feats] of [
  ["all signals", FEATURES],
  [
    "without churn and undo (owner + errors + context)",
    FEATURES.filter((f) => f !== "churn" && f !== "undone"),
  ],
]) {
  const scored = crossValidated(feats, rows);
  const a = auroc(
    scored.map((x) => x.score),
    scored.map((x) => x.r.survived),
  );
  const [lo, hi] = bootstrapCI(scored);
  console.log(
    `combined, ${name}: AUROC ${a.toFixed(3)} (sessions held out), 95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
  );
}

// Durability: the same scoring with "still in HEAD" as the outcome.
const old = rows.filter((r) => r.atHead !== null).map((r) => ({ ...r, survived: r.atHead }));
const keptHead = old.filter((r) => r.survived).length;
console.log(
  `\ndurability: ${old.length} edits older than 2 days in ${new Set(old.map((r) => r.e.s)).size} sessions, still in HEAD ${keptHead} (${((100 * keptHead) / old.length).toFixed(1)}%)`,
);
for (const f of FEATURES) {
  const on = old.filter((r) => (f === "ctx" ? r.ctx > 0.3 : r[f]));
  const sv = on.filter((r) => r.survived).length;
  console.log(
    `  ${f.padEnd(12)} on ${String(on.length).padStart(4)}  in HEAD when on ${on.length ? ((100 * sv) / on.length).toFixed(0) + "%" : "-"}  AUROC ${auroc(
      old.map((r) => r[f]),
      old.map((r) => r.survived),
    ).toFixed(3)}`,
  );
}
for (const [name, feats] of [
  ["all signals", FEATURES],
  ["without churn and undo", FEATURES.filter((f) => f !== "churn" && f !== "undone")],
]) {
  const scored = crossValidated(feats, old);
  const a = auroc(
    scored.map((x) => x.score),
    scored.map((x) => x.r.survived),
  );
  const [lo, hi] = bootstrapCI(scored);
  console.log(
    `combined, ${name}: AUROC ${a.toFixed(3)} (sessions held out), 95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]`,
  );
}
