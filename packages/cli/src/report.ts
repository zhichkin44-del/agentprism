import path from "node:path";
import type { Overview, Spend } from "@agentprism/core";
import type { ScanResult } from "./scan.js";
import { accent, bar, bold, compact, date, dim, int, pct, table, usd, warn } from "./format.js";

const out = (line = "") => process.stdout.write(line + "\n");
const indent = (lines: string[]) => lines.forEach((l) => out("  " + l));

export function printScan(r: ScanResult): void {
  out();
  out(`${bold(accent("◆ AgentPrism"))}  ${dim("local · private")}`);
  const changed = r.changed === r.files ? "all" : int(r.changed);
  out(
    dim(
      `Scanned ${int(r.files)} log files (${changed} read) · ${int(r.stats.lines)} lines · ${(
        r.durationMs / 1000
      ).toFixed(1)}s`,
    ),
  );
  const unknown = [...r.stats.unknownTypes].map(([t, n]) => `${t}×${n}`);
  if (unknown.length || r.stats.badLines) {
    out(
      warn(
        `Format drift: ${r.stats.badLines} unreadable lines; unknown record types: ${
          unknown.join(", ") || "none"
        }`,
      ),
    );
  }
}

export function printOverview(o: Overview): void {
  if (o.sessions === 0) {
    out();
    out("No sessions found. Use --root to point at your Claude Code logs.");
    return;
  }
  const t = o.tokens;

  out();
  indent(
    table(
      [
        [bold(int(o.sessions)), "sessions", bold(int(o.projects)), "projects"],
        [bold(int(o.turns)), "prompts", bold(int(o.apiCalls)), "model calls"],
      ],
      ["r", "l", "r", "l"],
    ),
  );
  out(dim(`  ${date(o.firstAt)} → ${date(o.lastAt)}`));

  out();
  out(bold(`Tokens  ${compact(t.total)}`));
  indent(
    table(
      [
        ["cache read", compact(t.cacheRead), pct(t.cacheRead, t.total), bar(t.cacheRead, t.total)],
        [
          "cache write",
          compact(t.cacheWrite),
          pct(t.cacheWrite, t.total),
          bar(t.cacheWrite, t.total),
        ],
        ["input", compact(t.input), pct(t.input, t.total), bar(t.input, t.total)],
        ["output", compact(t.output), pct(t.output, t.total), bar(t.output, t.total)],
        [dim("  thinking"), dim(compact(t.thinking)), dim(pct(t.thinking, t.output)), ""],
      ],
      ["l", "r", "r", "l"],
    ),
  );

  out();
  out(bold("Projects"));
  const maxProject = Math.max(...o.byProject.map((p) => p.tokens));
  indent(
    table(
      o.byProject
        .slice(0, 8)
        .map((p) => [
          path.basename(p.project) || p.project,
          `${p.sessions} sess`,
          compact(p.tokens),
          bar(p.tokens, maxProject),
        ]),
      ["l", "r", "r", "l"],
    ),
  );

  out();
  out(bold("Models"));
  indent(
    table(
      o.byModel.map((m) => [m.model, `${int(m.calls)} calls`, compact(m.tokens)]),
      ["l", "r", "r"],
    ),
  );

  out();
  out(
    bold("Tools  ") +
      `${int(o.toolCalls)} calls · ${warn(int(o.toolErrors))} errors (${pct(
        o.toolErrors,
        o.toolCalls,
      )}) · ${int(o.toolDenials)} denied`,
  );
  indent(
    table(
      o.topTools.map((x) => [
        x.name,
        int(x.calls),
        x.errors ? warn(`${int(x.errors)} err`) : dim("0 err"),
      ]),
      ["l", "r", "r"],
    ),
  );

  out();
  out(
    dim(
      `Compactions ${o.compactions} · interrupts ${o.interrupts} · subagent calls ${pct(
        o.subagentCalls,
        o.apiCalls,
      )}`,
    ),
  );
  out();
}

const shortTitle = (t: string | null, max = 44) => {
  const v = (t ?? "untitled").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
};
const projectName = (p: string | null) => (p ? path.basename(p) || p : "(unknown)");

export function printSpend(s: Spend, options: { brief?: boolean } = {}): void {
  const t = s.totals;
  out();
  out(`${bold(`Spend  ${usd(t.usd)}`)} ${dim(`API-equivalent · ${s.priceSource}`)}`);
  indent(
    table(
      [
        [
          "cache reads",
          usd(t.cacheReadUsd),
          pct(t.cacheReadUsd, t.usd),
          bar(t.cacheReadUsd, t.usd),
        ],
        [
          "cache writes",
          usd(t.cacheWriteUsd),
          pct(t.cacheWriteUsd, t.usd),
          bar(t.cacheWriteUsd, t.usd),
        ],
        ["output", usd(t.outputUsd), pct(t.outputUsd, t.usd), bar(t.outputUsd, t.usd)],
        ["input", usd(t.inputUsd), pct(t.inputUsd, t.usd), bar(t.inputUsd, t.usd)],
      ],
      ["l", "r", "r", "l"],
    ),
  );
  const saved = t.withoutCacheUsd - t.usd;
  out(
    dim(
      `  Caching saved ${usd(saved)} (${pct(saved, t.withoutCacheUsd)} of ${usd(t.withoutCacheUsd)}) · ${usd(
        t.prompts ? t.usd / t.prompts : 0,
      )} per prompt · ${usd(t.calls ? t.usd / t.calls : 0)} per model call`,
    ),
  );
  if (s.priceChecks.length) {
    const bad = s.priceChecks.filter((c) => c.status === "mismatch");
    const ok = s.priceChecks.filter((c) => c.status === "ok").map((c) => c.model);
    if (ok.length) out(dim(`  Prices match Claude Code's own cost records: ${ok.join(", ")}`));
    for (const c of bad) {
      out(
        warn(
          `  Price check: Claude Code charged ${usd(c.reportedUsd)} for ${c.model} tokens, our table gives ${usd(
            c.lowUsd,
          )}–${usd(c.highUsd)} — fix it in ~/.agentprism/prices.json`,
        ),
      );
    }
  }
  const unknown = s.byModel.filter((m) => !m.known);
  if (unknown.length) {
    out(
      warn(
        `  No price for: ${unknown.map((m) => m.model).join(", ")} — add it to ~/.agentprism/prices.json`,
      ),
    );
  }

  out();
  out(bold("Most expensive sessions"));
  indent(
    table(
      s.topSessions.map((x) => [
        date(x.startedAt),
        projectName(x.project),
        shortTitle(x.title),
        `${int(x.prompts)} prompts`,
        bold(usd(x.usd)),
        dim(`peak ${compact(x.peakContext)}`),
      ]),
      ["l", "l", "l", "r", "r", "l"],
    ),
  );
  if (options.brief) return;

  out();
  out(bold("Projects"));
  const maxProject = Math.max(0, ...s.byProject.map((p) => p.usd));
  indent(
    table(
      s.byProject.map((p) => [
        projectName(p.project),
        `${p.sessions} sess`,
        `${int(p.prompts)} prompts`,
        usd(p.usd),
        bar(p.usd, maxProject),
      ]),
      ["l", "r", "r", "r", "l"],
    ),
  );

  out();
  out(bold("Models"));
  indent(
    table(
      s.byModel.map((m) => [
        m.model,
        `${int(m.calls)} calls`,
        m.known ? usd(m.usd) : warn("no price"),
      ]),
      ["l", "r", "r"],
    ),
  );

  if (s.byAgent.length) {
    out();
    out(bold("Apps and agents"));
    indent(
      table(
        s.byAgent.map((a) => [
          a.app.replace(/^app:/, ""),
          a.agent,
          `${int(a.calls)} calls`,
          usd(a.usd),
          dim(a.avgMs === null ? "" : `${Math.round(a.avgMs)} ms avg`),
          dim(`cache ${pct(a.cacheReadShare, 1)}`),
        ]),
        ["l", "l", "r", "r", "r", "r"],
      ),
    );
  }

  out();
  out(bold(`Last ${s.byDay.length} active days`));
  const maxDay = Math.max(0, ...s.byDay.map((d) => d.usd));
  indent(
    table(
      s.byDay.map((d) => [d.day, usd(d.usd), bar(d.usd, maxDay, 30), dim(`${int(d.calls)} calls`)]),
      ["l", "r", "l", "l"],
    ),
  );

  out();
  out(bold("Most expensive prompts"));
  indent(
    table(
      s.topTurns.map((x) => [
        date(x.ts),
        projectName(x.project),
        shortTitle(x.title, 36),
        `prompt #${x.index}`,
        `${int(x.calls)} calls`,
        bold(usd(x.usd)),
      ]),
      ["l", "l", "l", "r", "r", "r"],
    ),
  );
  out();
}
