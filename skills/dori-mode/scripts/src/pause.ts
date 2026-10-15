import type { FlowDeps } from "./done-flow.ts";
import { readScreen, sendVerified, statusLookup } from "./panes.ts";
import { type Lane, type LaneStatus, statusOf, withStatus } from "./registry.ts";

/**
 * One state for "wait": a paused lane is skipped by the freshness sweep and its agent's goal is paused,
 * so neither a nudge nor goal continuation wakes it until it is resumed (issue #11). The lane is marked
 * paused only once the pane shows the goal paused: a silenced lane whose goal still runs is the bug itself.
 */
export type PauseResult = { readonly lane: Lane; readonly lines: readonly string[]; readonly code: 0 | 2 | 3 };

const PAUSABLE: ReadonlySet<LaneStatus> = new Set(["working", "not-done"]);
// What the goal command prints (senpi goal/command-registration.ts): its new status, or that there is no goal,
// in which case nothing can auto-continue either.
const PAUSED_SHOWN = /Goal paused|no goal exists/g;
const RESUMED_SHOWN = /Goal active|no goal exists/g;
const READ_BACK_TRIES = 8;

const count = (screen: string, shown: RegExp): number => screen.match(shown)?.length ?? 0;

/** Sends a goal command and confirms it from the screen: one more matching line than before it was sent. */
const goalCommand = async (deps: FlowDeps, pane: string, text: string, shown: RegExp): Promise<"confirmed" | "unconfirmed" | "failed"> => {
  const before = count(await readScreen(deps.run, pane, 200), shown);
  if ((await sendVerified(deps.run, deps.clock, pane, text)) === "failed") return "failed";
  for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
    if (count(await readScreen(deps.run, pane, 200), shown) > before) return "confirmed";
    await deps.clock.sleep(700);
  }
  return "unconfirmed";
};

/** The status a paused lane had before its pause, from its history. */
const beforePause = (lane: Lane): LaneStatus => {
  const history = lane.history ?? [];
  const pausedAt = history.findLastIndex((entry) => entry.status === "paused");
  const prior = pausedAt > 0 ? history[pausedAt - 1]?.status : undefined;
  return prior && PAUSABLE.has(prior) ? prior : "working";
};

export const pauseLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  const status = statusOf(lane);
  if (status === "paused") return { lane, lines: [`PAUSED ${lane.key} already`], code: 0 };
  if (!PAUSABLE.has(status)) return { lane, lines: [`NOT_PAUSED ${lane.key} is ${status}, not working`], code: 2 };
  if (!lane.pane) return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} has no pane, so its goal cannot be paused`], code: 3 };
  // The goal first: stopping the running turn must not hand off to a goal continuation.
  const goal = await goalCommand(deps, lane.pane, "/goal pause", PAUSED_SHOWN);
  if (goal !== "confirmed") return { lane, lines: [`PAUSE_UNVERIFIED ${lane.key} /goal pause ${goal}; lane left ${status}`], code: 3 };
  const at = new Date(deps.clock.now()).toISOString();
  // A lane that is working at the pause is the one wanted quiet; record its earlier status for resume.
  const paused = withStatus(status === "working" ? lane : withStatus(lane, status, "before pause", at), "paused", note, at, { pausedSeenWorking: undefined });
  await deps.registry.write(paused);
  const running = (await statusLookup(deps.run, lane.pane)).status === "working";
  if (running) await deps.run(["herdr", "pane", "send-keys", lane.pane, "escape"]);
  return { lane: paused, lines: [`PAUSED ${lane.key} goal paused${running ? ", running turn interrupted" : ""}`], code: 0 };
};

export const resumeLane = async (deps: FlowDeps, lane: Lane, note: string): Promise<PauseResult> => {
  if (statusOf(lane) !== "paused") return { lane, lines: [`NOT_RESUMED ${lane.key} is ${statusOf(lane)}, not paused`], code: 2 };
  if (!lane.pane) return { lane, lines: [`RESUME_UNVERIFIED ${lane.key} has no pane, so its goal cannot be resumed`], code: 3 };
  const goal = await goalCommand(deps, lane.pane, "/goal resume", RESUMED_SHOWN);
  if (goal !== "confirmed") return { lane, lines: [`RESUME_UNVERIFIED ${lane.key} /goal resume ${goal}; lane left paused`], code: 3 };
  const now = deps.clock.now();
  // Quiet time starts again at the resume: a long pause must not turn into an instant nudge.
  const resumed = withStatus(lane, beforePause(lane), note, new Date(now).toISOString(), { lastReplyAt: now, pausedSeenWorking: undefined });
  await deps.registry.write(resumed);
  return { lane: resumed, lines: [`RESUMED ${lane.key} as ${statusOf(resumed)}, goal resumed`], code: 0 };
};

/**
 * A paused lane whose pane reads working on two ticks in a row was resumed outside `dori resume` (the owner
 * typed in it): the registry follows reality, so the lane is nudged and posted again.
 */
export const noticeResumedOutside = async (deps: FlowDeps, lane: Lane): Promise<Lane | null> => {
  if (statusOf(lane) !== "paused" || !lane.pane) return null;
  const working = (await statusLookup(deps.run, lane.pane)).status === "working";
  if (!working) {
    if (lane.pausedSeenWorking) await deps.registry.write({ ...lane, pausedSeenWorking: undefined });
    return null;
  }
  if (!lane.pausedSeenWorking) {
    await deps.registry.write({ ...lane, pausedSeenWorking: true });
    return null;
  }
  const now = deps.clock.now();
  const resumed = withStatus(lane, beforePause(lane), "resumed outside dori resume (pane working on two ticks)", new Date(now).toISOString(), { lastReplyAt: now, pausedSeenWorking: undefined });
  await deps.registry.write(resumed);
  return resumed;
};
