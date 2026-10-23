import path from "node:path";
import { sessionSpend, type DetectorRun, type Finding, type Store } from "@agentprism/core";
import { accent, bold, compact, date, dim, paint, table, usd, warn } from "./format.js";

const out = (line = "") => process.stdout.write(line + "\n");

const SEVERITY = {
  high: (t: string) => paint(["bold", "red"], t),
  warn: (t: string) => warn(t),
  info: (t: string) => dim(t),
};

interface SessionInfo {
  title: string | null;
  project: string | null;
  startedAt: number | null;
  usd: number;
}

/**
 * Detectors can flag the same calls (a loop inside a huge-context session), so the total is
 * capped per session at what the session cost. It is an estimate of what could be saved.
 */
export function potentialSavings(findings: Finding[], sessions: Map<string, SessionInfo>): number {
  const perSession = new Map<string, number>();
  for (const f of findings)
    perSession.set(f.sessionId, (perSession.get(f.sessionId) ?? 0) + f.wastedUsd);
  let total = 0;
  for (const [id, wasted] of perSession) total += Math.min(wasted, sessions.get(id)?.usd ?? wasted);
  return total;
}

export function printFindings(store: Store, runs: DetectorRun[], options: { top: number }): void {
  const sessions = new Map<string, SessionInfo>(sessionSpend(store).map((s) => [s.sessionId, s]));
  const all = runs.flatMap((r) => r.findings).sort((a, b) => b.wastedUsd - a.wastedUsd);
  const titles = new Map(runs.map((r) => [r.detector.id, r.detector.title]));
  const savings = potentialSavings(all, sessions);
  const spent = [...sessions.values()].reduce((t, s) => t + s.usd, 0);

  out();
  out(
    `${bold(`Findings  ${all.length}`)} ${dim(`from ${runs.length} detectors`)}  ·  ${bold(
      accent(`could save ≈ ${usd(savings)}`),
    )} ${dim(`(${spent ? ((savings / spent) * 100).toFixed(0) : 0}% of ${usd(spent)}, estimate)`)}`,
  );

  for (const [i, f] of all.slice(0, options.top).entries()) {
    const s = sessions.get(f.sessionId);
    const where = [
      s?.project ? path.basename(s.project) : "(unknown)",
      s?.title
        ? `"${s.title.length > 40 ? s.title.slice(0, 39) + "…" : s.title}"`
        : f.sessionId.slice(0, 8),
      date(s?.startedAt ?? null),
    ].join(" · ");
    out();
    out(
      `  ${dim(`${i + 1}.`)} ${SEVERITY[f.severity](f.severity.toUpperCase().padEnd(4))} ${bold(
        usd(f.wastedUsd).padStart(7),
      )}  ${titles.get(f.detector) ?? f.detector}  ${dim(where)}`,
    );
    out(`     ${f.title}`);
    for (const e of f.evidence) out(dim(`     · ${e}`));
    if (f.suggestion) out(`     ${accent("→")} ${f.suggestion}`);
  }
  if (all.length > options.top)
    out(dim(`\n  …and ${all.length - options.top} more (--top <n> to see them)`));

  out();
  out(bold("By detector"));
  const rows = runs.map((r) => {
    const sessionsHit = new Set(r.findings.map((f) => f.sessionId)).size;
    const wasted = r.findings.reduce((t, f) => t + f.wastedUsd, 0);
    const tokens = r.findings.reduce((t, f) => t + f.wastedTokens, 0);
    return [
      r.detector.title,
      `${r.findings.length} findings`,
      `${sessionsHit} sessions`,
      compact(tokens) + " tok",
      r.error ? warn(`error: ${r.error}`) : usd(wasted),
    ];
  });
  for (const line of table(rows, ["l", "r", "r", "r", "r"])) out("  " + line);
  out();
}
