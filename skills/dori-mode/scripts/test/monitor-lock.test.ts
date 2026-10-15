import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { acquireMonitorLock, MonitorLockError, readMonitorLock } from "../src/monitor-lock.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => { state = withState(); });
afterEach(() => state.done());
const path = (): string => {
  const file = readdirSync(join(state.dir, "monitor-locks"))[0];
  if (!file) throw new Error("expected lock fixture");
  return join(state.dir, "monitor-locks", file);
};

test("a live duplicate fails closed and preserves the original owner", () => {
  // Given
  const owner = acquireMonitorLock(state.dir, "slack-inbound");
  const original = readFileSync(path(), "utf8");
  // When / Then
  expect(() => acquireMonitorLock(state.dir, "slack-inbound")).toThrow(MonitorLockError);
  expect(readFileSync(path(), "utf8")).toBe(original);
  expect(readMonitorLock(state.dir, "slack-inbound")).toEqual({ pid: process.pid });
  expect(statSync(path()).mode & 0o777).toBe(0o600);
  owner.release();
});

test("normal release permits reacquisition and an old release cannot remove it", () => {
  // Given
  const old = acquireMonitorLock(state.dir, "slack-inbound");
  old.release();
  // When
  const current = acquireMonitorLock(state.dir, "slack-inbound");
  old.release();
  // Then
  expect(readMonitorLock(state.dir, "slack-inbound")).toEqual({ pid: process.pid });
  current.release();
  expect(readMonitorLock(state.dir, "slack-inbound")).toBeNull();
});

test("stale pid lock is preserved instead of reclaimed", () => {
  // Given
  acquireMonitorLock(state.dir, "slack-inbound");
  const file = path();
  const stale = JSON.stringify({ pid: 2_147_483_647, nonce: "stale-owner" });
  writeFileSync(file, stale);
  // When / Then
  expect(() => acquireMonitorLock(state.dir, "slack-inbound")).toThrow(MonitorLockError);
  expect(readFileSync(file, "utf8")).toBe(stale);
});

test("a former owner cannot release a foreign nonce even with the same pid", () => {
  // Given
  const old = acquireMonitorLock(state.dir, "slack-inbound");
  const file = path();
  const foreign = JSON.stringify({ pid: process.pid, nonce: "foreign-owner" });
  writeFileSync(file, foreign);
  // When
  old.release();
  // Then
  expect(readFileSync(file, "utf8")).toBe(foreign);
});

test("malformed lock remains fail closed and cannot be removed by release", () => {
  // Given
  const owner = acquireMonitorLock(state.dir, "slack-inbound");
  const file = path();
  writeFileSync(file, "{");
  // When
  owner.release();
  // Then
  expect(() => acquireMonitorLock(state.dir, "slack-inbound")).toThrow(MonitorLockError);
  expect(readFileSync(file, "utf8")).toBe("{");
  expect(readMonitorLock(state.dir, "slack-inbound")).toBeNull();
});

test("release tolerates an already absent lock", () => {
  // Given
  const owner = acquireMonitorLock(state.dir, "slack-inbound");
  unlinkSync(path());
  // When / Then
  expect(() => owner.release()).not.toThrow();
});

test("independent keys acquire independently without escaping the state directory", () => {
  // Given
  const first = acquireMonitorLock(state.dir, "../../slack/inbound");
  // When
  const second = acquireMonitorLock(state.dir, "discord");
  // Then
  expect(readdirSync(join(state.dir, "monitor-locks"))).toHaveLength(2);
  expect(readMonitorLock(state.dir, "../../slack/inbound")).toEqual({ pid: process.pid });
  first.release();
  second.release();
});
