# Architecture, protocol identities, and control boundaries

[中文](ARCHITECTURE.md) · [English](ARCHITECTURE.en.md)

This describes the implementation of cd-connect `0.5.0` on DSH Desktop `0.2.1-rc.2`. See the [Chinese README](../README.md) or [English README](../README.en.md) for an overview, [installation and maintenance](INSTALLATION.en.md) for setup and troubleshooting, and [task workflow](TASK_WORKFLOW.en.md) for user-facing state, evidence, and recovery rules.

## 1. Constraints behind the design

cd-connect coordinates stage work between two independent participants: one plans and reviews; the other executes in an existing DSH environment. Prompt forwarding cannot establish correct execution, continued artifact validity, or freedom from repeated side effects on retry. The implementation therefore follows these constraints:

1. **Tasks, not messages**: submissions include the goal, scope, exclusions, constraints, and acceptance criteria. Execution and review share one specification.
2. **Separate execution and acceptance**: request receipt, native execution completion, and review acceptance are separate facts, not a single completion flag.
3. **Expect uncertainty**: disconnects, restarts, timeouts, late responses, and lost receipts must lead to an inspectable state. Unknown outcomes are never replayed automatically.
4. **Model output cannot authorize**: reuse DSH's native model, tool permissions, and human approvals. The bridge observes approvals without granting them or expanding authority.
5. **Local single user**: coordinate on the same Linux computer. Loopback binding is not multi-tenant isolation.

## 2. Runtime topology

- **Planning and review client**: currently verified as a Codex desktop session. It starts a local stdio MCP adapter and calls tools, without directly accessing internal DSH services.
- **stdio adapter process**: `src/stdio.js`, started by the client's MCP configuration. It reads the tool catalog at startup and opens a new local Host connection for each call.
- **DSH Desktop Host process**: `src/plugin.js` runs here and owns the MCP HTTP server, task manager, native adapter, and task records.
- **Native sessions and agent**: created and managed by DSH. Submission creates an ordinary native session, reused by subsequent runs.
- **Filesystem**: bridge task records, connection files, native DSH logs, and task workspaces remain separate, with different permissions and lifecycles.

The plugin starts neither a second Host nor another executor. Task state lives only in the plugin; native sessions and logs remain DSH-managed.

## 3. Component responsibilities

| Component | Responsibility | Outside its responsibility |
| --- | --- | --- |
| `src/plugin.js` | Validate `desktop` profile; collect Host identity; start listener; write connection file; own lifecycle and cleanup | Start a new Host, manage model configuration, grant approvals |
| `src/server.js` | Register MCP tools; loopback HTTP, Bearer authentication, Host/Origin checks, request-body limits; return controlled tool error codes | Store task state, execute native operations |
| `src/stdio.js` | Expose the Host's actual tools through local stdio MCP and forward calls | Own task state, read DSH accounts, cache all execution results |
| `src/connection.js` | Validate `connection.json` mode, owner, URL, and token; establish local MCP connections | Read DSH account secrets, change the connection file |
| `src/protocol.js` | Tool names, Zod input schemas, MCP annotations, agent instructions | Execute tasks, persist data |
| `src/native.js` | Narrow adapter to DSH public services: create/continue/cancel/read logs/subscribe to events; synchronous control checks | Change models, permissions, approval policy, or guess native state |
| `src/tasks.js` | Task state machine, request deduplication, workspace ownership, evidence projection, review, cancellation, recovery, snapshots | Approve native operations, replay unknown calls |
| `src/storage.js` | Single-writer lock, checksummed snapshots, atomic writes and `fsync`, capacity limits, old task-record cursor repair | Decide task semantics, repair arbitrary corruption automatically |
| `src/workspace.js` | Check directory overlaps and witness files/modes/symlinks at completion | Prevent other writers, cover external services, prove modification history |

`plugin.js` computes `instance_id` as a SHA-256 digest of `hostname` and the actual profile path; it survives plugin reloads. `runtime_id` is a UUID generated at each activation. `dsh.app_boot_sha256` hashes the actual app-boot `lib/index.js` file, not a configuration value. `native_services` in health responses establishes only service registration.

## 4. Task sequence

1. **Submit**: `task_submit` validates with Zod. The workspace must be an existing absolute directory and is resolved to a canonical path. The bridge rejects overlap with unaccepted tasks in the same store, including parent/child paths, captures a pre-submission workspace witness, and persists the request and specification before native creation.
2. **Create a native session**: `workspaceRegistry.create` registers or reuses the canonical workspace. `sessionController.create({ workspaceId, sessionId })` creates and attaches an ordinary native session. The bridge saves the actual returned `session_id`. Unknown creation outcomes require human inspection without automatic retry. A lost receipt cannot be replaced by guessing from the requested session ID.
3. **Dispatch a run**: every run gets a new `run.id` and native request ID `cd-connect:<run-id>`. A fixed Markdown template presents the full specification and optional continuation instruction without summarizing. Persisted run text and digests are never regenerated. The bridge saves the run, prompt digest, and control expectations, then the attempted marker, before native `prompt` in queue mode or controlled `continue`.
4. **Observe execution**: the plugin subscribes to native events. A user message matching the current request ID establishes `running`. It records turn starts, approval audits, assistant messages, tool calls, and results. Native-log positions and content digests become run checkpoints.
5. **Confirm execution outcome**: native `turn/end` marks execution completion; final execution state is determined after the agent becomes idle. Matched cancellation with an `aborted` turn becomes `cancelled`. Denied permission or execution failure becomes `failed`. Unresolved approval results require human inspection. Only other normal completions capture a completion witness and enter `awaiting_review`.
6. **Review**: evidence IDs must belong to the current run. `accepted` also requires a valid completion witness. Acceptance records the review decision and releases directory ownership; `changes_requested` retains ownership for continuation in the same session.
7. **Continue**: explicit continuation is allowed only after `changes_requested`, `accepted`, `cancelled`, or `failed`. It requires an idle native agent and matching workspace, increments the revision, captures a new pre-submission witness, clears the old artifact witness, and starts a new run in the same `session_id`.
8. **Cancel and recover**: cancellation targets only a matched active run; request acceptance is not confirmation. After restart, read a snapshot before explicitly reconciling native logs with `task_recover`. Neither path automatically replays unknown actions.

## 5. Identities, revisions, and cursors

These identifiers have separate meanings and must not be interchanged.

| Identifier | Meaning | Use and limits |
| --- | --- | --- |
| `instance_id` | Digest of Host name and real profile path | Bind task records to an instance; reject records for a changed profile/home |
| `runtime_id` | UUID for each plugin activation | Detect activation changes; project snapshots as `needs_recovery` afterward |
| `task_id` | Bridge-generated task ID | Query, control, recover; unique within task records |
| `revision` | Monotonically increasing per-task version | Mutations carry `expected_revision`; conflicts reject |
| `session_id` | Actual native session ID in the DSH receipt | Continue, read logs, cancel; never guessed from a requested ID |
| `run.id` | ID for each dispatched run | Bind control, evidence, and review to the current run |
| Run `request_id` | `cd-connect:<run-id>` | Native user-message `rpcId` for matching, distinct from client `request_id` |
| Native `turn` | Matched native turn number | Cancellation and event attribution; approval events have no turn field |
| Bridge event cursor | Task-event sequence number | `task_wait` pagination, separate from native cursor |
| Native cursor | Observed native-log sequence number | Detect gaps and reconcile logs, never bridge pagination |
| Evidence ID/cursor | Per-task evidence sequence | `task_evidence` pagination and `task_review` references; current run only |
| Evidence `sha256` | Digest of projected evidence JSON | Identify evidence content, not artifact files |
| Artifact-witness `sha256` | Digest of directory entries, modes, content digests, symlink target text | Detect artifact changes after completion |

Client `request_id` is also an idempotency key: 1–160 letters, digits, or `_.:-` characters. One ID must identify exactly the same request body. A duplicate returns the first result. Changed content requires a new ID; otherwise a content conflict is returned.

## 6. Persistence, capacity, and recovery

Task records are stored at `cd-connect/ledger/tasks.json` under the actual DSH home. Directories are created with `0700` and files/locks with `0600`. Snapshot format version `1` binds to `instance_id` and uses a SHA-256 checksum of canonical JSON. Writes use a same-directory temporary file, write, `fsync`, atomic replacement, and directory `fsync`. Loading revalidates checksums, specification schemas, request hashes, task/request ID uniqueness, states, event order, and capacity.

The single-writer `tasks.lock` records PID and nonce; `tasks.lock.acquiring` prevents concurrent acquisition. Only confirmed process exit, `ESRCH`, allows stale-lock reclamation. Live locks are never stolen. A save failure stops subsequent plugin operations and appears in health responses. After fixing disk or permission problems, reload and reconcile rather than accepting from in-memory state.

Limits: 100 tasks, 2000 request records, 20 runs per task, 256 task events, 512 evidence items, 50000 native-event checkpoints per run, and 50 approval requests. Each specification text is at most 4000 characters, each list at most 20 items, and an HTTP body at most 16 KiB. Event/evidence pages default to 20 items and permit 50. Expired or ahead-of-tail cursors return errors.

Startup and reload never resume execution automatically. A task not reconciled with the current `runtime_id` projects as `needs_recovery` and rejects controls. Read the task, then call `task_recover`. `inspect` reads native logs and checks directory, cursors, queue, request matching, and event digests without sending a prompt. `dispatch_prepared` is allowed only when durable records prove the intent never crossed the native-call save point and the workspace witness is unchanged. Unknown outcomes after that point, missing logs, or content conflicts require human inspection.

When a task completes while the bridge is offline, native logs can restore evidence but cannot reconstruct the directory at completion. `artifacts.valid` stays `false` and acceptance is blocked; record rework and reverify in the same session. Loading repairs the known older recovery-event cursor overwrite using the durable event total and bounded ordered array, preserving the old value as `native_cursor`. Other ordering corruption still rejects loading. Repairs do not replay execution or alter request deduplication.

## 7. Control, approval, and security boundaries

### Native control

Continuation and cancellation are more than HTTP forwarding. Within one synchronous Host call stack, `native.js` checks agent state, workspace, event cursor, queue, current turn, and unique user request. A mismatch rejects immediately, leaving no asynchronous admission gap. Continuation uses public text `followup` with user provenance and a new request ID; cancellation uses the native cancellation API. Old runs, revisions, or changed native state produce conflicts and require rereading state.

### Approval

DSH's native approval mechanism decides whether tool operations execute. The bridge subscribes only to `approval/asked` and `approval/decided` audit events and displays pending items. It has no approval tool or answer handler. These events have no `turn` field, so attribution requires an already matched, unfinished current turn. Denial or `unavailable` records a permission failure and blocks acceptance even if the model later ends normally.

### Directories and evidence

Unaccepted tasks own the same directory, parent/child paths, and symlink aliases within one bridge store. This is not an operating-system lock. Completion witnesses cover regular-file contents/modes, directory structure, and symlink target text, excluding `.git` and never following symlinks, up to 20000 entries and 128 MiB. Changes during reading/comparison, special files, or exceeded limits prevent a valid witness.

Snapshot, wait, evidence, review, and recovery reads recheck the witness. Changes invalidate `artifacts.valid` immediately and prevent acceptance with old evidence. Changes after `accepted` move the task to human inspection and invalidate evidence for the corresponding review. This cannot prevent other processes' writes or attribute concurrent modifications.

### Local authentication and boundary

HTTP binds only to `127.0.0.1`, accepts only `POST /mcp`, validates the exact Host, rejects browser Origin, requires a Bearer header with a random 32-byte token, and limits bodies to 16 KiB. Connection files must belong to the current user and have no group/other permission bits. Standard output/error contains controlled codes rather than provider error bodies, native stacks, account configuration, or tokens.

These measures protect a local single-user path, not an untrusted multi-tenant sandbox. The bridge does not guarantee exactly-once external side effects or take over DSH's model or permission systems.

## 8. State projection and failure categories

Persistent task states are `dispatching`, `running`, `execution_completed`, `awaiting_review`, `changes_requested`, `accepted`, `failed`, `needs_human`, `waiting_approval`, `cancel_requested`, and `cancelled`. `needs_recovery` is a snapshot projection when `reconciled_runtime` differs from the current `runtime_id` or the plugin is closing. It is not persisted as a new task state.

`status_detail` further distinguishes:

- `human_approval_required`: native approval pending for the current run.
- `cancellation_pending`: cancellation request accepted but unconfirmed.
- `permission_denied`: approval denied or unavailable.
- `model_or_execution_error`: native error or execution exception.
- `execution_failed`: other unsuccessful end reasons.
- `native_end_reason` preserves native reasons such as `error`, `blocked`, `max-tokens`, and `interrupted`.

A native `error` may originate in the model or execution. The bridge does not guess finer attribution. Failure, cancellation, blocking, token limits, and unexpected native activity never automatically become reviewable success.

## 9. Known limits

- Only the verified local single-user Desktop path is supported. Web, tunnels, remote execution, and other clients remain unverified.
- New tasks create or reuse DSH sidebar workspaces by canonical `workspace` directory and attach sessions through native `workspaceId`. The workspace determines cwd. Old sessions are not migrated. Membership is not a filesystem sandbox.
- No model switching, approval granting, unattended automatic recovery, task archiving, or system-wide directory lock.
- Witnesses have explicit file and capacity limits. External services, symlink target contents, concurrent writes, and reverted modifications are outside coverage.
- External side effects are not exactly-once; crashes and missing receipts can require human inspection.
- This is JavaScript. `npm run check` recursively checks syntax in `src/`, `scripts/`, and `test/`, including `test/support/`, not types. `.github/workflows/ci.yml` covers basic Linux checks and bilingual documentation checks with Node.js `22.19.0` and `24.18.0`; actual execution requires Actions records.
- Dependency installation, default tests, and recursive syntax checks were verified in clean environments with the minimum Node.js `22.19.0` and with `24.18.0`. This excludes native-component tests and real-desktop acceptance.
- Capacity exhaustion stops new work. Do not bypass it by deleting deduplication records or restarting. Archiving and migration need a human plan.

## 10. Verification mapping

| Check | Main coverage | Does not replace |
| --- | --- | --- |
| `test/tasks.test.js` | Submission, both MCP paths, pagination, evidence projection, request deduplication, controlled errors | Real-desktop and target-client independent acceptance |
| `test/controls.test.js` | Approval audit, cancellation confirmation, same-stack control, failure categories, manual recovery | Real model and approval-answer handler |
| `test/recovery.test.js` | Process crashes, restart, offline completion, storage faults, old task records/cursor migration, witness invalidation | Real DSH restart and desktop |
| `test/health.test.js` | Real MCP handshake, authentication/boundary rejection, plugin lifecycle, stdio forwarding, connection-file modes | Tool discovery in the target client |
| `test/native-lifecycle.test.js` | Native cold startup, JSONL logs, approval service, AgentLoop controls; requires DSH source | Full desktop task acceptance |
| `.github/workflows/ci.yml` | Linux dependency installation, default tests, recursive syntax checks, and bilingual documentation checks with Node.js `22.19.0`/`24.18.0` | Hosted run records, native-component tests, real-desktop and target-client independent acceptance |

Default tests skip native-component tests requiring `CD_CONNECT_DSH_SOURCE`. CI runs default tests, recursive syntax checks, and bilingual documentation checks. See [contributing](../CONTRIBUTING.en.md) for layers and exclusions.

## Explicit event coordinator

`src/coordinator/` and `scripts/event-coordinator.js` form a separate foreground program. It neither starts with the plugin nor changes the task state machine. Its private records store instance/task/run/revision/runtime bindings, consumed cursors, send intents, and turn outcomes. Bridge access is read-only. Codex runs in a separate stdio subprocess with a dedicated chat. Attempt records are persisted before sending; unknown outcomes are never replayed. Native approvals are not answered automatically, and execution completion remains separate from human acceptance. See the [event coordinator](EVENT_COORDINATOR.en.md) for CLI, read-only evidence access, ownership, and failure limits.
