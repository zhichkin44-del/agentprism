import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Adapter, AgentEvent, ReadStats, SourceFile } from "@agentprism/core";
import { RecordParser } from "./parse.js";
import { readTimeline } from "./timeline.js";

export { RecordParser, mapUsage, measureResult } from "./parse.js";
export { readTimeline } from "./timeline.js";

export const CLAUDE_CODE = "claude-code";

/** Claude Code keeps one JSONL file per session (plus subagent files) under `<config>/projects`. */
export function defaultLogRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

export interface ClaudeCodeOptions {
  /** Directory to scan instead of the default `~/.claude/projects`. */
  root?: string;
}

export function claudeCodeAdapter(options: ClaudeCodeOptions = {}): Adapter {
  const root = options.root ?? defaultLogRoot();

  return {
    id: CLAUDE_CODE,
    displayName: "Claude Code",
    timeline: readTimeline,

    async discover(): Promise<SourceFile[]> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const files = entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => path.join(e.parentPath, e.name));
      return Promise.all(
        files.map(async (file) => {
          const st = await fs.promises.stat(file);
          return { agent: CLAUDE_CODE, path: file, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
        }),
      );
    },

    async *read(file: SourceFile, stats: ReadStats): AsyncIterable<AgentEvent> {
      const parser = new RecordParser(stats);
      const lines = readline.createInterface({
        input: fs.createReadStream(file.path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        yield* parser.parseLine(line);
      }
    },
  };
}
