import type { Millis, TokenUsage } from "../schema.js";

/**
 * The main chain of one session as content, in order: model calls, the blocks of content that
 * entered the prompt between them, and compactions. Unlike the store, a timeline carries text:
 * it is built on demand from the local logs, analysed in memory and never stored or shown.
 */
export interface Timeline {
  sessionId: string;
  events: TimelineEvent[];
}

export type TimelineEvent = TimelineCall | TimelineBlock | TimelineCompaction;

export interface TimelineCall {
  kind: "call";
  /** Request id; blocks produced by this call point at it. */
  id: string;
  ts: Millis;
  model: string;
  usage: TokenUsage;
}

export type BlockType =
  | "tool_use"
  | "tool_result"
  | "assistant_text"
  | "thinking"
  | "user_prompt"
  | "meta"
  | "compact_summary"
  | "attachment"
  | "image";

export interface TimelineBlock {
  kind: "block";
  type: BlockType;
  ts: Millis;
  /** Tool name for tool_use / tool_result, attachment type for attachments. */
  tool?: string;
  /** File the tool worked on, when there is one. */
  target?: string;
  text: string;
  images: number;
  /** Set on the model's own output: the id of the call that produced it. */
  byCall?: string;
}

export interface TimelineCompaction {
  kind: "compaction";
  ts: Millis;
}
