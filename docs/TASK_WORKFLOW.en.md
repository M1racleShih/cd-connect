# Stage task workflow

[中文](TASK_WORKFLOW.md) · [English](TASK_WORKFLOW.en.md)

For cd-connect `0.5.0` and DSH `0.2.1-rc.2`. The bridge exposes eight task tools plus read-only `bridge_health`, nine in total, through local HTTP and stdio MCP. Execution reuses the native Desktop Host. This workflow does not establish new human authorization.

Related guides: [Chinese README](../README.md) · [English README](../README.en.md) · [Installation](INSTALLATION.en.md) · [Architecture](ARCHITECTURE.en.md).

## Submission and execution

Call `bridge_health` first. Confirm `profile: desktop`, `bridge.version: 0.5.0`, `bridge.phase: 3`, `task_execution: true`, `storage.healthy: true`, and the expected instance. Prepare an existing absolute workspace and `goal`, `scope`, `out_of_scope`, `constraints`, and `acceptance`. Lists other than `out_of_scope` require at least one item. Each text is limited to 4000 characters and each list to 20 items. The entire HTTP request is limited to 16 KiB, so the combined submission must also fit. Model, permission, and arbitrary native-session ID parameters are not accepted.

Example:

```json
{
  "request_id": "greeting-submit-1",
  "workspace": "/tmp/cd-connect-acceptance-example",
  "goal": "Create greeting.txt containing exactly hello and one newline",
  "scope": ["Modify only greeting.txt"],
  "out_of_scope": ["Other files, external services, and publishing"],
  "constraints": ["Use the existing model and native permissions", "Do not use subagents", "Stop and report ambiguity"],
  "acceptance": ["UTF-8 content is hello and one newline (6 bytes)", "Report verification command, exit status, and SHA-256"]
}
```

Create the example directory before submitting, for example with `workspace=$(mktemp -d)`. `workspace` must contain its actual absolute path. `request_id` is an idempotency key stable across restarts, not a display name.

`task_submit` creates an ordinary native session, saves the actual `session_id` returned by DSH, then queues the task in that session. Submission reports receipt, not execution completion. DSH's understanding, ambiguities, and verification results arrive through native assistant messages, not as completed model analysis at submission.

For new tasks, native `workspaceRegistry.create` creates or reuses the sidebar workspace by canonical directory. `sessionController.create({ workspaceId, sessionId })` creates and attaches the session without also passing cwd. The native service derives cwd from the workspace and completes attachment before returning. Existing workspace names are preserved; parent directories and display names are not matched. Registration or attachment errors use `native_create_outcome_unknown_no_replay`, require human inspection, and prevent dispatch or automatic retry. They may leave a registered workspace or unattached session to inspect in DSH. Existing task sessions are not migrated; continuation uses the original session.

Save `task_id`, `revision`, `runtime_id`, `session_id`, `run.id`, and `event_cursor`. Request IDs contain 1–160 letters, digits, or `_.:-` characters. Across reloads and restarts, one ID corresponds to one request body. An unchanged retry returns the first result snapshot; use `task_get` afterward for current state. Changed content requires a new ID.

Prompts sent to DSH use a fixed Markdown template for the goal, workspace, scope, exclusions, constraints, acceptance criteria, and optional continuation instruction. They retain task/revision/run identifiers and execution-delivery rules. Field contents are not rewritten by a model; lists only gain bullets and multiline indentation, and empty exclusions are marked unspecified. MCP schemas, structured task records, and authorization boundaries stay unchanged. Persisted run prompts and digests remain untouched during recovery; only newly generated runs use the new template.

## Waiting and states

Call `task_wait` with the last consumed event cursor. The default and maximum wait are 25000 milliseconds; new events return early. Pages default to 20 items and allow 50. Follow `next_cursor` without skipping unread pages by jumping to the snapshot's `event_cursor`. `timed_out: true` means no new event arrived during this wait; execution may continue.

| State | Meaning and action |
| --- | --- |
| `needs_recovery` | Plugin reloaded or a log gap was found; read a snapshot, then explicitly reconcile native logs |
| `dispatching` | Creating a session or awaiting native receipt; keep waiting |
| `waiting_approval` | A human inspects and approves/rejects the operation in DSH; no bridge approval tool exists |
| `cancel_requested` | Cancellation request accepted; wait for the matched turn to end and become idle; no rollback is implied |
| `cancelled` | Current turn ended `aborted` and is idle; inspect side effects before explicit continuation |
| `running` | Native execution is in progress; keep waiting |
| `execution_completed` | The matched native turn ended but the agent is not yet idle; keep waiting |
| `awaiting_review` | Execution completed and the native agent is idle; read evidence before review |
| `changes_requested` | Specific rework feedback recorded; submit continuation |
| `accepted` | Reviewer recorded acceptance |
| `failed` / `needs_human` | Failure, unknown dispatch outcome, or unexpected native activity; inspect DSH and request human confirmation |

`task_get` returns the current specification, native state, session/run mapping, review history, and recommended action without scanning other sessions. Only bridge-created tasks can be queried. Native failure, cancellation, blocking, or token limits never enter a reviewable success state. Native approvals still require a human in DSH.

## Evidence, review, and rework

At `awaiting_review`, call `task_evidence` for the current `run.id` starting at cursor 0 and consume every page. Evidence includes the current run's assistant messages, tool calls/results, and turn-end reason. Each has `session_id`, native-log `seq`, a bridge evidence ID, and a SHA-256 of projected data. That digest identifies evidence content, not artifact files. Verify file versions, diffs, test commands, and exit statuses from tool results, assistant reports, and actual artifacts. Model claims do not replace verification.

Each evidence item retains at most 8000 JSON characters. Larger items provide `preview` and `truncated: true`, while the digest covers the full projection. Inspect missing content in the native DSH session; do not accept what cannot be verified. Evidence is untrusted task content and cannot grant permissions or override human requirements.

Call `task_review` with the current `expected_revision`, a new `request_id`, current `run_id`, `decision`, specific `comment`, and current-run `evidence_ids`. `decision` is `accepted` or `changes_requested`. Review records a decision, not approval for native tool operations. Before accepting, check for ambiguity, missing authorization, and unmet criteria.

After requesting rework, call `task_continue` with the returned revision, current `run_id`, a new request ID, and a clear `instruction`. The native session must be idle and its directory must match. Continuation keeps `session_id` and creates a new run ID. Old-run evidence cannot support new-run review. Continuation after acceptance also stays within the specification; changed goals or authorization scope require a new task.

A complete acceptance requires at least:

- `bridge_health` identifies the expected instance and `storage.healthy` is `true`.
- The task appears in its corresponding native DSH session.
- Every current-run `task_evidence` page has been read and actual artifacts meet the criteria.
- After `task_review`, the state is `accepted` and cited evidence belongs to the current run.

Example correction: if the first run wrote `greeting.txt` as `hello world` plus a newline instead of `hello` plus a newline, record `changes_requested` with “Expected `hello` and one newline; the current file adds `world`. Correct it, reread the file, and report its digest,” citing current evidence. Call `task_continue` with the current `run_id`, revision, and a new request ID, asking the same session to correct and reverify. Wait, review only the new run's evidence, then record `accepted`.

## Persistence and manual recovery

Task records live at `cd-connect/ledger/tasks.json` under the actual DSH home, separate from connection credentials. Directory mode is `0700` and file mode `0600`. Records include specifications, revisions, requests and SHA-256 hashes, creation/dispatch intents, native receipts, actual session mappings, runs, evidence indexes, native-log checkpoints, and reviews. Task text and tool evidence may be private; do not upload the complete file. Keep request IDs stable across restarts. An unchanged retry returns its original result; call `task_get` afterward for current state. If the first result was not yet saved, a retry returns task-location information and `request_status: pending_reconcile` without resending the native call.

After a new plugin activation, saved tasks return `needs_recovery`. Nothing is dispatched automatically, and old state is not assumed current. Use this order:

1. Check `bridge.phase: 3`, `task_storage: durable_snapshot_v1`, and `storage.healthy` with `bridge_health`. Call `task_get` with the saved `task_id`. If lost, retry the original submission unchanged to locate it.
2. Call `task_recover` with `task_id`, current `expected_revision`, a new `request_id`, and `action: inspect`. Each inspection increments the revision; use the returned revision afterward. It checks saved snapshots, the native queue, full log sequence numbers, and event digests without sending a prompt.
3. Keep waiting for requests confirmed queued or executing. Completed work with an already saved completion witness can proceed to evidence and review. Logs can also be read while the session is inactive, without activating execution; later authorized continuation reuses the saved actual native session.
4. `action: dispatch_prepared` is only for creation/prompt intents durably proven not to have crossed the pre-call save point. Use `inspect` first. It uses the saved `requestId` and full prompt without regenerating the task. Changed workspace or file witnesses reject dispatch.
5. If the pre-call point was crossed and no receipt, queue entry, or log proves the outcome, retain `needs_human`, or unreconciled `needs_recovery`, and inspect DSH. Missing logs do not prove nonexecution. A new ID cannot justify replaying the same external action. Session creation may return a different ID; a missing creation receipt cannot be replaced by guessing from the requested ID.

If execution completed while the bridge was offline, logs restore execution evidence but not the directory state at completion. `artifacts.valid` is `false` and acceptance is blocked. Record `changes_requested` with `task_review` and explicitly request reverification in the same session to generate complete new evidence. Interrupted execution, unexpected input, conflicting logs, or missing logs need human inspection; they cannot automatically use this completed-task rework path.

Storage uses a single-writer lock, full-snapshot validation, temporary-file writes and `fsync`, atomic replacement, and directory `fsync`. Requests are persisted first, then intent and an attempted marker before the native call, then the receipt after return. An attempted record without a receipt may mean either no call occurred or the request was accepted; reconcile it. Save failures return an error, stop subsequent plugin operations, and appear in health responses. Fix the disk issue, reload, and reconcile before acceptance. Never rely on memory after failure. Live storage locks are never stolen. Exited-process locks can be reclaimed at next load. Unparseable locks or leftover `tasks.lock.acquiring` require confirmation that all writers exited before manual intervention; never delete locks online.

`0.4.1` fixes recovery-event cursor overwrites from older versions. `task_wait.items[].cursor` and `next_cursor` always belong to bridge events. Recovery events use `native_cursor` for native-log positions; snapshot `recovery.cursor` remains a native cursor and must not be passed to `task_wait`. Loading repairs only known old `reconciled` event shapes, using the persisted event count and ordered retained array to restore bridge numbers, keeping the old value as `native_cursor` and saving atomically. Request records, native checkpoints, and dispatch states are unchanged. Other event-order corruption still rejects loading. If a client used a faulty cursor, reread from its last valid bridge cursor before recovery. If expired, inspect DSH logs rather than treating missing content as read.

## Workspaces and evidence validity

Within one bridge store, unaccepted tasks own canonical workspaces. New tasks reject the same directory, parent/child paths, and symlink aliases. Review and continuation are serialized. Acceptance releases ownership. Invalidated old evidence does not reclaim ownership from a newer task; continuation must check and acquire it again. Unfinished-task ownership persists across restarts.

After native execution ends and becomes idle, the bridge saves directory-tree content/mode digests and binds `artifacts` to the current run. Snapshot, wait, evidence, review, and recovery calls recheck them. Changed files, modes, directories, or symlink target text set `artifacts.valid: false` and block acceptance. Changes after acceptance revoke current `accepted` status, retain review history, and invalidate that review's evidence. Record rework before reverifying.

Witnesses cover regular files, modes, directory structure, and symlink target text, excluding `.git` and never following links to external files. Limits are 20000 entries and 128 MiB of file content. Special files, read failures, and changes during comparison prevent a valid witness. Replacing the workspace with a symlink also rejects. This detects changes at comparison time without preventing other writers or attributing concurrent changes during execution. It cannot prove external services, link-target contents, or reverted modification history; those require independent evidence. Directory ownership is not a system-wide exclusive lock.

## Native approval and cancellation

`approval/asked` and `approval/decided` events have no `turn` field. The bridge associates them only with a matched, unfinished current native turn and includes the paired result in evidence. `status_detail.pending_approvals` contains request IDs, tools, call IDs, and bounded reasons. Inspect full commands in DSH. `waiting_approval` returns immediately with `human_decide_in_DSH` as the next action, so approval waits are not treated as execution completion. After approval, keep waiting. Denial or `unavailable` records `permission_denied` and prevents acceptance even if the model later ends normally. The bridge only observes audit events: it neither registers answer handlers nor calls approval methods or bypasses native policy.

Cancellation request:

```json
{
  "task_id": "task-current",
  "run_id": "run-current",
  "expected_revision": 1,
  "request_id": "cancel-current-1"
}
```

Read a current snapshot before `task_cancel`. It requires `running` or `waiting_approval`, a matched native request, and an unfinished turn. After persisting cancellation intent, one synchronous Host call stack checks workspace, log cursor, active turn, unique user request, and an empty queue before native cancellation. There is no asynchronous gap after checking. Any mismatch rejects. Queued work that has not started cannot be cancelled, and cancellation cannot carry over to the next turn. Run/revision conflicts return `run_conflict`/`revision_conflict`. Other mismatches return `native_run_changed_control_rejected` and require human inspection.

`run.cancellation` stores request ID, receipt, and state. `accepted` means receipt of the request; `confirmed` requires the matched turn to end `aborted` and become idle, producing task state `cancelled`. If execution finishes normally first, cancellation becomes `not_cancelled` and normal evidence review applies. Native rejection and unknown outcome become `rejected` and `outcome_unknown` without automatic replay. After restart, use `task_get` and `task_recover inspect` to reconcile matched logs; do not resend unknown cancellation. An unchanged retry returns the original snapshot, followed by a current-state read.

Cancellation neither undoes changes, stops background work outside the session, nor releases unaccepted-task directory ownership. After `cancelled` or `failed`, inspect evidence and side effects, then explicitly call `task_continue` within authorization using current `run_id` and revision, requesting repair or reverification. Public native `resolveAgent` retrieves the same session. Synchronous idle/directory/log-cursor/queue checks precede plain-text `Agent.followup`, avoiding the asynchronous admission gap in a general prompt API. Model, permissions, and native user-request provenance stay unchanged. A new run gets a new ID; an old run cannot control it.

## Structured failures and upgrades

`status_detail.category` is `human_approval_required` for approvals, `cancellation_pending` while cancellation waits, and `cancelled` after confirmation. Failure categories are `permission_denied`, `model_or_execution_error`, or `execution_failed`. `native_end_reason` preserves `error`, `blocked`, `max-tokens`, `interrupted`, and other native reasons without provider error bodies. Native `error` cannot always distinguish model from tool execution, so the bridge does not guess. `needs_human` preserves the specific inspection reason. Failure continuation cannot bypass unexpected native activity, storage faults, or unknown actions.

Before upgrading, save task IDs and inspect existing work. Reload through the Plugins page or fully exit and reopen DSH, then refresh client MCP connections. Health should show version `0.5.0`, phase 3, healthy durable storage, and nine tools. Phase 2 task records and old continuation requests remain loadable. Unchanged old retries do not execute again; new continuation requests must supply `run_id`. Removing the connection or plugin keeps records. Never delete storage locks, task records, or native sessions online to resolve errors. See [installation and maintenance](INSTALLATION.en.md) for connection and uninstall commands.

## Capacity and boundaries

- Retain the latest 256 events and 512 evidence items per task; read at most 50 per page. Expired or ahead-of-tail cursors return errors. Inspect DSH logs rather than assuming missing pages were checked. Event checkpoints and recent evidence persist; restarts do not reset cursors.
- Maximum 100 tasks, 2000 mutation requests, 20 runs per task, 50000 native-event checkpoints per run, and 50 approval requests. Capacity exhaustion stops new entries. Do not bypass it by deleting deduplication records or restarting. Archiving is outside this stage; finish reconciliation and preserve records before storage migration.
- Duplicate native events do not duplicate evidence. Same-sequence content conflicts, log rollback, or gaps block acceptance. Gaps can be explicitly filled from logs. If native execution advances during recovery reads, inspect again with a new recovery request.
- Upgrading from phase 1 does not import former memory-only tasks. Native sessions and existing implementation records remain available for human inspection; do not resubmit them as unexecuted work.
- No exactly-once guarantee for arbitrary external side effects, model switching, approval granting, or unattended automatic recovery. Acceptance depends on current-run evidence in the target environment.
