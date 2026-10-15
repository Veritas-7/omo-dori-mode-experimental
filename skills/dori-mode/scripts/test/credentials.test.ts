import { expect, test } from "bun:test";

import { CredentialError, resolveCredentials } from "../src/credentials.ts";
import { run, type Runner } from "../src/run.ts";

const cwd = "/config-directory";
const unused: Runner = async () => { throw new Error("provider must not run"); };

for (const platform of ["slack", "telegram", "discord"] as const) {
  test(`${platform} preserves explicit environment token without calling provider`, async () => {
    // Given
    const token = "  environment-value  ";
    const env = { [`DORI_${platform.toUpperCase()}_TOKEN`]: token };
    // When
    const result = await resolveCredentials(platform, ["provider"], env, unused, cwd);
    // Then
    expect(result).toEqual({ token });
  });
}

test("provider fills missing credentials with substituted argv and anchored options", async () => {
  // Given
  const calls: { argv: readonly string[]; options: unknown }[] = [];
  const runner: Runner = async (argv, options) => {
    calls.push({ argv, options });
    return { code: 0, out: '{"token":"provider-token","cookie":"provider-cookie"}', err: "" };
  };
  // When
  const result = await resolveCredentials("slack", ["provider", "--platform={platform}"], {}, runner, cwd, true);
  // Then
  expect(result).toEqual({ token: "provider-token", cookie: "provider-cookie" });
  expect(calls).toEqual([{ argv: ["provider", "--platform=slack"], options: { cwd, timeoutMs: 10_000 } }]);
});

for (const env of [
  { DORI_SLACK_TOKEN: "environment-token" },
  { DORI_SLACK_COOKIE: "environment-cookie" },
]) {
  test(`provider preserves environment ${Object.keys(env)[0]} while filling missing fields`, async () => {
    // Given
    const runner: Runner = async () => ({ code: 0, out: '{"token":"provider-token","cookie":"provider-cookie"}', err: "" });
    // When
    const result = await resolveCredentials("slack", ["provider"], env, runner, cwd, true);
    // Then
    expect(result).toEqual({ token: env.DORI_SLACK_TOKEN ?? "provider-token", cookie: env.DORI_SLACK_COOKIE ?? "provider-cookie" });
  });
}

test("complete Slack environment avoids provider even when cookie is required", async () => {
  // Given
  const env = { DORI_SLACK_TOKEN: "token", DORI_SLACK_COOKIE: " cookie " };
  // When
  const result = await resolveCredentials("slack", ["provider"], env, unused, cwd, true);
  // Then
  expect(result).toEqual({ token: "token", cookie: " cookie " });
});

for (const env of [{ DORI_SLACK_TOKEN: "" }, { DORI_SLACK_TOKEN: " \t" }, { DORI_SLACK_COOKIE: "" }]) {
  test(`explicit empty environment ${JSON.stringify(env)} fails before provider`, async () => {
    // Given
    let called = false;
    const runner: Runner = async () => { called = true; return { code: 0, out: '{"token":"replacement"}', err: "" }; };
    // When
    const result = resolveCredentials("slack", ["provider"], env, runner, cwd);
    // Then
    await expect(result).rejects.toBeInstanceOf(CredentialError);
    expect(called).toBe(false);
  });
}

for (const command of [undefined, []]) {
  test(`missing credentials fail without a usable provider ${JSON.stringify(command)}`, async () => {
    // Given / When
    const result = resolveCredentials("telegram", command, {}, unused, cwd);
    // Then
    await expect(result).rejects.toBeInstanceOf(CredentialError);
  });
}

for (const out of ["secret-invalid-json", "null", "[]", "{}", '{"token":42}', '{"token":""}', '{"token":"x","cookie":42}', '{"token":"x","cookie":""}']) {
  test(`invalid provider response is rejected: ${out}`, async () => {
    // Given
    const runner: Runner = async () => ({ code: 0, out, err: "private-stderr" });
    // When
    const result = resolveCredentials("slack", ["private-argv"], {}, runner, cwd);
    // Then
    await expect(result).rejects.toBeInstanceOf(CredentialError);
    await expect(result).rejects.not.toThrow("secret-invalid-json");
  });
}

test("required Slack cookie cannot be omitted by the provider", async () => {
  // Given
  const runner: Runner = async () => ({ code: 0, out: '{"token":"token"}', err: "" });
  // When
  const result = resolveCredentials("slack", ["provider"], {}, runner, cwd, true);
  // Then
  await expect(result).rejects.toBeInstanceOf(CredentialError);
});

for (const runner of [
  (async () => { throw new Error("private-argv private-token private-stderr"); }) satisfies Runner,
  (async () => ({ code: 124, out: "private-token", err: "private-stderr" })) satisfies Runner,
  run,
]) {
  test("provider failures never expose argv, output, stderr, or thrown details", async () => {
    // Given / When
    const result = resolveCredentials("discord", ["/nonexistent/private-argv"], {}, runner, cwd);
    // Then
    await expect(result).rejects.toBeInstanceOf(CredentialError);
    try {
      await result;
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialError);
      expect(String(error)).not.toMatch(/private-argv|private-token|private-stderr/);
      expect(error instanceof Error && error.cause).toBeUndefined();
    }
  });
}
