import { describe, expect, it } from "vitest";
import {
  beforeAfterEffect,
  dayOf,
  switchbackEffect,
  switchbackSchedule,
  type AgentEvent,
} from "../src/index.js";
import { at, session, storeWith } from "./helpers.js";

const DAY = 86_400;

/** Synthetic history: `days` days of `perDay` turns, cost multiplied by factor(day) with noise. */
function history(days: number, perDay: number, factor: (day: number) => number) {
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const events: AgentEvent[] = [];
  for (let d = 0; d < days; d++) {
    const s = session(`s${d}`);
    for (let i = 0; i < perDay; i++) {
      s.turn(`d${d}t${i}`, at(d * DAY + i * 60));
      const noise = Math.exp((rnd() - 0.5) * 0.6);
      s.call(at(d * DAY + i * 60 + 1), {
        cacheRead: 50_000,
        output: Math.round(2_000 * factor(d) * noise),
      });
    }
    events.push(...s.events);
  }
  return storeWith(events);
}
const dayStart = (d: number) => at(d * DAY);

describe("beforeAfterEffect", () => {
  it("says there is not enough data with two days on a side", async () => {
    const store = await history(4, 30, () => 1);
    const e = beforeAfterEffect(store, dayStart(2), { rounds: 50 });
    expect(e.verdict).toBe("not-enough-data");
    expect(e.reasons.join(" ")).toMatch(/active days/);
  });

  it("does not call steady drift a change", async () => {
    // 4% cheaper every day, nothing changed at the split.
    const store = await history(12, 30, (d) => 0.96 ** d);
    const e = beforeAfterEffect(store, dayStart(6), { rounds: 100 });
    expect(e.verdict).toBe("no-clear-change");
    // The trend absorbs the drift: the jump at the split is small.
    expect(Math.abs(e.effect)).toBeLessThan(0.1);
  });

  it("finds a real 40% drop at the mark on top of the drift", async () => {
    const store = await history(12, 30, (d) => 0.98 ** d * (d >= 6 ? 0.6 : 1));
    const e = beforeAfterEffect(store, at(6 * DAY - 3_600), { rounds: 200 });
    expect(e.verdict).toBe("cheaper");
    expect(e.effect).toBeGreaterThan(-0.55);
    expect(e.effect).toBeLessThan(-0.25);
  });
});

describe("switchback", () => {
  it("builds a balanced random schedule: one ON and one OFF in every pair of days", () => {
    const s = switchbackSchedule(dayStart(0), 14, 42);
    expect(s.on).toHaveLength(7);
    expect(s.off).toHaveLength(7);
    expect(new Set([...s.on, ...s.off]).size).toBe(14);
    expect(switchbackSchedule(dayStart(0), 14, 42)).toEqual(s);
    expect(s.start).toBe(dayOf(dayStart(0)));
  });

  it("finds a real 40% saving on ON days despite drift", async () => {
    const s = switchbackSchedule(dayStart(0), 14, 7);
    const on = new Set(s.on);
    const store = await history(14, 30, (d) => 0.97 ** d * (on.has(dayOf(dayStart(d))) ? 0.6 : 1));
    const e = switchbackEffect(store, s, { rounds: 200 });
    expect(e.verdict).toBe("cheaper");
    expect(e.effect).toBeGreaterThan(-0.55);
    expect(e.effect).toBeLessThan(-0.25);
    expect(e.interval[1]).toBeLessThan(0);
  });
});
