import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withState } from "./fakes.ts";
import { acquireMonitorLock } from "../src/monitor-lock.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const resources: ReturnType<typeof withState>[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.done();
});

const setup = async () => {
  const state = withState();
  resources.push(state);
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ stateDir: join(state.dir, "state"), leadPane: "old:pane", defaultModel: "pinned/model", extraLocalField: "preserved",
    credentialCommand: [process.execPath, "-e", 'console.log(JSON.stringify({token:"private-fixture-token"}))'] }));
  const env: Record<string, string | undefined> = { ...process.env, DORI_CONFIG: path };
  delete env.DORI_STATE_DIR;
  delete env.DORI_LEAD_PANE;
  delete env.DORI_SLACK_TOKEN;
  delete env.DORI_SLACK_COOKIE;
  const invoke = async (args: string[], cwd = state.dir) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code };
  };
  return { dir: state.dir, path, invoke, env };
};

test("new processes restore completed onboarding and context from another cwd without exposing credentials", async () => {
  // Given a checkpoint recorded by a previous process.
  const f = await setup();
  const input = join(f.dir, "input.json");
  await Bun.write(input, JSON.stringify({ schemaVersion: 1, name: "TestDori", platform: "slack",
    onboarding: { status: "complete", tools: { gh: "allowed", mail: "declined" } },
    contextRefs: [{ kind: "session", ref: "previous-session" }, { kind: "file", ref: input }] }));
  expect((await f.invoke(["checkpoint", "--file", input])).code).toBe(0);
  // When a fresh process resumes from outside that directory.
  const r = await f.invoke(["resume", "--json", "--lead-pane", "new:pane"], tmpdir());
  // Then consent, context and unrelated config survive, but no credential is printed.
  expect(r.code).toBe(0);
  const restored = JSON.parse(r.out);
  expect(restored.checkpoint.onboarding).toEqual({ status: "complete", tools: { gh: "allowed", mail: "declined" } });
  expect(restored.checkpoint.name).toBe("TestDori");
  expect(restored.checkpoint.contextRefs[0]).toEqual({ kind: "session", ref: "previous-session" });
  expect(restored.leadPane).toBe("new:pane");
  expect(restored.auth.status).toBe("resolved");
  expect(r.out + r.err).not.toContain("private-fixture-token");
  const config = await Bun.file(f.path).json();
  expect(config.defaultModel).toBe("pinned/model");
  expect(config.extraLocalField).toBe("preserved");
});

test("a missing checkpoint is first-run, while malformed persisted state fails instead of resetting consent", async () => {
  // Given existing configuration without a checkpoint.
  const f = await setup();
  expect(JSON.parse((await f.invoke(["resume", "--json"])).out).status).toBe("first-run");
  await Bun.write(join(f.dir, "state/checkpoint.json"), '{"broken":');
  // When resume reads malformed persisted state.
  const r = await f.invoke(["resume", "--json"]);
  // Then it fails and leaves the state intact.
  expect(r.code).not.toBe(0);
  expect(await Bun.file(join(f.dir, "state/checkpoint.json")).text()).toBe('{"broken":');
  expect(r.out).not.toContain("first-run");
});

test("keyed resume still dispatches to lane lookup rather than lead bootstrap", async () => {
  // Given no lane with that key.
  const f = await setup();
  // When a keyed resume is invoked.
  const r = await f.invoke(["resume", "missing-lane", "--json"]);
  // Then it uses the existing lane error, not a first-run bootstrap response.
  expect(r.code).not.toBe(0);
  expect(r.err).toContain('no registered lane "missing-lane"');
  expect(r.out).toBe("");
});

test("a second watcher is refused and normal termination releases the first watcher lock", async () => {
  // Given a watcher whose readiness signal is observed before attempting duplication.
  const f = await setup();
  const child = Bun.spawn([process.execPath, cli, "watch"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    let output = "";
    const signal = AbortSignal.timeout(10_000);
    while (!output.includes("LANE_WATCH_READY")) {
      const value = await Promise.race([reader.read(), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      if (value.done) throw new Error("Watcher exited before readiness");
      output += new TextDecoder().decode(value.value);
    }
    reader.releaseLock();
    // When another process tries to watch the same state.
    const duplicate = await f.invoke(["watch"]);
    // Then only the original remains alive.
    expect(duplicate.code).not.toBe(0);
    expect(duplicate.err).toContain("MONITOR_ALREADY_RUNNING");
    expect(child.exitCode).toBeNull();
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
  // The same monitor lock can actually be acquired again after normal termination.
  const reacquired = acquireMonitorLock(join(f.dir, "state"), "watch");
  reacquired.release();
});

test("a monitor cannot change its ownership key using an ignored positional argument", async () => {
  // Given a CLI monitor invocation with an unsupported positional argument.
  const f = await setup();
  const child = Bun.spawn([process.execPath, cli, "watch", "extra-key"], { env: f.env, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const errorOutput = new Response(child.stderr).text();
  try {
    // When it emits stdout or closes it on rejection (not a timed poll).
    const event = await child.stdout.getReader().read();
    const text = event.done ? await errorOutput : new TextDecoder().decode(event.value);
    // Then it is rejected before it can become a second READY consumer.
    expect(text).toContain("MONITOR_ARGUMENT_ERROR");
    expect(await child.exited).toBe(2);
    expect(text).not.toContain("LANE_WATCH_READY");
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
});
