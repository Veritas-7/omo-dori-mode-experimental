import type { Clock, Runner } from "./run.ts";

export type Pane = {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly tab_id?: string;
  readonly agent?: string;
  readonly agent_status?: string;
  readonly title?: string;
  readonly cwd?: string;
};

export class UnsafeTextError extends Error {}

export const listPanes = async (run: Runner): Promise<Pane[]> => {
  const r = await run(["herdr", "pane", "list"]);
  if (r.code !== 0) throw new Error(`herdr pane list failed: ${r.err || r.out}`);
  return (JSON.parse(r.out) as { result: { panes: Pane[] } }).result.panes;
};

export const readScreen = async (run: Runner, pane: string, lines?: number): Promise<string> =>
  (await run(["herdr", "pane", "read", pane, "--source", lines ? "recent" : "visible", ...(lines ? ["--lines", String(lines)] : [])])).out;

/** States herdr reports for a pane whose agent is running. A screen read never stands in for these. */
export const ALIVE_STATUSES: ReadonlySet<string> = new Set(["idle", "working", "blocked", "done"]);

export const agentStatus = async (run: Runner, pane: string): Promise<string | undefined> =>
  (await listPanes(run)).find((p) => p.pane_id === pane)?.agent_status;

export type Delivery = "delivered" | "unconfirmed" | "failed";

/**
 * Types the text and presses Enter exactly once. Delivery is confirmed only by a state change: the pane's agent_status
 * moving to "working" from something else. A pane that was already working cannot show that change, so its send comes
 * back "unconfirmed" and the caller decides. The screen is never read here, and Enter is never pressed again.
 */
export const sendVerified = async (run: Runner, clock: Clock, pane: string, text: string): Promise<Delivery> => {
  if (/`|\$\(/.test(text)) throw new UnsafeTextError("refusing to send text containing a backtick or $(");
  const before = await agentStatus(run, pane).catch(() => undefined);
  if ((await run(["herdr", "pane", "send-text", pane, text])).code !== 0) return "failed";
  await run(["herdr", "pane", "send-keys", pane, "enter"]);
  if (before === "working") return "unconfirmed";
  for (let attempt = 0; attempt < 6; attempt++) {
    await clock.sleep(700);
    if ((await agentStatus(run, pane).catch(() => undefined)) === "working") return "delivered";
  }
  return "unconfirmed";
};
