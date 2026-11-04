/** Bump when the schema changes; pre-1.0 a bump rebuilds the database from the logs. */
export const SCHEMA_VERSION = 5;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  path        TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL,
  project_path      TEXT,
  title             TEXT,
  agent_version     TEXT,
  git_branch        TEXT,
  entrypoint        TEXT,
  started_at        INTEGER,
  ended_at          INTEGER,
  reported_cost_usd REAL,
  lines_added       INTEGER,
  lines_removed     INTEGER,
  duration_ms       INTEGER,
  api_duration_ms   INTEGER,
  tool_duration_ms  INTEGER
);

CREATE TABLE IF NOT EXISTS turns (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  prompt_chars INTEGER NOT NULL,
  origin       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_calls (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  turn_id               TEXT,
  source                TEXT NOT NULL,
  ts                    INTEGER NOT NULL,
  model                 TEXT NOT NULL,
  input_tokens          INTEGER NOT NULL,
  output_tokens         INTEGER NOT NULL,
  thinking_tokens       INTEGER NOT NULL,
  cache_read_tokens     INTEGER NOT NULL,
  cache_write_5m_tokens INTEGER NOT NULL,
  cache_write_1h_tokens INTEGER NOT NULL,
  web_search_requests   INTEGER NOT NULL,
  stop_reason           TEXT,
  subagent_id           TEXT,
  agent                 TEXT,
  prefix_hash           TEXT,
  prompt_hash           TEXT,
  duration_ms           INTEGER
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  turn_id      TEXT,
  call_id      TEXT NOT NULL,
  source       TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  name         TEXT NOT NULL,
  mcp_server   TEXT,
  input_chars  INTEGER NOT NULL,
  target       TEXT,
  input_hash   TEXT NOT NULL,
  subagent_id  TEXT,
  agent        TEXT,
  result_ts    INTEGER,
  result_chars INTEGER,
  result_images INTEGER,
  is_error     INTEGER,
  denial       TEXT,
  result_hash  TEXT
);

-- What the agent itself counted and charged per model (Claude Code's cost-state), latest per file.
-- Tokens and cost come from the same record, so they can check our price table.
CREATE TABLE IF NOT EXISTS reported_usage (
  session_id         TEXT NOT NULL,
  source             TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd           REAL NOT NULL,
  PRIMARY KEY (session_id, source, model)
);

CREATE TABLE IF NOT EXISTS markers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn_id    TEXT,
  source     TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT
);

-- User-made marks ("new CLAUDE.md", "switched model"), used to compare before vs after.
-- Not derived from logs, so never deleted on re-ingest.
CREATE TABLE IF NOT EXISTS marks (
  name TEXT PRIMARY KEY,
  ts   INTEGER NOT NULL,
  note TEXT
);

CREATE INDEX IF NOT EXISTS turns_session      ON turns (session_id);
CREATE INDEX IF NOT EXISTS turns_source       ON turns (source);
CREATE INDEX IF NOT EXISTS api_calls_session  ON api_calls (session_id);
CREATE INDEX IF NOT EXISTS api_calls_source   ON api_calls (source);
CREATE INDEX IF NOT EXISTS api_calls_ts       ON api_calls (ts);
CREATE INDEX IF NOT EXISTS tool_calls_session ON tool_calls (session_id);
CREATE INDEX IF NOT EXISTS tool_calls_source  ON tool_calls (source);
CREATE INDEX IF NOT EXISTS markers_session    ON markers (session_id);
CREATE INDEX IF NOT EXISTS markers_source     ON markers (source);
`;
