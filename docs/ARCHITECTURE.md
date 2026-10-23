# Architecture

## Modules (D15)

Everything the product does is a module inside a plugin; built-ins are registered exactly like third-party ones.

| Module kind | Interface  | Built-in examples                                    |
| ----------- | ---------- | ---------------------------------------------------- |
| Adapter     | `Adapter`  | `claude-code`                                        |
| Detector    | `Detector` | `context-growth`, `cache-rebuilds`, `loops`, … (8)   |
| Fix         | `Fix`      | planned (M5)                                         |
| View        | —          | terminal reports in `cli`; JSON output for any other |

```ts
// my-plugin.mjs — load with: agentprism findings --plugin ./my-plugin.mjs
export default {
  name: "my-plugin",
  detectors: [
    {
      id: "my-check",
      title: "…",
      description: "…",
      run({ store }) {
        return [/* Finding */];
      },
    },
  ],
};
```

Detectors get an `AnalysisContext` (`store` with `ap_cost()` registered in SQL) and return `Finding`s
with evidence, estimated waste and a suggestion. A throwing module is reported and skipped; the rest still run.

## Runtime layer: the SDK (D20–D23)

```
your app ──► prism.instrument(client).messages.create(params)
               │  before modules (router: change model · cache: answer without calling)
               ▼
             provider call (unchanged client, unchanged promise when no modules)
               │  after modules (guard: check / replace)
               ▼
             trace event ──► ~/.agentprism/traces/<app>/<day>.jsonl ──► adapter-traces ──► store
```

Session, turn and agent ride in `AsyncLocalStorage` (`withSession`, `withTurn`, `withAgent`), so multi-agent
code needs no extra arguments. `prism.tool(name, fn)` traces tool runs. Format: `TRACE_FORMAT.md`.

## Product shape

One npm package, one command. `npx agentprism` runs a CLI that scans logs into a local SQLite
database (incrementally) and prints the analysis. Terminal first (D14); a web app comes later as one more view.
No Electron, no native modules, no account. Desktop tray app and editor extensions come later
as thin shells over the same local server (see ROADMAP v1.0).

## Data flow

```
 agent logs on disk                     plugins
 ┌───────────────────────┐   ┌──────────────────────────────┐
 │ ~/.claude/projects    │──▶│ Adapter: claude-code         │
 │ (later: Codex, Cursor,│──▶│ Adapter: codex, gemini, ...  │
 │  Gemini CLI, ...)     │   └──────────────┬───────────────┘
 └───────────────────────┘                  │ normalized events (core schema)
                                            ▼
                               ┌───────────────────────────┐
                               │ Store: SQLite (node:sqlite)│  ~/.agentprism/agentprism.db
                               │ incremental, idempotent    │
                               └─────────────┬─────────────┘
                     ┌───────────────────────┼────────────────────────┐
                     ▼                       ▼                        ▼
               Analytics               Detectors (plugins)       Fixes (plugins)
               cost, tokens,           loops, bloat, failures    patches for CLAUDE.md,
               cache, context          → Findings with evidence  settings, MCP config
                     └───────────────────────┬────────────────────────┘
                                             ▼
                              Local HTTP API (JSON)
                       ┌─────────────┼──────────────┐
                       ▼             ▼              ▼
                   Web app      Terminal report   --json / exports
                                                  (later: OTLP, MCP server)
```

## Repository layout

```
.
├── CLAUDE.md                     working agreement for the agent
├── README.md                     public face
├── docs/                         VISION, ROADMAP, LAUNCH, PLAN, PROGRESS, DECISIONS, ARCHITECTURE, LOG_FORMAT, METRICS
├── packages/
│   ├── core/                     schema, plugin interfaces, store, analytics, built-in detectors and fixes, pricing
│   ├── adapter-claude-code/      Claude Code log reader (+ test/fixtures: synthetic logs only)
│   ├── web/                      React app (built to static files)
│   └── cli/                      `agentprism` bin: scan, report, server, opens the browser; bundles web dist
└── _archive/                     private, gitignored
```

Only `cli` is published to npm; it bundles `core`, the adapters and the built web app.
Runtime dependencies: none (Node built-ins only: `node:sqlite`, `node:util` parseArgs/styleText).
More adapters = more folders under `packages/adapter-*`.

## Plugin interfaces (draft, frozen at v1.0)

```ts
interface Adapter {
  id: string; // "claude-code"
  discover(): Promise<SourceFile[]>; // where the logs are on this machine
  read(file: SourceFile): AsyncIterable<Event>; // normalized events, never throws on unknown data
}

interface Detector {
  id: string; // "loops"
  title: string;
  run(ctx: AnalysisContext): Promise<Finding[]>;
}

interface Finding {
  detector: string;
  severity: "info" | "warn" | "high";
  sessionId: string;
  turnRefs: string[]; // evidence: exact turns
  wastedTokens?: number; // estimate, for ranking
  message: string;
  fixIds?: string[];
}

interface Fix {
  id: string;
  appliesTo(f: Finding): boolean;
  propose(ctx: FixContext): Promise<Patch>; // a diff the user reviews; never applied silently
}
```

## Core schema (draft, refined in M1)

Field names follow OpenTelemetry GenAI semantic conventions where they exist
(`gen_ai.usage.input_tokens`, `gen_ai.request.model`, ...), so OTLP export later is a mapping, not a redesign.

| Entity   | Key fields                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Source   | agent id, file path, size, mtime (for incremental ingest)                                               |
| Project  | id, cwd, display name                                                                                   |
| Session  | id, project, agent, started/ended, agent version, title, git branch                                     |
| Turn     | one user prompt and everything until the next one                                                       |
| ApiCall  | request id, model, input / output / cache read / cache write (by TTL) / thinking tokens, sidechain flag |
| ToolCall | tool name, MCP server, input size, result size, error, denied, duration                                 |
| Event    | compaction, API error, mode change, hook, interruption                                                  |

## Principles

- Parsing never throws on unknown data; it counts it (`unknown_types` in the scan summary).
- Ingest is idempotent and incremental (path + size + mtime; append-only files resume from offset).
- Detectors and fixes are pure functions over the store, testable with fixtures.
- The web app only talks to the local API; it can later be served by a team server unchanged.
