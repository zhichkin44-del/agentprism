// R1 step 1: how does the measured context growth between two calls relate to what entered it?
// Fits  Δctx ≈ a·visibleOutput + b·thinking + c·chars + d·images  over intervals with no compaction.
// Tells whether thinking stays in context and how many characters make a token. Prints aggregates.
import { loadSessions } from "./lib.mjs";

const rows = [];
let negative = 0,
  intervals = 0,
  newTurnNeg = 0,
  newTurn = 0;
for (const events of loadSessions().values()) {
  let prev = null,
    chars = 0,
    images = 0,
    compact = false,
    human = false,
    tr = 0,
    att = 0,
    usr = 0;
  for (const e of events) {
    if (e.t === "compact") compact = true;
    else if (e.t === "block") {
      if (e.by) continue; // assistant output is measured by its tokens, not characters
      chars += e.text.length;
      if (e.kind === "tool_result") tr += e.text.length;
      else if (e.kind === "attachment") att += e.text.length;
      else usr += e.text.length;
      images += e.images ?? 0;
      if (e.kind === "user_prompt") human = true;
    } else if (e.t === "call") {
      if (prev && !compact && e.ctx > prev.ctx * 0.5) {
        const d = e.ctx - prev.ctx;
        intervals++;
        if (d < 0) negative++;
        if (human) {
          newTurn++;
          if (d < 0) newTurnNeg++;
        }
        rows.push({
          d,
          vis: prev.usage.out - prev.usage.think,
          think: prev.usage.think,
          chars,
          images,
          human,
          tr,
          att,
          usr,
        });
      }
      prev = e;
      chars = 0;
      images = 0;
      compact = false;
      human = false;
      tr = 0;
      att = 0;
      usr = 0;
    }
  }
}

function fit(rs, cols) {
  const X = rs.map((r) => cols.map((c) => r[c])),
    y = rs.map((r) => r.d),
    n = cols.length;
  const A = cols.map((_, i) => cols.map((_, j) => X.reduce((s, x) => s + x[i] * x[j], 0)));
  const b = cols.map((_, i) => X.reduce((s, x, k) => s + x[i] * y[k], 0));
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]];
    [b[i], b[p]] = [b[p], b[i]];
    for (let k = i + 1; k < n; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j < n; j++) A[k][j] -= f * A[i][j];
      b[k] -= f * b[i];
    }
  }
  const w = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--)
    w[i] =
      (b[i] - cols.slice(i + 1).reduce((s, _, j) => s + A[i][i + 1 + j] * w[i + 1 + j], 0)) /
      A[i][i];
  const pred = X.map((x) => x.reduce((s, v, i) => s + v * w[i], 0));
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  const r2 =
    1 - y.reduce((s, v, k) => s + (v - pred[k]) ** 2, 0) / y.reduce((s, v) => s + (v - my) ** 2, 0);
  return { w: Object.fromEntries(cols.map((c, i) => [c, +w[i].toFixed(4)])), r2: +r2.toFixed(3) };
}

console.log(
  "intervals",
  intervals,
  "with Δ<0",
  negative,
  "| after a human prompt",
  newTurn,
  "with Δ<0",
  newTurnNeg,
);
const mid = rows.filter((r) => !r.human),
  turn = rows.filter((r) => r.human);
console.log(
  "within a turn  ",
  rows.length && JSON.stringify(fit(mid, ["vis", "think", "chars", "images"])),
);
console.log("at a new prompt", JSON.stringify(fit(turn, ["vis", "think", "chars", "images"])));
const sum = (rs, k) => rs.reduce((s, r) => s + r[k], 0);
console.log(
  "totals within turns: Δ",
  sum(mid, "d"),
  "vis",
  sum(mid, "vis"),
  "think",
  sum(mid, "think"),
  "chars",
  sum(mid, "chars"),
);
console.log(
  "totals at prompts:   Δ",
  sum(turn, "d"),
  "vis",
  sum(turn, "vis"),
  "think",
  sum(turn, "think"),
  "chars",
  sum(turn, "chars"),
);
console.log(
  "split within turns",
  JSON.stringify(fit(mid, ["vis", "think", "tr", "att", "usr", "images"])),
);
console.log(
  "split all         ",
  JSON.stringify(fit(rows, ["vis", "think", "tr", "att", "usr", "images"])),
);
console.log(
  "chars: tool results",
  sum(rows, "tr"),
  "attachments",
  sum(rows, "att"),
  "user",
  sum(rows, "usr"),
);
