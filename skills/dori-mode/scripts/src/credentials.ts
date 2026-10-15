import { fill } from "./config.ts";
import type { Ran, Runner } from "./run.ts";

export class CredentialError extends Error {
  readonly code = "CREDENTIAL_ERROR";
}

export const resolveCredentials = async (
  platform: "slack" | "telegram" | "discord",
  command: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
  runner: Runner,
  cwd: string,
  requireCookie = false,
): Promise<{ token: string; cookie?: string }> => {
  const token = env[`DORI_${platform.toUpperCase()}_TOKEN`];
  const cookie = platform === "slack" ? env.DORI_SLACK_COOKIE : undefined;
  const needsCookie = platform === "slack" && requireCookie;
  if (token !== undefined && !token.trim()) throw new CredentialError("empty credential token environment variable");
  if (cookie !== undefined && !cookie.trim()) throw new CredentialError("empty credential cookie environment variable");
  if (token !== undefined && (!needsCookie || cookie !== undefined)) {
    return { token, ...(cookie === undefined ? {} : { cookie }) };
  }
  if (!command?.length) throw new CredentialError("required credentials are missing");

  let result: Ran;
  try {
    result = await runner(fill(command, { platform }), { cwd, timeoutMs: 10_000 });
  } catch {
    // Provider errors may contain argv or credentials; never propagate them.
    throw new CredentialError("credential provider failed");
  }
  if (result.code !== 0) throw new CredentialError("credential provider failed");
  let value: unknown;
  try {
    value = JSON.parse(result.out);
  } catch {
    throw new CredentialError("invalid credential provider response");
  }
  if (
    typeof value !== "object" || value === null || Array.isArray(value)
    || !("token" in value) || typeof value.token !== "string" || !value.token.trim()
    || ("cookie" in value && (typeof value.cookie !== "string" || !value.cookie.trim()))
  ) throw new CredentialError("invalid credential provider response");
  const resolvedCookie = cookie ?? (platform === "slack" && "cookie" in value && typeof value.cookie === "string" ? value.cookie : undefined);
  if (needsCookie && resolvedCookie === undefined) throw new CredentialError("required credential cookie is missing");
  return { token: token ?? value.token, ...(resolvedCookie === undefined ? {} : { cookie: resolvedCookie }) };
};
