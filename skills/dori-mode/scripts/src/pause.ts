import type { FlowDeps } from "./done-flow.ts";
import { type Delivery, sendVerified, statusLookup } from "./panes.ts";
import { type Lane, statusOf, withStatus } from "./registry.ts";

/**
 * One state for "wait": a paused lane is skipped by the freshness sweep, and its agent's goal is paused
 * too, so neither a nudge nor goal continuation wakes it until it is resumed (issue #11).
 */
export type PauseResult = { readonly lane: Lane; readonly lines: readonly string[] };

export const pauseLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  const status = statusOf(lane);
  if (status === "paused") return { lane, lines: [`PAUSED ${lane.key} already`] };
  if (status !== "working") return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}, not working`] };
  const at = new Date(deps.clock.now()).toISOString();
  const paused = withStatus(lane, "paused", note, at);
  await deps.registry.write(paused);
  if (!lane.pane) return { lane: paused, lines: [`PAUSED ${lane.key} (no pane: goal not paused)`] };
  // The goal first, so stopping the running turn cannot hand off to a goal continuation.
  const goal: Delivery = await sendVerified(deps.run, deps.clock, lane.pane, "/goal pause");
  const running = (await statusLookup(deps.run, lane.pane)).status === "working";
  if (running) await deps.run(["herdr", "pane", "send-keys", lane.pane, "escape"]);
  return { lane: paused, lines: [`PAUSED ${lane.key} goal-pause ${goal}${running ? ", running turn interrupted" : ""}`] };
};

export const resumeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  if (statusOf(lane) !== "paused") return { lane, lines: [`NOT_RESUMED ${lane.key} is ${statusOf(lane)}, not paused`] };
  const now = deps.clock.now();
  // Quiet time starts again at the resume: a long pause must not turn into an instant nudge.
  const resumed = withStatus(lane, "working", note, new Date(now).toISOString(), { lastReplyAt: now });
  await deps.registry.write(resumed);
  if (!lane.pane) return { lane: resumed, lines: [`RESUMED ${lane.key} (no pane: goal not resumed)`] };
  const goal = await sendVerified(deps.run, deps.clock, lane.pane, "/goal resume");
  return { lane: resumed, lines: [`RESUMED ${lane.key} goal-resume ${goal}`] };
};
