import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class MonitorLockError extends Error {
  readonly code = "MONITOR_ALREADY_RUNNING";

  constructor() {
    super("MONITOR_ALREADY_RUNNING");
  }
}

const lockPath = (stateDir: string, key: string): string =>
  join(stateDir, "monitor-locks", `${createHash("sha256").update(key).digest("hex")}.lock`);

const readOwner = (path: string): { pid: number; nonce: string } | null => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return null;
    throw error;
  }
  if (
    typeof value !== "object" || value === null
    || !("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !("nonce" in value) || typeof value.nonce !== "string" || !value.nonce
  ) return null;
  return { pid: value.pid, nonce: value.nonce };
};

export const readMonitorLock = (stateDir: string, key: string): { pid: number } | null => {
  const owner = readOwner(lockPath(stateDir, key));
  return owner === null ? null : { pid: owner.pid };
};

export const acquireMonitorLock = (stateDir: string, key: string): { release: () => void } => {
  const path = lockPath(stateDir, key);
  mkdirSync(join(stateDir, "monitor-locks"), { recursive: true });
  const nonce = randomUUID();
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, nonce }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new MonitorLockError();
    throw error;
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      if (readOwner(path)?.nonce === nonce) unlinkSync(path);
    },
  };
};
