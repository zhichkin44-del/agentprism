import { AsyncLocalStorage } from "node:async_hooks";

/** Who is calling the model right now. Carried through async code, so nothing is passed by hand. */
export interface TraceContext {
  sessionId?: string;
  turnId?: string;
  agent?: string;
  parentAgent?: string;
  tags?: Record<string, string>;
}

const storage = new AsyncLocalStorage<TraceContext>();

export function currentContext(): TraceContext {
  return storage.getStore() ?? {};
}

/** Runs `fn` with extra context; nested calls inherit what they do not override. */
export function withContext<T>(ctx: TraceContext, fn: () => T): T {
  const parent = currentContext();
  return storage.run({ ...parent, ...ctx, tags: { ...parent.tags, ...ctx.tags } }, fn);
}

export const withSession = <T>(sessionId: string, fn: () => T): T => withContext({ sessionId }, fn);

export const withTurn = <T>(turnId: string, fn: () => T): T => withContext({ turnId }, fn);

/** Marks calls inside `fn` as made by `agent`; the agent around it becomes the parent. */
export function withAgent<T>(agent: string, fn: () => T): T {
  return withContext({ agent, parentAgent: currentContext().agent }, fn);
}
