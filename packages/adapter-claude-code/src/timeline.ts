import fs from "node:fs";
import readline from "node:readline";
import type { SourceFile, Timeline, TimelineBlock, TimelineEvent } from "@agentprism/core";
import { mapUsage } from "./parse.js";

type Json = Record<string, unknown>;
const obj = (x: unknown): Json | undefined =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Json) : undefined;
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const arr = (x: unknown): Json[] => (Array.isArray(x) ? (x.filter(obj) as Json[]) : []);

/**
 * Reads one session's main chain, with content, from its log files. Records are de-duplicated by
 * uuid (resumed sessions copy history into new files) and calls by request id (one response is
 * written as several lines); subagent traffic is left out. Tolerant: unreadable lines are skipped.
 */
export async function readTimeline(files: SourceFile[], sessionId: string): Promise<Timeline> {
  const seen = new Set<string>();
  const records: { o: Json; ts: number; order: number }[] = [];
  let order = 0;
  for (const file of files) {
    const lines = readline.createInterface({
      input: fs.createReadStream(file.path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let lastTs = 0;
    for await (const line of lines) {
      if (!line.includes(sessionId) || line.startsWith('{"type":"api-request')) continue;
      let o: Json | undefined;
      try {
        o = obj(JSON.parse(line));
      } catch {
        continue;
      }
      if (!o || o.sessionId !== sessionId || o.isSidechain === true) continue;
      const uuid = str(o.uuid);
      if (uuid) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
      }
      const ts = str(o.timestamp) ? Date.parse(o.timestamp as string) : lastTs;
      lastTs = ts;
      records.push({ o, ts, order: order++ });
    }
  }
  records.sort((a, b) => a.ts - b.ts || a.order - b.order);

  const events: TimelineEvent[] = [];
  const calls = new Map<string, Extract<TimelineEvent, { kind: "call" }>>();
  const tools = new Map<string, { name: string; target?: string }>();
  const block = (b: Omit<TimelineBlock, "kind">) => events.push({ kind: "block", ...b });
  for (const { o, ts } of records) {
    const message = obj(o.message);
    if (o.type === "assistant" && message) {
      const model = str(message.model);
      const key = str(o.requestId) ?? str(message.id);
      if (!model || model === "<synthetic>" || !key || !message.usage) continue;
      const usage = mapUsage(message.usage);
      const call = calls.get(key);
      if (!call) {
        const c = { kind: "call" as const, id: key, ts, model, usage };
        calls.set(key, c);
        events.push(c);
      } else if (usage.outputTokens >= call.usage.outputTokens) call.usage = usage;
      for (const b of arr(message.content)) {
        if (b.type === "tool_use") {
          const input = obj(b.input) ?? {};
          const target = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
          const name = str(b.name) ?? "?";
          if (str(b.id)) tools.set(b.id as string, { name, target });
          block({
            type: "tool_use",
            ts,
            tool: name,
            target,
            text: JSON.stringify(input),
            images: 0,
            byCall: key,
          });
        } else if (b.type === "text") {
          block({ type: "assistant_text", ts, text: str(b.text) ?? "", images: 0, byCall: key });
        } else if (b.type === "thinking") {
          block({ type: "thinking", ts, text: str(b.thinking) ?? "", images: 0, byCall: key });
        }
      }
    } else if (o.type === "user" && message) {
      const promptType = o.isCompactSummary ? "compact_summary" : o.isMeta ? "meta" : "user_prompt";
      if (typeof message.content === "string") {
        block({ type: promptType, ts, text: message.content, images: 0 });
        continue;
      }
      for (const b of arr(message.content)) {
        if (b.type === "tool_result") {
          const parts =
            typeof b.content === "string" ? [{ type: "text", text: b.content }] : arr(b.content);
          const t = tools.get(str(b.tool_use_id) ?? "");
          block({
            type: "tool_result",
            ts,
            tool: t?.name ?? "?",
            target: t?.target,
            text: parts
              .filter((p) => p.type === "text")
              .map((p) => str(p.text) ?? "")
              .join("\n"),
            images: parts.filter((p) => p.type === "image").length,
          });
        } else if (b.type === "text") {
          block({ type: promptType, ts, text: str(b.text) ?? "", images: 0 });
        } else if (b.type === "image") {
          block({ type: "image", ts, text: "", images: 1 });
        }
      }
    } else if (o.type === "attachment") {
      const a = obj(o.attachment) ?? {};
      block({
        type: "attachment",
        ts,
        tool: str(a.type) ?? "?",
        text: JSON.stringify(a),
        images: 0,
      });
    } else if (o.type === "system" && o.subtype === "compact_boundary") {
      events.push({ kind: "compaction", ts });
    }
  }
  return { sessionId, events };
}
