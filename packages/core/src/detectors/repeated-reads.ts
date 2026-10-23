import type { Detector, Finding } from "../plugin.js";
import { approxTokens, sessionPrice, severityFor, shortPath } from "./util.js";

const MIN_READS_IN_SESSION = 3;
const MIN_SESSIONS_FOR_FILE = 3;
const READ_TOOLS = "('Read', 'NotebookRead')";

/** The same file read again and again within one session. */
export const repeatedReads: Detector = {
  id: "repeated-reads",
  title: "Repeated file reads",
  description:
    "The agent reads the same file many times in one session, paying for its content each time.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT session_id AS sessionId, target, COUNT(*) AS n,
           SUM(COALESCE(result_chars, 0)) AS chars,
           json_group_array(DISTINCT turn_id) AS turns
         FROM tool_calls
         WHERE name IN ${READ_TOOLS} AND target IS NOT NULL AND COALESCE(is_error, 0) = 0
         GROUP BY session_id, target HAVING n >= ?
         ORDER BY session_id, n DESC`,
      )
      .all(MIN_READS_IN_SESSION) as {
      sessionId: string;
      target: string;
      n: number;
      chars: number;
      turns: string;
    }[];

    const bySession = new Map<string, typeof rows>();
    for (const r of rows) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);

    const findings: Finding[] = [];
    for (const [sessionId, files] of bySession) {
      const price = sessionPrice(store, sessionId);
      // Everything after the first read of each file; the first one was needed.
      const tokens = files.reduce((t, f) => t + approxTokens(f.chars - f.chars / f.n), 0);
      const usd = (tokens * (price?.cacheWrite5m ?? 0)) / 1e6;
      const reads = files.reduce((t, f) => t + f.n, 0);
      findings.push({
        detector: "repeated-reads",
        severity: severityFor(usd),
        sessionId,
        turnIds: [
          ...new Set(
            files.flatMap((f) =>
              (JSON.parse(f.turns) as (string | null)[]).filter((t): t is string => !!t),
            ),
          ),
        ],
        title: `${files.length} files were read ${reads} times in total`,
        evidence: files.slice(0, 3).map((f) => `${f.n}× ${shortPath(f.target, 70)}`),
        wastedTokens: tokens,
        wastedUsd: usd,
        suggestion:
          "Ask for targeted reads (Grep, line ranges), and put the key facts of files the agent keeps returning to into CLAUDE.md.",
      });
    }
    return findings;
  },
};

/**
 * The same file read from scratch in many separate sessions: knowledge the agent rediscovers
 * every time because it is not in the project memory.
 */
export const rediscovery: Detector = {
  id: "rediscovery",
  title: "Rediscovered files",
  description:
    "Files every new session has to read again — a sign that project knowledge is missing from CLAUDE.md.",
  run({ store }) {
    const rows = store.db
      .prepare(
        `SELECT s.project_path AS project, tc.target, COUNT(DISTINCT tc.session_id) AS sessions,
           json_group_array(DISTINCT tc.session_id) AS sessionIds,
           SUM(COALESCE(tc.result_chars, 0)) AS chars, COUNT(*) AS reads,
           MAX(tc.ts) AS lastTs
         FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
         WHERE tc.name IN ${READ_TOOLS} AND tc.target IS NOT NULL AND COALESCE(tc.is_error, 0) = 0
         GROUP BY s.project_path, tc.target HAVING sessions >= ?
         ORDER BY sessions DESC`,
      )
      .all(MIN_SESSIONS_FOR_FILE) as {
      project: string | null;
      target: string;
      sessions: number;
      sessionIds: string;
      chars: number;
      reads: number;
      lastTs: number;
    }[];

    const byProject = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.project ?? "(unknown)";
      byProject.set(key, [...(byProject.get(key) ?? []), r]);
    }

    const latestSession = store.db.prepare(
      `SELECT id FROM sessions WHERE project_path IS ? ORDER BY ended_at DESC LIMIT 1`,
    );
    const findings: Finding[] = [];
    for (const [project, files] of byProject) {
      const sessionId = (
        latestSession.get(project === "(unknown)" ? null : project) as { id: string } | undefined
      )?.id;
      if (!sessionId) continue;
      const price = sessionPrice(store, sessionId);
      // Every session after the first paid to learn the file again.
      const tokens = files.reduce(
        (t, f) => t + approxTokens((f.chars / f.reads) * (f.sessions - 1)),
        0,
      );
      const usd = (tokens * (price?.cacheWrite5m ?? 0)) / 1e6;
      findings.push({
        detector: "rediscovery",
        severity: files.length >= 5 ? "warn" : "info",
        sessionId,
        turnIds: [],
        title: `${files.length} files are re-read from scratch in ${Math.max(...files.map((f) => f.sessions))}+ separate sessions`,
        evidence: files
          .slice(0, 5)
          .map((f) => `${f.sessions} sessions: ${shortPath(f.target, 70)}`),
        wastedTokens: tokens,
        wastedUsd: usd,
        suggestion:
          "Summarize these files in the project's CLAUDE.md (purpose, key functions, conventions) so new sessions start with that knowledge.",
      });
    }
    return findings;
  },
};
