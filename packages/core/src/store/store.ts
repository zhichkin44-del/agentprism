import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SourceFile } from "../plugin.js";
import { DEFAULT_PRICES, type PriceTable } from "../pricing/prices.js";
import { installPricing } from "../pricing/sql.js";
import type { AgentEvent, AgentId } from "../schema.js";
import { SCHEMA, SCHEMA_VERSION } from "./schema-sql.js";

type SqlValue = string | number | null;

/** sqlite rejects `undefined`; optional fields become NULL. */
const v = (x: string | number | boolean | undefined): SqlValue =>
  x === undefined ? null : typeof x === "boolean" ? Number(x) : x;

export interface SourceState {
  size: number;
  mtimeMs: number;
}

/**
 * Local SQLite store. Rows that come from a log file remember their `source`, so a changed
 * file is re-ingested by deleting its rows and reading it again: idempotent and simple.
 */
export class Store {
  readonly db: DatabaseSync;
  /** Prices behind the `ap_cost(...)` SQL function on this connection. */
  readonly prices: PriceTable;
  private readonly stmt: ReturnType<Store["prepare"]>;

  static open(file: string, prices: PriceTable = DEFAULT_PRICES): Store {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    return new Store(new DatabaseSync(file), prices);
  }

  private constructor(db: DatabaseSync, prices: PriceTable) {
    this.db = db;
    this.prices = prices;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.migrate();
    installPricing(db, prices);
    this.stmt = this.prepare();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === SCHEMA_VERSION) return;
    if (row.user_version !== 0) {
      // Pre-1.0 the database is a cache of the logs: rebuilding it is always safe.
      // Marks are the user's own data, not a cache of the logs, so they survive (table not dropped).
      for (const t of ["sources", "sessions", "turns", "api_calls", "tool_calls", "markers"]) {
        this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      }
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  private prepare() {
    const p = (sql: string): StatementSync => this.db.prepare(sql);
    return {
      sourceState: p("SELECT size, mtime_ms AS mtimeMs FROM sources WHERE path = ?"),
      upsertSource: p(
        `INSERT INTO sources (path, agent, size, mtime_ms, ingested_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           ingested_at = excluded.ingested_at`,
      ),
      deleteBySource: ["turns", "api_calls", "tool_calls", "markers"].map((t) =>
        p(`DELETE FROM ${t} WHERE source = ?`),
      ),
      upsertSession: p(
        `INSERT INTO sessions (id, agent, project_path, title, agent_version, git_branch, entrypoint)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_path = COALESCE(sessions.project_path, excluded.project_path),
           title = COALESCE(excluded.title, sessions.title),
           agent_version = COALESCE(excluded.agent_version, sessions.agent_version),
           git_branch = COALESCE(sessions.git_branch, excluded.git_branch),
           entrypoint = COALESCE(sessions.entrypoint, excluded.entrypoint)`,
      ),
      sessionTotals: p(
        `UPDATE sessions SET reported_cost_usd = ?, lines_added = ?, lines_removed = ?,
           duration_ms = ?, api_duration_ms = ?, tool_duration_ms = ? WHERE id = ?`,
      ),
      // INSERT OR IGNORE: resumed sessions repeat earlier records in a new file; count them once.
      insertTurn: p(
        `INSERT OR IGNORE INTO turns (id, session_id, source, idx, ts, prompt_chars, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertApiCall: p(
        `INSERT OR IGNORE INTO api_calls (id, session_id, turn_id, source, ts, model,
           input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
           cache_write_5m_tokens, cache_write_1h_tokens, web_search_requests, stop_reason, subagent_id,
           agent, prefix_hash, prompt_hash, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      insertToolCall: p(
        `INSERT OR IGNORE INTO tool_calls (id, session_id, turn_id, call_id, source, ts, name,
           mcp_server, input_chars, target, input_hash, subagent_id, agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      toolResult: p(
        `UPDATE tool_calls SET result_ts = ?, result_chars = ?, result_images = ?, is_error = ?,
           denial = ? WHERE id = ?`,
      ),
      insertMarker: p(
        `INSERT INTO markers (session_id, turn_id, source, ts, type, data) VALUES (?, ?, ?, ?, ?, ?)`,
      ),
    };
  }

  /** What we know about a source file from the last ingest, if anything. */
  sourceState(filePath: string): SourceState | undefined {
    return this.stmt.sourceState.get(filePath) as SourceState | undefined;
  }

  /** Replaces everything previously ingested from `file` with `events`, atomically. */
  async ingest(file: SourceFile, events: AsyncIterable<AgentEvent>): Promise<number> {
    let count = 0;
    this.db.exec("BEGIN");
    try {
      for (const s of this.stmt.deleteBySource) s.run(file.path);
      for await (const ev of events) {
        this.apply(ev, file.agent, file.path);
        count++;
      }
      this.stmt.upsertSource.run(file.path, file.agent, file.size, file.mtimeMs, Date.now());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return count;
  }

  private apply(ev: AgentEvent, agent: AgentId, source: string): void {
    const s = this.stmt;
    switch (ev.kind) {
      case "session":
        s.upsertSession.run(
          ev.sessionId,
          agent,
          v(ev.projectPath),
          v(ev.title),
          v(ev.agentVersion),
          v(ev.gitBranch),
          v(ev.entrypoint),
        );
        break;
      case "session_totals":
        s.sessionTotals.run(
          v(ev.costUsd),
          v(ev.linesAdded),
          v(ev.linesRemoved),
          v(ev.durationMs),
          v(ev.apiDurationMs),
          v(ev.toolDurationMs),
          ev.sessionId,
        );
        break;
      case "turn":
        s.insertTurn.run(
          ev.turnId,
          ev.sessionId,
          source,
          ev.index,
          ev.ts,
          ev.promptChars,
          ev.origin,
        );
        break;
      case "api_call": {
        const u = ev.usage;
        s.insertApiCall.run(
          ev.callId,
          ev.sessionId,
          v(ev.turnId),
          source,
          ev.ts,
          ev.model,
          u.inputTokens,
          u.outputTokens,
          u.thinkingTokens,
          u.cacheReadTokens,
          u.cacheWrite5mTokens,
          u.cacheWrite1hTokens,
          u.webSearchRequests,
          v(ev.stopReason),
          v(ev.subagentId),
          v(ev.agent),
          v(ev.prefixHash),
          v(ev.promptHash),
          v(ev.durationMs),
        );
        break;
      }
      case "tool_call":
        s.insertToolCall.run(
          ev.toolUseId,
          ev.sessionId,
          v(ev.turnId),
          ev.callId,
          source,
          ev.ts,
          ev.name,
          v(ev.mcpServer),
          ev.inputChars,
          v(ev.target),
          ev.inputHash,
          v(ev.subagentId),
          v(ev.agent),
        );
        break;
      case "tool_result":
        s.toolResult.run(
          ev.ts,
          ev.resultChars,
          ev.resultImages,
          v(ev.isError),
          v(ev.denial),
          ev.toolUseId,
        );
        break;
      case "marker":
        s.insertMarker.run(
          ev.sessionId,
          v(ev.turnId),
          source,
          ev.ts,
          ev.type,
          ev.data ? JSON.stringify(ev.data) : null,
        );
        break;
    }
  }

  /** Recomputes derived session fields after ingest. */
  finalize(): void {
    this.db.exec(`
      UPDATE sessions SET
        started_at = (SELECT MIN(ts) FROM (
          SELECT ts FROM turns WHERE session_id = sessions.id
          UNION ALL SELECT ts FROM api_calls WHERE session_id = sessions.id)),
        ended_at = (SELECT MAX(ts) FROM (
          SELECT ts FROM turns WHERE session_id = sessions.id
          UNION ALL SELECT ts FROM api_calls WHERE session_id = sessions.id))
    `);
  }

  /** Records a named point in time to compare before vs after. */
  mark(name: string, ts = Date.now(), note?: string): void {
    this.db
      .prepare(
        `INSERT INTO marks (name, ts, note) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ts = excluded.ts, note = excluded.note`,
      )
      .run(name, ts, note ?? null);
  }

  marks(): { name: string; ts: number; note: string | null }[] {
    return this.db.prepare("SELECT name, ts, note FROM marks ORDER BY ts").all() as {
      name: string;
      ts: number;
      note: string | null;
    }[];
  }

  close(): void {
    this.db.close();
  }
}
