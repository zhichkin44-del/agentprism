// Q1: the price of forgetting, measured by quality signals, and a reusable dataset of owner corrections.
//
// Unit: a pair (agent turn → the owner's next message). The agent turn is everything the model did
// between two owner messages: its last text, its actions, its cost. The owner message is classified by
// cues (Russian and English) into error types; structural signals (an interrupt, a denial with
// feedback, an exact undo of an edit) are recorded alongside. Then correction rates are compared
// before and after real compactions and across context sizes.
//
// Writes every pair, with texts, to .agentprism/research/owner-pairs.jsonl (gitignored, local only).
// Prints aggregates only. Format: docs/CORRECTIONS_FORMAT.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadSessions } from "./lib.mjs";

const OUT = path.resolve(".agentprism", "research");
const WINDOW = 10; // owner messages before / after a compaction

// Cues. Each type is a list of patterns; a message can have several types.
const CUES = {
  forgot_context: [
    /забыл/i,
    /не помнишь/i,
    /не запомнил/i,
    /я же (говорил|писал|просил|сказал)/i,
    /уже (говорил|писал|обсуждали|решили|делали)/i,
    /мы же (решили|договорились|обсуждали)/i,
    /напоминаю/i,
    /как я (говорил|писал|просил)/i,
    /ты сам (писал|предлагал|говорил|делал)/i,
    /you forgot/i,
    /i already (said|told)/i,
    /as i said/i,
    /\bremember\b/i,
  ],
  wrong: [
    /неправильн/i,
    /неверн/i,
    /не так\b/i,
    /ошибк/i,
    /\bне то\b/i,
    /не работает/i,
    /сломал/i,
    /\bwrong\b/i,
    /incorrect/i,
    /doesn'?t work/i,
    /\bbroken\b/i,
  ],
  revert: [/верни/i, /откати/i, /отмени/i, /как было/i, /\brevert\b/i, /\bundo\b/i, /roll ?back/i],
  overreach: [
    /не надо/i,
    /не нужно/i,
    /не трогай/i,
    /зачем (ты|это)/i,
    /я не просил/i,
    /^стоп\b/i,
    /\bstop\b/i,
    /don'?t /i,
  ],
  repeat: [/опять/i, /снова/i, /\bagain\b/i],
  rejection: [/^\s*(нет|no)\b[,.!\s]/i],
};
const MACHINE =
  /^\s*<(cross-session-message|side-sessions-event|task-notification|ci-monitor-event|command-|local-command|bash-|pasted)/;
const stripReminders = (t) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

function classify(text) {
  const types = [],
    cues = [];
  for (const [type, pats] of Object.entries(CUES)) {
    const hit = pats.find((p) => p.test(text));
    if (hit) {
      types.push(type);
      cues.push(String(hit));
    }
  }
  return { types, cues };
}

fs.mkdirSync(OUT, { recursive: true });
const outFile = fs.createWriteStream(path.join(OUT, "owner-pairs.jsonl"));

const stats = {
  owner: 0,
  corrections: 0,
  byType: {},
  interruptedTurns: 0,
  interruptedCorrections: 0,
  deniedFeedback: 0,
  deniedFeedbackCorrections: 0,
  undos: 0,
  undosAfterCorrection: 0,
};
const compactionWindows = {
  before: { n: 0, corr: 0, forgot: 0 },
  after: { n: 0, corr: 0, forgot: 0 },
};
const bySize = {};
let correctedTurnUsd = [];

for (const [sessionId, events] of loadSessions()) {
  // Owner prompts in order, with the agent turn that precedes each.
  const pairs = [];
  let turn = newTurn(),
    compactedSinceLastPrompt = false,
    callsSinceCompaction = 0,
    lastCtx = 0;
  const edits = []; // { file, old, new, pairIdx }
  for (const e of events) {
    if (e.t === "compact") {
      compactedSinceLastPrompt = true;
      callsSinceCompaction = 0;
      continue;
    }
    if (e.t === "call") {
      if (lastCtx > 100_000 && e.ctx < lastCtx * 0.5) {
        compactedSinceLastPrompt = true;
        callsSinceCompaction = 0;
      }
      lastCtx = e.ctx;
      callsSinceCompaction++;
      turn.calls++;
      turn.usd += e.ctxUsd + e.outUsd;
      turn.ctx = e.ctx;
      continue;
    }
    if (e.kind === "assistant_text" && e.text.trim()) turn.lastText = e.text;
    else if (e.kind === "tool_use") {
      turn.actions.push({ tool: e.tool, target: e.target ?? null });
      if (e.tool === "Edit") {
        try {
          const inp = JSON.parse(e.text);
          edits.push({
            file: inp.file_path,
            old: inp.old_string,
            new: inp.new_string,
            pairIdx: pairs.length,
          });
        } catch {
          /* malformed input: skip */
        }
      }
    } else if (
      e.kind === "tool_result" &&
      e.denial === "user-rejected" &&
      /said|feedback|reason|сказал/i.test(e.text)
    ) {
      turn.deniedFeedback = true;
    } else if (e.kind === "user_prompt") {
      if (e.text.startsWith("[Request interrupted")) {
        turn.interrupted = true;
        continue;
      }
      if (e.origin && e.origin !== "human") continue;
      const text = stripReminders(e.text);
      if (!text || MACHINE.test(text)) continue;
      pairs.push({
        turn,
        text,
        e,
        afterCompaction: compactedSinceLastPrompt,
        callsSinceCompaction,
      });
      turn = newTurn();
      compactedSinceLastPrompt = false;
    }
  }
  // Exact undo: an Edit that swaps back an earlier edit of the same file. Owner-caught if a correction
  // came between them.
  for (let i = 0; i < edits.length; i++)
    for (let j = 0; j < i; j++) {
      const a = edits[j],
        b = edits[i];
      if (a.file === b.file && a.new && a.old !== undefined && b.old === a.new && b.new === a.old) {
        b.undo = true;
        const p = pairs[b.pairIdx];
        if (p) p.undoAfter = (p.undoAfter ?? 0) + 1;
      }
    }

  // Classify and write.
  let ownerIdx = 0;
  const compactionAt = [];
  pairs.forEach((p, i) => {
    if (p.afterCompaction && i > 0) compactionAt.push(i);
  });
  for (const [i, p] of pairs.entries()) {
    ownerIdx++;
    stats.owner++;
    const { types, cues } = classify(p.text);
    // The first owner message of a session answers nothing: no agent turn before it.
    const hasTurn = i > 0 && p.turn.calls > 0;
    const isCorrection = hasTurn && types.length > 0;
    p.isCorrection = isCorrection;
    p.forgot = isCorrection && types.includes("forgot_context");
    // Strict: the cue sits in the opening of the message, where a correction usually is, and generic
    // "don't"/"stop"/"не нужно" instructions are not counted.
    const head = p.text.slice(0, 160);
    const strictTypes = classify(head).types.filter(
      (t) => t !== "overreach" || /не трогай|зачем (ты|это)|я не просил/i.test(head),
    );
    p.strict = hasTurn && strictTypes.length > 0;
    if (p.strict) stats.strict = (stats.strict ?? 0) + 1;
    if (hasTurn && p.turn.interrupted) {
      stats.interruptedTurns++;
      if (isCorrection) stats.interruptedCorrections++;
    }
    if (hasTurn && p.turn.deniedFeedback) {
      stats.deniedFeedback++;
      if (isCorrection) stats.deniedFeedbackCorrections++;
    }
    if (p.undoAfter) {
      stats.undos += p.undoAfter;
      if (isCorrection) stats.undosAfterCorrection += p.undoAfter;
    }
    if (isCorrection) {
      stats.corrections++;
      for (const t of types) stats.byType[t] = (stats.byType[t] ?? 0) + 1;
      correctedTurnUsd.push(p.turn.usd);
    }
    if (hasTurn) {
      const b =
        p.turn.ctx < 100_000
          ? "<100K"
          : p.turn.ctx < 300_000
            ? "100-300K"
            : p.turn.ctx < 600_000
              ? "300-600K"
              : ">600K";
      const s = (bySize[b] ??= { n: 0, corr: 0, forgot: 0, strict: 0 });
      s.n++;
      if (isCorrection) s.corr++;
      if (p.forgot) s.forgot++;
      if (p.strict) s.strict++;
    }
    const conf =
      (p.turn.interrupted ? 0.3 : 0) +
      (p.turn.deniedFeedback ? 0.3 : 0) +
      (p.undoAfter ? 0.2 : 0) +
      Math.min(0.5, 0.25 * types.length);
    outFile.write(
      JSON.stringify({
        schema: "agentprism.owner-pair.v1",
        id: crypto
          .createHash("sha1")
          .update(sessionId + (p.e.uuid ?? p.e.ts))
          .digest("hex")
          .slice(0, 16),
        source: {
          agent: "claude-code",
          session: sessionId,
          project: p.e.cwd ? path.basename(p.e.cwd) : null,
          ts: new Date(p.e.ts).toISOString(),
          owner_message_index: ownerIdx,
        },
        model_output: hasTurn
          ? {
              text: p.turn.lastText ?? "",
              actions: p.turn.actions,
              calls: p.turn.calls,
              usd: +p.turn.usd.toFixed(4),
            }
          : null,
        owner_message: { text: p.text },
        signals: {
          interrupted: !!p.turn.interrupted,
          denied_with_feedback: !!p.turn.deniedFeedback,
          edits_undone_after: p.undoAfter ?? 0,
          cues,
        },
        is_correction: isCorrection,
        error_type: isCorrection ? types : [],
        context: {
          tokens: p.turn.ctx ?? null,
          calls_since_compaction: p.callsSinceCompaction,
          after_compaction: p.afterCompaction,
        },
        label: {
          by: "heuristic-v1",
          confidence: isCorrection ? +Math.min(1, conf).toFixed(2) : 0,
          human: null,
        },
      }) + "\n",
    );
  }
  // Correction rates in the owner messages just before / after each compaction.
  // Each owner message counts once: "after" wins when windows of two compactions overlap.
  const side = new Map();
  for (const c of compactionAt)
    for (let i = Math.max(1, c - WINDOW); i < c; i++) if (!side.has(i)) side.set(i, "before");
  for (const c of compactionAt)
    for (let i = c; i < Math.min(pairs.length, c + WINDOW); i++) side.set(i, "after");
  stats.compactions = (stats.compactions ?? 0) + compactionAt.length;
  for (const [i, s] of side) {
    const w = compactionWindows[s];
    w.n++;
    if (pairs[i].isCorrection) w.corr++;
    if (pairs[i].forgot) w.forgot++;
    if (pairs[i].strict) w.strict = (w.strict ?? 0) + 1;
  }
}
outFile.end();

function newTurn() {
  return {
    calls: 0,
    usd: 0,
    ctx: 0,
    actions: [],
    lastText: null,
    interrupted: false,
    deniedFeedback: false,
  };
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + "%" : "-");
correctedTurnUsd.sort((a, b) => a - b);
const median = correctedTurnUsd[Math.floor(correctedTurnUsd.length / 2)] ?? 0;
// 95% interval for a difference of two proportions (normal approximation).
const diffCI = (a, b) => {
  const p1 = a.corr / a.n,
    p2 = b.corr / b.n;
  const se = Math.sqrt((p1 * (1 - p1)) / a.n + (p2 * (1 - p2)) / b.n);
  return [(p2 - p1 - 1.96 * se) * 100, (p2 - p1 + 1.96 * se) * 100].map((x) => x.toFixed(1));
};
console.log(
  `owner messages ${stats.owner}; corrections (heuristic) ${stats.corrections} = ${pct(stats.corrections, stats.owner)}`,
);
console.log(`by type ${JSON.stringify(stats.byType)}`);
console.log(
  `structural check: after an interrupted turn ${stats.interruptedCorrections}/${stats.interruptedTurns} flagged; after a denial with feedback ${stats.deniedFeedbackCorrections}/${stats.deniedFeedback}; exact edit undos ${stats.undos}, of them after a flagged correction ${stats.undosAfterCorrection}`,
);
console.log(`median cost of a corrected agent turn $${median.toFixed(2)}`);
const { before, after } = compactionWindows;
console.log(
  `around compactions (${WINDOW} owner messages each side): corrections before ${before.corr}/${before.n} = ${pct(before.corr, before.n)}, after ${after.corr}/${after.n} = ${pct(after.corr, after.n)}; difference 95% CI [${diffCI(before, after).join(", ")}] points`,
);
console.log(`  "you forgot" cues: before ${before.forgot}, after ${after.forgot}`);
for (const b of ["<100K", "100-300K", "300-600K", ">600K"]) {
  const s = bySize[b];
  if (s)
    console.log(
      `context ${b.padEnd(9)} turns ${String(s.n).padStart(4)}  corrections ${pct(s.corr, s.n).padStart(6)}  "you forgot" ${s.forgot}`,
    );
}
console.log(`dataset: ${path.join(OUT, "owner-pairs.jsonl")} (local, gitignored)`);
console.log(
  `strict variant: corrections ${stats.strict} = ${pct(stats.strict, stats.owner)}; around ${stats.compactions} compactions before ${before.strict ?? 0}/${before.n}, after ${after.strict ?? 0}/${after.n}; difference 95% CI [${diffCI({ n: before.n, corr: before.strict ?? 0 }, { n: after.n, corr: after.strict ?? 0 }).join(", ")}] points`,
);
for (const b of ["<100K", "100-300K", "300-600K", ">600K"])
  if (bySize[b])
    console.log(`  strict, context ${b.padEnd(9)} ${pct(bySize[b].strict, bySize[b].n)}`);
const mean = correctedTurnUsd.reduce((s, x) => s + x, 0) / (correctedTurnUsd.length || 1);
console.log(`mean cost of a corrected agent turn $${mean.toFixed(2)}`);
