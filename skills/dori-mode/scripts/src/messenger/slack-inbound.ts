import type { Slack } from "./slack.ts";
import { type ThreadLedger, tsAfter } from "./thread-ledger.ts";

export type Inbound = {
  readonly source: "threads-view" | "own-thread" | "unread";
  readonly channel: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly user?: string;
  readonly text?: string;
};

type Msg = { readonly ts?: string; readonly thread_ts?: string; readonly user?: string; readonly text?: string; readonly bot_id?: string; readonly channel?: string };
type ThreadView = { readonly root_msg?: Msg & { readonly channel?: string }; readonly unread_replies?: readonly Msg[] };
type Counted = { readonly id: string; readonly has_unreads?: boolean; readonly mention_count?: number };

export type InboundOptions = {
  readonly selfUserId: string;
  readonly threadsViewLimit?: number;
  readonly botToken?: boolean;
  readonly since?: string;
};

const nextCursor = (page: Record<string, unknown>): string => {
  const metadata = page.response_metadata;
  return metadata && typeof metadata === "object" && "next_cursor" in metadata && typeof metadata.next_cursor === "string" ? metadata.next_cursor : "";
};

export const pollSlackInbound = async (slack: Slack, ledger: ThreadLedger, opts: InboundOptions): Promise<Inbound[]> => {
  const out: Inbound[] = [];
  const seen = new Set<string>();
  const progress: { channel: string; rootTs: string; seenTs: string }[] = [];
  const commitProgress = async () => {
    for (const update of progress) {
      if (update.rootTs === "0") await ledger.markChannelSeen(update.channel, update.seenTs);
      else await ledger.markSeen(update.channel, update.rootTs, update.seenTs);
    }
  };
  const add = (i: Inbound) => {
    const k = `${i.channel}:${i.ts}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(i);
  };
  const fromOthers = (m: Msg) => m.user !== undefined && m.user !== opts.selfUserId && !m.bot_id;

  const view = opts.botToken ? {} : (await slack.call("subscriptions.thread.getView", { limit: opts.threadsViewLimit ?? 20 })) as { threads?: readonly ThreadView[] };
  for (const t of view.threads ?? []) {
    const channel = t.root_msg?.channel;
    if (!channel) continue;
    for (const m of t.unread_replies ?? []) {
      if (!m.ts || !fromOthers(m)) continue;
      add({ source: "threads-view", channel, ts: m.ts, threadTs: m.thread_ts, user: m.user, text: m.text });
      if (m.thread_ts) progress.push({ channel, rootTs: m.thread_ts, seenTs: m.ts });
    }
  }

  for (const t of await ledger.list()) {
    const r = (await slack.call("conversations.replies", { channel: t.channel, ts: t.rootTs, oldest: t.seenTs, inclusive: false, limit: 50 })) as { messages?: readonly Msg[] };
    let newest = t.seenTs;
    for (const m of r.messages ?? []) {
      if (!m.ts || !tsAfter(m.ts, t.seenTs)) continue;
      if (tsAfter(m.ts, newest)) newest = m.ts;
      if (fromOthers(m)) add({ source: "own-thread", channel: t.channel, ts: m.ts, threadTs: t.rootTs, user: m.user, text: m.text });
    }
    if (newest !== t.seenTs) progress.push({ channel: t.channel, rootTs: t.rootTs, seenTs: newest });
  }

  if (opts.botToken) {
    // Bot tokens cannot use Slack's private user-client threads/count APIs.
    // Persist per-channel progress so a fresh process does not replay requests.
    const since = opts.since ?? String(Date.now() / 1000);
    let cursor = "";
    do {
      const page = await slack.call("users.conversations", { types: "public_channel,private_channel,im,mpim", limit: 200, ...(cursor ? { cursor } : {}) });
      const channels: readonly unknown[] = Array.isArray(page.channels) ? page.channels : [];
      for (const channel of channels) {
        if (!channel || typeof channel !== "object" || !("id" in channel) || typeof channel.id !== "string") continue;
        const id = channel.id;
        const direct = ("is_im" in channel && channel.is_im === true) || ("is_mpim" in channel && channel.is_mpim === true);
        const oldest = await ledger.channelSeen(id) ?? since;
        let newest = oldest;
        let historyCursor = "";
        do {
          const history = await slack.call("conversations.history", { channel: id, oldest, inclusive: false, limit: 100, ...(historyCursor ? { cursor: historyCursor } : {}) });
          const messages: readonly unknown[] = Array.isArray(history.messages) ? history.messages : [];
          for (const message of messages) {
            if (!message || typeof message !== "object" || !("ts" in message) || typeof message.ts !== "string" || !tsAfter(message.ts, oldest)) continue;
            if (tsAfter(message.ts, newest)) newest = message.ts;
            if (!("user" in message) || typeof message.user !== "string" || message.user === opts.selfUserId || "bot_id" in message) continue;
            const text = "text" in message && typeof message.text === "string" ? message.text : "";
            if (!direct && !text.includes(`<@${opts.selfUserId}>`)) continue;
            add({ source: "unread", channel: id, ts: message.ts, user: message.user, text });
          }
          historyCursor = nextCursor(history);
        } while (historyCursor);
        progress.push({ channel: id, rootTs: "0", seenTs: newest });
      }
      cursor = nextCursor(page);
    } while (cursor);
    await commitProgress();
    return out;
  }

  const counts = (await slack.call("client.counts", {})) as { channels?: readonly Counted[]; ims?: readonly Counted[]; mpims?: readonly Counted[] };
  for (const c of [...(counts.ims ?? []), ...(counts.mpims ?? []), ...(counts.channels ?? []).filter((c) => (c.mention_count ?? 0) > 0)]) {
    if (c.has_unreads || (c.mention_count ?? 0) > 0) add({ source: "unread", channel: c.id, ts: "", text: `${c.mention_count ?? 0} mention(s), unread` });
  }
  await commitProgress();
  return out;
};
