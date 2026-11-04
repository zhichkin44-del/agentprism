// Shared loader for research scripts: main-chain timelines of Claude Code sessions.
// Reads ~/.claude/projects (or AGENTPRISM_LOGS). Prints nothing; callers print aggregates only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** USD per million tokens: input, output, cache read, cache write 5m, cache write 1h. */
export const PRICES = {
  "claude-opus-5-5": [4, 20, 0.2, 5, 8],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5, 4],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
};

export function logFiles(
  root = process.env.AGENTPRISM_LOGS ?? path.join(os.homedir(), ".claude", "projects"),
) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) files.push(p);
    }
  })(root);
  return files;
}

/**
 * Loads every session's main chain as an ordered list of events:
 *   { t: "call", id, model, ts, usage: {in, out, think, cr, w5, w1}, ctx }
 *   { t: "block", kind, tool?, target?, text, chars, ts, calls?: blockIds }  // content entering context
 *   { t: "compact", ts }
 * Records are de-duplicated globally by uuid (resumed sessions copy history), calls by requestId.
 */
export function loadSessions() {
  const seen = new Set();
  const sessions = new Map(); // sessionId -> { recs: [] }
  let order = 0;
  for (const f of logFiles()) {
    let lastTs = 0;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line || line.startsWith('{"type":"api-request')) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.uuid) {
        if (seen.has(o.uuid)) continue;
        seen.add(o.uuid);
      }
      if (o.isSidechain === true || !o.sessionId) continue;
      const ts = o.timestamp ? Date.parse(o.timestamp) : lastTs;
      lastTs = ts;
      if (!["assistant", "user", "attachment", "system"].includes(o.type)) continue;
      const s =
        sessions.get(o.sessionId) ?? sessions.set(o.sessionId, { recs: [] }).get(o.sessionId);
      s.recs.push({ o, ts, order: order++ });
    }
  }

  const out = new Map();
  for (const [id, s] of sessions) {
    s.recs.sort((a, b) => a.ts - b.ts || a.order - b.order);
    const events = [];
    const calls = new Map(); // requestId -> call event
    const toolNames = new Map(); // tool_use id -> { name, target }
    for (const { o, ts } of s.recs) {
      if (o.type === "assistant") {
        const u = o.message?.usage;
        const key = o.requestId ?? o.message?.id;
        if (!u || !key || !PRICES[o.message.model]) continue;
        let call = calls.get(key);
        const cw = u.cache_creation ?? {};
        const usage = {
          in: u.input_tokens ?? 0,
          out: u.output_tokens ?? 0,
          think: u.output_tokens_details?.thinking_tokens ?? 0,
          cr: u.cache_read_input_tokens ?? 0,
          w5: cw.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0,
          w1: cw.ephemeral_1h_input_tokens ?? 0,
        };
        if (!call) {
          call = { t: "call", id: key, model: o.message.model, ts, usage, outBlocks: [] };
          calls.set(key, call);
          events.push(call);
        } else if (usage.out >= call.usage.out) call.usage = usage;
        for (const b of o.message.content ?? []) {
          if (b.type === "tool_use") {
            toolNames.set(b.id, {
              name: b.name,
              target: b.input?.file_path ?? b.input?.path ?? b.input?.notebook_path,
            });
            const text = JSON.stringify(b.input ?? {});
            const target = b.input?.file_path ?? b.input?.path ?? b.input?.notebook_path;
            events.push({ t: "block", kind: "tool_use", tool: b.name, target, text, ts, by: key });
          } else if (b.type === "text") {
            events.push({ t: "block", kind: "assistant_text", text: b.text ?? "", ts, by: key });
          } else if (b.type === "thinking") {
            events.push({ t: "block", kind: "thinking", text: b.thinking ?? "", ts, by: key });
          }
        }
      } else if (o.type === "user") {
        const c = o.message?.content;
        if (typeof c === "string") {
          const kind = o.isCompactSummary ? "compact_summary" : o.isMeta ? "meta" : "user_prompt";
          events.push({
            t: "block",
            kind,
            text: c,
            ts,
            origin: o.origin?.kind,
            uuid: o.uuid,
            cwd: o.cwd,
          });
        } else
          for (const b of c ?? []) {
            if (b.type === "tool_result") {
              const parts =
                typeof b.content === "string"
                  ? [{ type: "text", text: b.content }]
                  : (b.content ?? []);
              const text = parts
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n");
              const images = parts.filter((p) => p.type === "image").length;
              events.push({
                t: "block",
                kind: "tool_result",
                tool: toolNames.get(b.tool_use_id)?.name ?? "?",
                target: toolNames.get(b.tool_use_id)?.target,
                text,
                images,
                ts,
                denial: o.toolDenialKind,
              });
            } else if (b.type === "text") {
              events.push({
                t: "block",
                kind: o.isCompactSummary ? "compact_summary" : o.isMeta ? "meta" : "user_prompt",
                text: b.text,
                ts,
                origin: o.origin?.kind,
                uuid: o.uuid,
                cwd: o.cwd,
              });
            } else if (b.type === "image") {
              events.push({ t: "block", kind: "user_image", text: "", images: 1, ts });
            }
          }
      } else if (o.type === "attachment") {
        const a = o.attachment ?? {};
        events.push({
          t: "block",
          kind: "attachment",
          tool: a.type ?? "?",
          text: JSON.stringify(a),
          ts,
        });
      } else if (o.type === "system" && o.subtype === "compact_boundary") {
        events.push({ t: "compact", ts });
      }
    }
    for (const c of calls.values()) {
      const u = c.usage;
      c.ctx = u.in + u.cr + u.w5 + u.w1;
      const p = PRICES[c.model];
      // Exact cost of carrying the prompt on this call, and its average price per prompt token.
      c.ctxUsd = (u.in * p[0] + u.cr * p[2] + u.w5 * p[3] + u.w1 * p[4]) / 1e6;
      c.outUsd = (u.out * p[1]) / 1e6;
    }
    if (calls.size) out.set(id, events);
  }
  return out;
}
