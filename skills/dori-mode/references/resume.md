# Restarting a Dori

Setup and onboarding happen once. Starting a new coding-agent conversation must not create a new identity, forget tool denials, or assume old monitors deliver into the new conversation.

The default config is `~/.dori/config.json` (`DORI_CONFIG` overrides it), and the default state directory is `~/.dori/state` (`stateDir` in config, then `DORI_STATE_DIR`, override it). These defaults do not depend on the current directory. A `first-run` response means no checkpoint at that selected state location: follow [setup.md](setup.md) only after checking whether an existing installation should be migrated.

## Save the restoration checkpoint

Use `dori checkpoint --file FILE` with a JSON document:

```json
{
  "schemaVersion": 1,
  "name": "WorkDori",
  "platform": "slack",
  "onboarding": {
    "status": "complete",
    "tools": { "github": "allowed", "mail": "declined" }
  },
  "contextRefs": [
    { "kind": "file", "ref": "~/work/current-status.md" },
    { "kind": "session", "ref": "the-agent-session-id" }
  ]
}
```

Statuses are `pending`, `in-progress`, `complete` and `declined`. Tool decisions are `allowed` or `declined`. File references must be absolute (a leading `~/` is expanded). Session references are opaque identifiers to look up through the agent's session reader. Unknown fields are rejected; keep credentials and message bodies out of this document.

The CLI validates before replacing `<stateDir>/checkpoint.json` atomically with mode `0600`. Invalid input does not replace the last good checkpoint. Save after each setup/consent/context change. Keep ongoing goals and scheduled work in the durable files named by `contextRefs`, and keep those files current.

## Restore before doing work

1. Run `dori resume --json` from any directory. It returns `first-run` only for a missing checkpoint; malformed or unsupported checkpoints fail instead of silently starting onboarding.
2. Read the restored context references and lane briefs/history. The checkpoint is a map to the work, not a replacement for reading it. Existing agent memories still matter.
   Record this activation's lead session reference and current durable work records in a new checkpoint, preserving previous references and consent. If the harness cannot expose a session id, keep an up-to-date durable work/handoff file as the reference. Save before reporting readiness.
3. Verify the current herdr pane. `dori resume --json --lead-pane PANE` updates only `leadPane`, preserving unknown local config fields and model pins. Existing monitor processes do not reload their config; reconcile them separately.
4. Check `auth.status`. `resolved` means a credential was found, **not** that Slack accepted it. `error` requires repairing the existing credential source, not repeating onboarding.
5. Arm the listed persistent monitors through the current agent's monitor tool and observe readiness. Only then report that the Dori is listening. The JSON command itself sends no messages and starts no background processes.

`dori resume LANE_KEY` retains its existing meaning: resume a paused lane. It is separate from keyless lead restoration.

Use `herdr pane current` to find the current `pane_id`. Registered lane files are `<stateDir>/lanes/KEY.json`; the returned `lanes` include the saved brief, session, thread and history. Read the referenced files/sessions rather than treating an empty lane list as evidence that no earlier work exists.

The response has this shape (arrays shortened here):

```json
{
  "schemaVersion": 1,
  "status": "restored",
  "checkpoint": { "schemaVersion": 1, "name": "WorkDori", "platform": "slack", "onboarding": { "status": "complete", "tools": {} }, "contextRefs": [] },
  "leadPane": "w1:p1",
  "lanes": [],
  "auth": { "status": "resolved" },
  "monitors": [{ "key": "watch", "argv": ["dori", "watch"], "filter": "^LANE_", "owner": null }]
}
```

For each returned `monitors` entry, pass its argv as the persistent command and its filter to the current agent's monitor/subscription tool. There is deliberately no universal agent-specific monitor command in the CLI. Confirm `LANE_WATCH_READY`, `FRESHNESS_READY`, `DEAD_PANES_READY`, `HOST_GUARD_READY`, and (for Slack) `INBOUND_READY slack`. A non-null `owner` reports a recorded PID, not proof that it is still alive or attached to this conversation.

If an old monitor belongs to the previous conversation, locate its handle in the saved session record, stop that **owned monitor** through the session tool, and observe termination before replacing it. Never stop the agent conversation itself or signal a PID merely because a lock mentions it. If ownership cannot be established, report the conflict rather than claiming restoration. After replacement, verify a new owner message reaches the new conversation; process existence or a READY line alone does not prove routing into the agent.

## Credentials survive a fresh shell

Existing `DORI_SLACK_TOKEN`, `DORI_TELEGRAM_TOKEN` and `DORI_DISCORD_TOKEN` environment variables still take priority. Slack user presence also needs `DORI_SLACK_COOKIE`.

For an existing secret store, add `credentialCommand` as a top-level field in `~/.dori/config.json` (or the file selected by `DORI_CONFIG`), preserving its other fields:

```json
{
  "credentialCommand": ["/absolute/path/to/credential-helper", "{platform}"]
}
```

The helper must print JSON `{"token":"...","cookie":"..."}` (cookie is optional except for Slack user presence). It runs without an implicit shell, from the config directory, with a 10-second timeout. It is invoked only for missing required values and never overrides environment values. An explicitly empty value is an error. Use absolute executable/file paths so the helper works from any project. Any shell used explicitly in argv is trusted local code.

Provider output, stderr, argv and credentials are never included in resolver errors or the resume JSON. The resume output contains local context/session references, so keep it private. This feature does not install a secret store, recover lost tokens, or publish credentials into config.

Slack bot tokens use the public conversations APIs for DMs, mentions and watched threads, rather than private user-client threads/count endpoints. Channel watermarks share the persisted thread ledger, so fresh processes continue from saved progress. A channel discovered for the first time starts at the current activation watermark instead of treating historical messages as new instructions. `INBOUND_READY slack` is printed only after authentication and the first complete poll succeed.

## One owner per state directory

Long-running `watch`, `freshness`, `dead-panes`, `guard`, `inbound` and `presence` commands acquire exclusive monitor locks under their state directory. A second process fails with `MONITOR_ALREADY_RUNNING` before polling or sending; it never signals the first process.

Normal termination (including SIGTERM and SIGINT) releases the process's own lock. SIGKILL or a machine crash can leave a lock. Inspect its recorded PID and the actual process before removing a stale lock; never remove it because it is old, or while its consumer is alive. A new agent must reconcile existing owners before claiming readiness. Different state directories are intentionally independent; do not use another directory to get around an active consumer.
