import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { withState } from "./fakes.ts";

const roots: ReturnType<typeof withState>[] = [];
afterEach(() => { for (const root of roots.splice(0)) root.done(); });
const setup = () => {
  const root = withState();
  roots.push(root);
  return join(root.dir, "ledger.json");
};

test("a running reader sees a new thread recorded by another ledger instance", async () => {
  // Given a reader started before another process records a reply thread.
  const file = setup();
  const reader = new ThreadLedger(file);
  await reader.list();
  const sender = new ThreadLedger(file);
  // When the sender persists a new thread.
  await sender.record("D1", "10.1", "10.1");
  // Then the running reader discovers it without needing a restart.
  expect(await reader.list()).toEqual([{ channel: "D1", rootTs: "10.1", seenTs: "10.1" }]);
});

test("a channel watermark write does not erase a thread saved by another process", async () => {
  // Given a reader whose in-memory snapshot predates a new outbound thread.
  const file = setup();
  const reader = new ThreadLedger(file);
  await reader.list();
  await new ThreadLedger(file).record("D1", "20.1", "20.1");
  // When the reader records polling progress.
  await reader.markChannelSeen("D1", "30.1");
  // Then a fresh process retains both the watched root and polling progress.
  const fresh = new ThreadLedger(file);
  expect(await fresh.list()).toEqual([{ channel: "D1", rootTs: "20.1", seenTs: "20.1" }]);
  expect(await fresh.channelSeen("D1")).toBe("30.1");
});

test("independent writers retain each root and do not move a seen watermark backwards", async () => {
  // Given independent producers sharing a ledger.
  const file = setup();
  const first = new ThreadLedger(file);
  const second = new ThreadLedger(file);
  // When they persist different roots concurrently.
  await Promise.all([first.record("D1", "1.1", "3.1"), second.record("D1", "2.1", "4.1")]);
  await first.record("D1", "2.1", "2.1");
  // Then both roots remain and stale progress cannot replace the newer value.
  expect((await new ThreadLedger(file).list()).sort((a, b) => a.rootTs.localeCompare(b.rootTs))).toEqual([
    { channel: "D1", rootTs: "1.1", seenTs: "3.1" },
    { channel: "D1", rootTs: "2.1", seenTs: "4.1" },
  ]);
});
