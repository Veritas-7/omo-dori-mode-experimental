import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { Http } from "../src/messenger/http.ts";
import { Slack } from "../src/messenger/slack.ts";
import { pollSlackInbound } from "../src/messenger/slack-inbound.ts";
import { ThreadLedger } from "../src/messenger/thread-ledger.ts";
import { fakeClock, withState } from "./fakes.ts";

const resources: ReturnType<typeof withState>[] = [];
afterEach(() => { for (const state of resources.splice(0)) state.done(); });

const setup = (failure?: { readonly channel: string; active: boolean }) => {
  const state = withState();
  resources.push(state);
  const file = join(state.dir, "threads.json");
  const calls: string[] = [];
  const http: Http = async (request) => {
    const url = new URL(request.url);
    const method = url.pathname.split("/").pop() ?? "";
    calls.push(method);
    const params = request.method === "GET" ? Object.fromEntries(url.searchParams) : JSON.parse(String(request.body));
    let response: Record<string, unknown>;
    switch (method) {
      case "users.conversations":
        response = params.cursor ? { channels: [{ id: "C1" }] } :
          { channels: [{ id: "D1", is_im: true }], response_metadata: { next_cursor: "channel-page-2" } };
        break;
      case "conversations.history": {
        if (failure?.active && params.channel === failure.channel) return { status: 200, headers: {}, body: JSON.stringify({ ok: false, error: "channel_not_found" }) };
        const messages = params.channel === "C1"
          ? [{ ts: "12.0", user: "U_OWNER", text: "<@U_DORI> check this" }, { ts: "11.0", user: "U_TEAM", text: "not addressed" }]
          : params.cursor
            ? [{ ts: "8.0", user: "U_OWNER", text: "earlier" }]
            : [{ ts: "10.0", user: "U_OWNER", text: "hello" }, { ts: "9.0", user: "U_DORI", text: "my message", bot_id: "B1" }];
        response = { messages: messages.filter((message) => Number(message.ts) > Number(params.oldest)),
          ...(!params.cursor && params.channel === "D1" ? { response_metadata: { next_cursor: "history-page-2" } } : {}) };
        break;
      }
      case "conversations.replies":
        response = { messages: [{ ts: "20.0", user: "U_OWNER", text: "follow-up" }].filter((message) => Number(message.ts) > Number(params.oldest)) };
        break;
      default:
        return { status: 200, headers: {}, body: JSON.stringify({ ok: false, error: "not_allowed_token_type" }) };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true, ...response }) };
  };
  return { file, calls, ledger: new ThreadLedger(file), slack: new Slack(http, fakeClock(0), { token: "bot-fixture" }) };
};

test("bot polling uses supported paginated APIs and persists DM, mention and watched-thread progress", async () => {
  // Given a bot that cannot use user-client APIs and a previously watched thread.
  const f = setup();
  await f.ledger.record("D1", "1.0", "1.0");
  // When two poller instances read the same persisted ledger.
  const first = await pollSlackInbound(f.slack, f.ledger, { selfUserId: "U_DORI", botToken: true, since: "0" });
  const second = await pollSlackInbound(f.slack, new ThreadLedger(f.file), { selfUserId: "U_DORI", botToken: true, since: "0" });
  // Then paginated addressed messages are delivered once, not bot posts or unrelated channel chatter.
  expect(first.map((message) => message.ts).sort()).toEqual(["10.0", "12.0", "20.0", "8.0"]);
  expect(second).toEqual([]);
  expect(f.calls).not.toContain("subscriptions.thread.getView");
  expect(f.calls).not.toContain("client.counts");
  expect((await f.ledger.list()).map((thread) => thread.rootTs)).toEqual(["1.0"]);
});

test("a newly connected bot does not replay messages from before its startup watermark", async () => {
  // Given old messages but no persisted channel cursor.
  const f = setup();
  // When the poller starts with a later explicit watermark.
  const messages = await pollSlackInbound(f.slack, f.ledger, { selfUserId: "U_DORI", botToken: true, since: "100" });
  // Then historical requests are not treated as new owner instructions.
  expect(messages).toEqual([]);
});

test("a failed later channel leaves earlier undelivered thread and channel progress available after restart", async () => {
  // Given an owner request in the first channel and a failure in the next.
  const failure = { channel: "C1", active: true };
  const f = setup(failure);
  await f.ledger.record("D1", "1.0", "1.0");
  // When the full poll fails before its collected messages can be returned.
  await expect(pollSlackInbound(f.slack, f.ledger, { selfUserId: "U_DORI", botToken: true, since: "0" })).rejects.toThrow("channel_not_found");
  // Then no undelivered progress is committed, including after a new ledger instance resumes.
  expect(await f.ledger.channelSeen("D1")).toBeUndefined();
  expect((await f.ledger.list())[0]?.seenTs).toBe("1.0");
  failure.active = false;
  const resumed = await pollSlackInbound(f.slack, new ThreadLedger(f.file), { selfUserId: "U_DORI", botToken: true, since: "0" });
  expect(resumed.map((message) => message.ts).sort()).toEqual(["10.0", "12.0", "20.0", "8.0"]);
});
