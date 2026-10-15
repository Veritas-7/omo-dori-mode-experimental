import { afterEach, beforeEach, expect, test } from "bun:test";

import { freshnessTick } from "../src/freshness.ts";
import { pauseLane, resumeLane } from "../src/pause.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, sent, withState, type World } from "./fakes.ts";

// Issue #11: telling Dori to wait must stick. One paused state silences the freshness sweep and pauses the goal.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const MIN = 60_000;
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const working: Lane = { key: "waiting-lane", title: "wait", thread: "chat:team/9", pane: "w:p7", brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), lastReplyAt: T0 };
const deps = (ms: number) => depsFor(world, fakeClock(ms), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });

test("a paused lane silent past the nudge and post times is neither nudged nor posted", async () => {
  await deps(T0).registry.write({ ...working, status: "paused" });
  world.screen = "[REPORT] waiting-lane | milestone | halfway\n❯ ";
  for (const at of [16, 21, 26, 120]) expect(await freshnessTick(deps(T0 + at * MIN), "/home/test")).toEqual([]);
  expect(sent(world)).toEqual([]);
  expect(world.calls.find((c) => c[0] === "notify")).toBeUndefined();
});

test("pause records the paused state, pauses the goal first, then interrupts a running turn", async () => {
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent_status: "working" }];
  await deps(T0).registry.write(working);

  const r = await pauseLane(deps(T0 + MIN), working, "user said wait");

  const stored = await deps(T0).registry.read(working.key);
  expect(stored && statusOf(stored)).toBe("paused");
  expect(stored?.history?.at(-1)).toMatchObject({ status: "paused", note: "user said wait" });
  expect(sent(world)).toEqual(["/goal pause"]);
  const goalAt = world.calls.findIndex((c) => c[2] === "send-text");
  const escAt = world.calls.findIndex((c) => c[2] === "send-keys" && c[4] === "escape");
  expect(escAt).toBeGreaterThan(goalAt);
  expect(r.lines[0]).toStartWith("PAUSED waiting-lane");
  expect((await pauseLane(deps(T0 + 2 * MIN), stored as Lane, "again")).lines[0]).toBe("PAUSED waiting-lane already");
});

test("resume returns the lane to working, resumes the goal, and restarts the quiet clock", async () => {
  const paused: Lane = { ...working, status: "paused" };
  await deps(T0).registry.write(paused);

  await resumeLane(deps(T0 + 90 * MIN), paused, "user said go");

  const stored = await deps(T0).registry.read(working.key);
  expect(stored && statusOf(stored)).toBe("working");
  expect(stored?.lastReplyAt).toBe(T0 + 90 * MIN);
  expect(sent(world)).toEqual(["/goal resume"]);
  expect(await freshnessTick(deps(T0 + 95 * MIN), "/home/test")).toEqual([]);
  expect((await freshnessTick(deps(T0 + 106 * MIN), "/home/test")).map((a) => a.kind)).toEqual(["nudged"]);
});

test("pause refuses a lane that is not working", async () => {
  const claimed: Lane = { ...working, status: "done-claimed" };
  await deps(T0).registry.write(claimed);
  expect((await pauseLane(deps(T0), claimed, "wait")).lines[0]).toBe("NOT_PAUSED waiting-lane is done-claimed, not working");
  expect(sent(world)).toEqual([]);
});
