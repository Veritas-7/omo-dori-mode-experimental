import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireMonitorLock, MonitorLockError } from "../monitor-lock.ts";

export const tsAfter = (a: string, b: string): boolean => Number(a) > Number(b);

export type LedgerThread = { readonly channel: string; readonly rootTs: string; readonly seenTs: string };

export class ThreadLedger {
  private threads = new Map<string, LedgerThread>();

  constructor(private readonly file: string) {}

  private key(channel: string, rootTs: string): string {
    return `${channel}:${rootTs}`;
  }

  async load(): Promise<void> {
    const f = Bun.file(this.file);
    const entries: LedgerThread[] = (await f.exists()) ? await f.json() : [];
    this.threads = new Map(entries.map((t) => [this.key(t.channel, t.rootTs), t]));
  }

  private async save(): Promise<void> {
    const pending = new Map(this.threads);
    const directory = dirname(this.file);
    const lockDirectory = join(directory, "monitor-locks");
    mkdirSync(lockDirectory, { recursive: true });
    const timeout = AbortSignal.timeout(10_000);
    for (;;) {
      let notify = () => {};
      const changed = new Promise<void>((resolve) => { notify = resolve; });
      // Subscribe before trying the lock so a concurrent release cannot be missed.
      const watcher = watch(lockDirectory, () => notify());
      try {
        let lock;
        try {
          lock = acquireMonitorLock(directory, `thread-ledger:${basename(this.file)}`);
        } catch (error) {
          if (!(error instanceof MonitorLockError)) throw error;
          await Promise.race([changed, new Promise<never>((_, reject) => {
            if (timeout.aborted) reject(new MonitorLockError());
            else timeout.addEventListener("abort", () => reject(new MonitorLockError()), { once: true });
          })]);
          continue;
        }
        try {
          const entries: LedgerThread[] = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
          const merged = new Map(entries.map((t) => [this.key(t.channel, t.rootTs), t]));
          for (const [key, value] of pending) {
            const current = merged.get(key);
            if (!current || tsAfter(value.seenTs, current.seenTs)) merged.set(key, value);
          }
          const temp = `${this.file}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temp, JSON.stringify([...merged.values()], null, 1), { flag: "wx", mode: 0o600 });
            renameSync(temp, this.file);
          } finally {
            rmSync(temp, { force: true });
          }
          this.threads = merged;
          return;
        } finally {
          lock.release();
        }
      } finally {
        watcher.close();
      }
    }
  }

  async record(channel: string, rootTs: string, postedTs: string): Promise<void> {
    await this.load();
    const k = this.key(channel, rootTs);
    const prev = this.threads.get(k);
    const seenTs = prev && tsAfter(prev.seenTs, postedTs) ? prev.seenTs : postedTs;
    this.threads.set(k, { channel, rootTs, seenTs });
    await this.save();
  }

  async markSeen(channel: string, rootTs: string, ts: string): Promise<void> {
    await this.load();
    const prev = this.threads.get(this.key(channel, rootTs));
    if (!prev || !tsAfter(ts, prev.seenTs)) return;
    this.threads.set(this.key(channel, rootTs), { ...prev, seenTs: ts });
    await this.save();
  }

  async list(): Promise<LedgerThread[]> {
    await this.load();
    return [...this.threads.values()].filter((thread) => thread.rootTs !== "0");
  }

  /** Slack message timestamps are positive; root "0" stores a channel watermark. */
  async channelSeen(channel: string): Promise<string | undefined> {
    await this.load();
    return this.threads.get(this.key(channel, "0"))?.seenTs;
  }

  async markChannelSeen(channel: string, ts: string): Promise<void> {
    await this.record(channel, "0", ts);
  }
}
