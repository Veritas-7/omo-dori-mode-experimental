import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

import { type Checkpoint, CheckpointError, parseCheckpoint, readCheckpoint, saveCheckpoint } from "../src/checkpoint.ts";
import { withState } from "./fakes.ts";

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const fixture = (): Checkpoint => ({
  schemaVersion: 1,
  name: "Dori",
  platform: "slack",
  onboarding: { status: "in-progress", tools: { filesystem: "allowed", browser: "declined" } },
  contextRefs: [{ kind: "file", ref: "/home/ana/brief.md" }, { kind: "session", ref: "session-123" }],
});
const path = () => join(state.dir, "checkpoint.json");

test("file references expand home while session references stay opaque", () => {
  // Given
  const value = { ...fixture(), contextRefs: [{ kind: "file", ref: "~/brief.md" }, { kind: "file", ref: "~" }, { kind: "session", ref: "~/session" }] };
  // When
  const parsed = parseCheckpoint(value, "/home/ana");
  // Then
  expect(parsed.contextRefs).toEqual([{ kind: "file", ref: "/home/ana/brief.md" }, { kind: "file", ref: "/home/ana" }, { kind: "session", ref: "~/session" }]);
});

for (const platform of ["slack", "telegram", "discord"] as const) {
  for (const status of ["pending", "in-progress", "complete", "declined"] as const) {
    test(`parses ${platform} with ${status} onboarding`, () => {
      // Given
      const value = { ...fixture(), platform, onboarding: { status, tools: {} }, contextRefs: [] };
      // When
      const parsed = parseCheckpoint(value);
      // Then
      expect(parsed).toEqual(value);
    });
  }
}

const invalid: readonly [string, unknown][] = [
  ["null", null],
  ["array", []],
  ["missing required fields", { schemaVersion: 1 }],
  ["unsupported version", { ...fixture(), schemaVersion: 2 }],
  ["non-numeric version", { ...fixture(), schemaVersion: "1" }],
  ["blank name", { ...fixture(), name: "  " }],
  ["unsupported platform", { ...fixture(), platform: "other" }],
  ["unsupported onboarding status", { ...fixture(), onboarding: { status: "ready", tools: {} } }],
  ["array tools", { ...fixture(), onboarding: { status: "pending", tools: [] } }],
  ["invalid tool decision", { ...fixture(), onboarding: { status: "pending", tools: { browser: "private-fixture" } } }],
  ["non-array references", { ...fixture(), contextRefs: {} }],
  ["sparse references", { ...fixture(), contextRefs: Array(1) }],
  ["relative file", { ...fixture(), contextRefs: [{ kind: "file", ref: "brief.md" }] }],
  ["relative home expansion", { ...fixture(), contextRefs: [{ kind: "file", ref: "~/brief.md" }] }],
  ["unknown user home", { ...fixture(), contextRefs: [{ kind: "file", ref: "~other/brief.md" }] }],
  ["blank session", { ...fixture(), contextRefs: [{ kind: "session", ref: "\t " }] }],
  ["unknown reference kind", { ...fixture(), contextRefs: [{ kind: "url", ref: "private-fixture" }] }],
  ["top-level credential", { ...fixture(), token: "private-fixture" }],
  ["nested credential", { ...fixture(), onboarding: { ...fixture().onboarding, token: "private-fixture" } }],
  ["reference credential", { ...fixture(), contextRefs: [{ kind: "session", ref: "ok", token: "private-fixture" }] }],
];
for (const [description, value] of invalid) {
  test(`rejects ${description} without disclosing input`, () => {
    // Given: deliberately relative home also exercises invalid expansion.
    let caught: unknown;
    // When
    try {
      parseCheckpoint(value, "relative-home");
    } catch (error) {
      caught = error;
    }
    // Then
    expect(caught).toBeInstanceOf(CheckpointError);
    expect(String(caught)).not.toContain("private-fixture");
    expect(JSON.stringify(caught)).not.toContain("private-fixture");
  });
}

test("missing state returns null without creating directories", async () => {
  // Given
  const missing = join(state.dir, "absent");
  // When
  const checkpoint = await readCheckpoint(missing);
  // Then
  expect(checkpoint).toBeNull();
  expect(await fs.readdir(state.dir)).toEqual([]);
});

for (const contents of ["private-fixture {", JSON.stringify({ ...fixture(), schemaVersion: "private-fixture" }), JSON.stringify({ ...fixture(), token: "private-fixture" })]) {
  test(`invalid stored checkpoint is rejected without exposing its bytes (${contents.startsWith("{") ? "JSON" : "malformed"})`, async () => {
    // Given
    await fs.writeFile(path(), contents);
    let caught: unknown;
    // When
    try {
      await readCheckpoint(state.dir);
    } catch (error) {
      caught = error;
    }
    // Then
    expect(caught).toBeInstanceOf(CheckpointError);
    expect(String(caught)).not.toContain("private-fixture");
    expect(JSON.stringify(caught)).not.toContain("private-fixture");
    expect(await fs.readFile(path(), "utf8")).toBe(contents);
  });
}

test("a separate process reads the persisted checkpoint", async () => {
  // Given
  const expected = await saveCheckpoint(state.dir, fixture());
  const modulePath = join(import.meta.dir, "../src/checkpoint.ts");
  // When
  const child = Bun.spawn([process.execPath, "--eval", `import { readCheckpoint } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await readCheckpoint(process.argv[1])));`, state.dir], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  // Then
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual(expected);
});

test("save creates nested state and returns the normalized checkpoint", async () => {
  // Given
  const nested = join(state.dir, "nested", "state");
  const value = { ...fixture(), contextRefs: [{ kind: "file", ref: "~" }] };
  // When
  const saved = await saveCheckpoint(nested, value);
  // Then
  expect(saved).toEqual(parseCheckpoint(value));
  expect(await readCheckpoint(nested)).toEqual(saved);
  expect((await fs.stat(join(nested, "checkpoint.json"))).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(nested)).toEqual(["checkpoint.json"]);
});

test("replacement is atomic and tightens an existing file to mode 0600", async () => {
  // Given: an open reader must retain the complete old inode after replacement.
  await saveCheckpoint(state.dir, fixture());
  await fs.chmod(path(), 0o644);
  const old = await fs.readFile(path(), "utf8");
  const reader = await fs.open(path(), "r");
  try {
    // When
    const saved = await saveCheckpoint(state.dir, { ...fixture(), name: "New Dori" });
    // Then
    expect(await reader.readFile("utf8")).toBe(old);
    expect(await readCheckpoint(state.dir)).toEqual(saved);
    expect((await fs.stat(path())).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(state.dir)).toEqual(["checkpoint.json"]);
  } finally {
    await reader.close();
  }
});

test("failed validation leaves existing bytes and permissions unchanged", async () => {
  // Given
  await saveCheckpoint(state.dir, fixture());
  const old = await fs.readFile(path(), "utf8");
  const mode = (await fs.stat(path())).mode;
  // When
  await expect(saveCheckpoint(state.dir, { ...fixture(), token: "private-fixture" })).rejects.toBeInstanceOf(CheckpointError);
  // Then
  expect(await fs.readFile(path(), "utf8")).toBe(old);
  expect((await fs.stat(path())).mode).toBe(mode);
  expect(await fs.readdir(state.dir)).toEqual(["checkpoint.json"]);
});

test("failed rename preserves existing data and removes the temporary file", async () => {
  // Given: only the filesystem commit operation fails; actual writes still run.
  await saveCheckpoint(state.dir, fixture());
  const old = await fs.readFile(path(), "utf8");
  const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("private-fixture"));
  try {
    // When
    await expect(saveCheckpoint(state.dir, { ...fixture(), name: "Not committed" })).rejects.toBeInstanceOf(CheckpointError);
    // Then
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(path(), "utf8")).toBe(old);
    expect((await fs.stat(path())).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(state.dir)).toEqual(["checkpoint.json"]);
  } finally {
    rename.mockRestore();
  }
});
