/**
 * Runtime modules sit here: a router changes `params.model`, a cache answers without calling the
 * model, a guard checks or replaces the response. Each one is a small object; order matters.
 */
export interface CallContext {
  readonly app: string;
  readonly sessionId: string;
  readonly agent?: string;
  readonly tags: Readonly<Record<string, string>>;
  /** The request about to be sent. Modules may change it (a router sets `model`). */
  params: Record<string, unknown>;
  /** The model the app asked for, before any module changed it. */
  readonly requestedModel?: string;
  /** Notes modules leave on the trace, keyed by module name. */
  notes: Record<string, unknown>;
}

/** Return a response to answer the call without (or instead of) the model. */
export type Override = { response: unknown } | void | undefined;

export interface Middleware {
  name: string;
  /** Before the call: change `ctx.params`, or answer from somewhere else (a cache). */
  before?(ctx: CallContext): Override | Promise<Override>;
  /** After the call: inspect the response, or replace it (a guard). */
  after?(ctx: CallContext, response: unknown): Override | Promise<Override>;
}

export const isOverride = (x: Override): x is { response: unknown } =>
  !!x && typeof x === "object" && "response" in x;
