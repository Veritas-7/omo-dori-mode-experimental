import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export class CheckpointError extends Error {
  override readonly name = "CheckpointError";
}

export type Checkpoint = {
  readonly schemaVersion: 1;
  readonly name: string;
  readonly platform: "slack" | "telegram" | "discord";
  readonly onboarding: {
    readonly status: "pending" | "in-progress" | "complete" | "declined";
    readonly tools: Readonly<Record<string, "allowed" | "declined">>;
  };
  readonly contextRefs: readonly { readonly kind: "file" | "session"; readonly ref: string }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new CheckpointError("Invalid checkpoint fields.");
  }
  return value;
};

const text = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) throw new CheckpointError("Invalid checkpoint text.");
  return value;
};

export const parseCheckpoint = (value: unknown, home = homedir()): Checkpoint => {
  const raw = object(value, ["schemaVersion", "name", "platform", "onboarding", "contextRefs"]);
  if (raw.schemaVersion !== 1) throw new CheckpointError("Unsupported checkpoint schema version.");
  const name = text(raw.name);
  const platform = raw.platform;
  if (platform !== "slack" && platform !== "telegram" && platform !== "discord") {
    throw new CheckpointError("Invalid checkpoint platform.");
  }
  const onboarding = object(raw.onboarding, ["status", "tools"]);
  const status = onboarding.status;
  if (status !== "pending" && status !== "in-progress" && status !== "complete" && status !== "declined") {
    throw new CheckpointError("Invalid checkpoint onboarding status.");
  }
  if (!isRecord(onboarding.tools)) throw new CheckpointError("Invalid checkpoint tools.");
  // This local accumulator is mutable only while parsing the boundary value.
  const tools: Record<string, "allowed" | "declined"> = {};
  for (const key of Reflect.ownKeys(onboarding.tools)) {
    if (typeof key !== "string") throw new CheckpointError("Invalid checkpoint tool.");
    text(key);
    const decision = onboarding.tools[key];
    if (decision !== "allowed" && decision !== "declined") throw new CheckpointError("Invalid checkpoint tool decision.");
    Object.defineProperty(tools, key, { value: decision, enumerable: true, writable: true, configurable: true });
  }
  if (!Array.isArray(raw.contextRefs)) throw new CheckpointError("Invalid checkpoint context references.");
  const refs: readonly unknown[] = raw.contextRefs;
  const contextRefs = Array.from(refs, (value): Checkpoint["contextRefs"][number] => {
    const entry = object(value, ["kind", "ref"]);
    const ref = text(entry.ref);
    switch (entry.kind) {
      case "file": {
        const expanded = ref === "~" ? home : ref.startsWith("~/") ? join(home, ref.slice(2)) : ref;
        if (!isAbsolute(expanded)) throw new CheckpointError("Checkpoint file references must be absolute.");
        return { kind: "file", ref: expanded };
      }
      case "session":
        return { kind: "session", ref };
      default:
        throw new CheckpointError("Invalid checkpoint reference kind.");
    }
  });
  return { schemaVersion: 1, name, platform, onboarding: { status, tools }, contextRefs };
};

export const readCheckpoint = async (stateDir: string): Promise<Checkpoint | null> => {
  let contents: string;
  try {
    contents = await fs.readFile(join(stateDir, "checkpoint.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new CheckpointError("Unable to read checkpoint.");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CheckpointError("Malformed checkpoint JSON.");
    throw new CheckpointError("Unable to parse checkpoint JSON.");
  }
  return parseCheckpoint(value);
};

export const saveCheckpoint = async (stateDir: string, value: unknown): Promise<Checkpoint> => {
  const checkpoint = parseCheckpoint(value);
  const temp = join(stateDir, `.checkpoint.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | undefined;
  try {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    await fs.rename(temp, join(stateDir, "checkpoint.json"));
  } catch (error) {
    try {
      if (handle) await fs.rm(temp, { force: true });
    } finally {
      // Neither filesystem errors nor their causes may expose checkpoint input.
      throw new CheckpointError("Unable to save checkpoint.");
    }
  }
  return checkpoint;
};
