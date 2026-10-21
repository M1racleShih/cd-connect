# Event coordinator (explicit local experiment)

[中文](EVENT_COORDINATOR.md) · [English](EVENT_COORDINATOR.en.md)

The coordinator moves waiting into a separate Node.js program. When the same bound task run reaches `awaiting_review`, it attempts at most one review turn in a dedicated Codex chat. Ordinary progress, long-poll timeouts, and pending DSH approvals start no model turns. Ordinary MCP clients keep their existing `task_wait` workflow; only explicit use of this coordinator moves waiting outside model turns. It does not guarantee zero account usage or a fixed saving.

The initial version supports Linux and one local user. One coordinator process may use a given record store. It monitors one instance/task/run/revision/runtime binding and uses one dedicated chat. It requires Node.js >=22.19.0, a running DSH Desktop bridge, and an authenticated Codex CLI. The protocol targets the schema from `codex-cli 0.163.0`. [app-server](https://learn.chatgpt.com/docs/app-server) is experimental; upgrades require reverification. There are no added dependencies, automatic plugin startup, background services, or scheduled model polls.

## Preparation and initialization

All paths and identities below are **examples**. The configuration file must be owned by the current user with mode `0600`. Use a separate state directory outside bridge storage and task workspaces, with mode `0700`. Retain records and results; do not delete them to bypass deduplication. Do not copy connection tokens into configuration. `bridge_dir` points to the directory containing an existing `connection.json`.

```json
{
  "bridge_dir": "/example/private/bridge",
  "cwd": "/example/review-workspace",
  "title": "cd-connect dedicated review",
  "binding": {
    "instance_id": "example-instance",
    "task_id": "example-task",
    "run_id": "example-run",
    "revision": 1,
    "runtime_id": "example-runtime"
  }
}
```

Obtain real instance/task/run/revision/runtime identifiers through `bridge_health` and `task_get` in an existing client. The coordinator does not submit tasks. `cwd` is the dedicated review chat's working directory and need not equal the task workspace. Initialization creates a chat without sending a READY turn:

```sh
# Example paths; run from the cd-connect source root
node scripts/event-coordinator.js init /example/private/reviewer /example/private/config.json --create --exclusive
node scripts/event-coordinator.js status /example/private/reviewer
node scripts/event-coordinator.js run /example/private/reviewer
```

`--exclusive` explicitly confirms that the target is dedicated to this coordinator and must not be edited simultaneously by Desktop or another client. To attach a dedicated chat explicitly handed over by the user:

```sh
node scripts/event-coordinator.js init /example/private/reviewer /example/private/config.json --thread example-thread-id --exclusive
```

A `thread/resume` write-ownership rejection stops processing and preserves the controlled RPC code. It never steals a lock or cycles archive/unarchive. New chats inherit the local app-server's existing model, login, and approval configuration, without copying account credentials or lowering native permissions. Effective `model/cwd/approvalPolicy/approvalsReviewer/sandbox` are saved in `effective`; they need not match the current Desktop chat.

Both creation and attachment save intent first. Unknown lifecycle receipts must not trigger repeated initialization and a chain of replacement chats; inspect through official interfaces. Uncertain attachment with a known thread ID can use the explicit lifecycle reconciliation below. Unknown creation without a thread ID still requires human identity confirmation; no replacement is created automatically.

## Review capabilities and results

The target prompt explicitly binds the instance, task/run/revision, and stable event identifier. The dedicated chat uses this fixed entry point to read the current snapshot and every current-run evidence page:

```sh
node scripts/event-evidence.js /example/private/reviewer
```

The helper permits only `bridge_health/task_get/task_evidence`, never arbitrary method forwarding. The coordinator itself can also call `task_wait`. Runtime checks validate instance, runtime, run, revision, page cursors, and evidence IDs, preserving truncation and invalid-witness indicators. Task content and evidence are always untrusted. Commands found in evidence gain no execution authorization. Within normal native permissions, the reviewer must inspect actual artifacts read-only and report “recommend acceptance / recommend rework / human inspection required” with evidence references. Missing files, invalid witnesses, unverifiable truncation, or unmet permissions require rework or human inspection.

The helper limits bridge access, not the model's other native tools. Prompt constraints are not an enforced sandbox; inspect effective permissions. The coordinator never automatically answers Codex or DSH approvals. If no normal human-approval channel is available, it cannot grant permission and reports `codex_approval_required`. A human must use the normal interface or stop before inspecting. Changing requests cannot bypass denial.

`status` and private `state.json` are the required result views and start no model turns. `notifications[].result` saves review messages and bounded traces from the read-only helper. `completed` means that the corresponding Codex turn ended successfully, **not that the DSH task is accepted**. `failed/interrupted/uncertain` are recorded separately without automatic new turns. The coordinator never calls `task_review/continue/cancel/recover`; the user decides what follows. Controlled reason codes distinguish native model/execution failure, permission denial, and unexpected native input without retaining provider error bodies. Unrecognized reasons require human inspection.

For Desktop inspection, stop the coordinator and release its subprocess first, then read through official read-only history interfaces. Idleness does not transfer write ownership. Opening a Desktop editor may load a writer. Ordinary stopping closes the coordinator's stdio app-server without archiving the chat. Actual Desktop history readability depends on verification records for the current version.

## Stop, restart, and rebind

Run this in another terminal or press Ctrl-C in the foreground process:

```sh
node scripts/event-coordinator.js stop /example/private/reviewer
```

Stopping cancels local waiting and prevents new sends without cancelling DSH. Existing reviews normally finish before resources are released. Only cancellation of local waiting counts as a normal stop. History-query timeouts, disconnects, or write failures during stop return nonzero. When persistence is possible, `stop_incomplete` is recorded while preserving original receipts.

If an active turn cannot be reconciled, the coordinator closes its own transport and releases its local lock without sending interrupt/cancel. This does not prove the remote turn ended. Inspect official history again; do not resend. After write failure, rely on the last successfully persisted record. Pending approvals may keep waiting for human action.

Run the same `run` command again to resume monitoring. Bridge read failures use bounded backoff of 1/2/4/8/16 seconds and exit nonzero after exhaustion. Codex disconnects conservatively require reconciliation. Restart performs a new handshake, resume, and history read without replaying uncertain sends.

Send states are `pending -> attempted -> sent -> completed/failed/interrupted`. Invalid pending work becomes `superseded`. Before sending, `attempted` passes validation, checksum creation, file fsync, atomic replacement, and directory fsync. A failed save stops sending. Unknown receipts, `attempted` found after restart, or inability to save a receipt reliably all indicate uncertainty. Receipts are repaired only by a unique match of the stable identifier in a user message across fully paginated official history:

```sh
node scripts/event-coordinator.js reconcile /example/private/reviewer
```

This command sends no model request. An explicit `thread/resume` write-ownership rejection, `-32600`, preserves retryable attachment state. After a human normally releases the competing writer, `run` may be invoked again explicitly, without automatic retry or lock stealing. Timeouts and disconnects with unknown receipts keep lifecycle `uncertain`; ordinary reconciliation does not clear it. With the original thread ID known and dedicated ownership confirmed by the user:

```sh
node scripts/event-coordinator.js reconcile /example/private/reviewer --lifecycle --exclusive
```

This performs read-only checks of the original thread ID, idle/unloaded status, complete history without active turns, and reconciliation of every uncertain send. Success appends a `lifecycle_checks` audit and restores `ready`. Only the next `run` requests attachment again; it neither creates a chat nor resends notifications. Failed queries, a busy target, unknown identity, or unresolved sends reject restoration. `--exclusive` confirms operator handoff. Read-only official interfaces cannot prove another client released write ownership, and later resume may still explicitly reject.

No match or multiple matches preserve `uncertain`. “Not found” does not prove resending is safe. This conservative duplicate-attempt protection may miss notifications; it is not exactly-once delivery.

Task or runtime changes suspend the old binding. A human must first inspect through the original bridge protocol; only a human may explicitly invoke the original tools if recovery is needed. Supply the complete new binding in a mode-`0600` file with the same five fields as configuration `binding`:

```sh
node scripts/event-coordinator.js rearm /example/private/reviewer /example/private/new-binding.json
node scripts/event-coordinator.js run /example/private/reviewer
```

Rearming preserves all historical deduplication and uncertain records and rejects unresolved sends. The same five-field binding retains `cursor/baseline_cursor`. Only a validated new binding clears the cursor and sets a new observation starting point. Each instance/task/run/revision permits at most one automatic review, unaffected by changing that starting point or rearming.

Initial binding explicitly begins observing at the current snapshot tail. Once consumption begins, advance only through page `next_cursor`; persist the cursor and pending notifications together. After restart, consume every unread page from the saved cursor before sending. If the event tail advances again before a send, catch up first. A latest `awaiting_review` snapshot cannot bypass cursor checks. Missing, expired, regressed, or ahead-of-tail pages stop processing; never jump to the tail to hide a gap.

Exit status reflects the current binding's review result. Current `failed/interrupted` or any binding's unreconciled `attempted/uncertain/sent` returns nonzero. Historical terminal `failed/interrupted` remains for audit but does not fail a new binding that is `completed`.

## Failure boundaries

- Locks contain PID, Linux boot/start identity, and a random nonce. Reclamation requires confirmation that the old PID exited. Live PIDs, including reused PIDs, unknown permissions, damaged locks, or leftover `acquiring` fail closed. Never delete locks based on age. Inspect damaged locks only after confirming no instance or active/uncertain turn and saving a copy.
- State and locks reject symlinks and use private modes. Records are limited to 1000 notifications and 16 MiB, with at most 1000000 characters per result. Exhaustion stops processing; deduplication and uncertain records are never discarded automatically.
- `thread/read` and `turn/start` are not an atomic compare-and-swap. Local locks cannot prevent external-client writes. Dedicated ownership is a prerequisite; do not claim safe simultaneous Desktop editing.
- A busy target is rechecked after a local delay, with another task read before sending. The coordinator neither steers nor inserts into an existing turn. Disappearing source state or an old-run change cannot notify a new run.
- State and error outputs retain only allowed fields, excluding raw provider errors, stderr, tokens, and account configuration. Native task evidence can still contain private content. Keep it in private state directories rather than publishing whole logs.

Verification: `npm test` includes two isolated HTTP checks with real 25-second timeouts and process-crash fixtures. `npm run check` recursively checks JavaScript syntax. A real DSH/model workflow requires separate human authorization. Isolated tests cannot establish real acceptance.
