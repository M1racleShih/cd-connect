# cd-connect

[中文](README.md) | [English](README.en.md)

We are building cd-connect to connect the ChatGPT desktop app to DeepSeek Harness: ChatGPT defines goals, makes decisions between stages, and reviews results; DeepSeek Harness executes the work.

The **c** stands for **ChatGPT**, and the **d** stands for **DeepSeek Harness**.

## Project status

Phases 0–3 are complete. Version `0.4.1` provides durable tasks, request deduplication, manual recovery, native approval display, run-scoped cancellation and structured failure states. All 59 tests pass. The current Codex desktop conversation and DSH `0.2.1-rc.2` passed real execution, human approval/rejection, cancellation confirmation, stale controls, and cold-log reconciliation followed by same-session continuation and acceptance after an actual DSH restart. The recovery paging cursor collision found during acceptance is fixed; old-ledger repair and live paging verification both passed.

## Intended workflow

1. Describe the goal, constraints, and acceptance criteria in ChatGPT.
2. ChatGPT delegates one stage of work to DeepSeek Harness.
3. DeepSeek Harness uses its own model to plan, implement, test, and repair within the authorized scope.
4. ChatGPT reads the results and verification evidence, then accepts the work, requests changes, or starts the next stage.
5. Consequential actions wait for human approval before execution.

The first version connects to the existing [DSH Linux](https://github.com/M1racleShih/dsh-linux) desktop instance on the same Linux computer through local MCP task submission, status, review and continuation tools. Live acceptance used the current Codex desktop conversation; other ChatGPT clients and the web tunnel route remain unverified.

## First-version scope

- A single user, with an automatic execution and review loop during an active ChatGPT conversation.
- DSH works autonomously within each delegated task; ChatGPT makes decisions between stages.
- Interrupted work resumes manually from saved task and session records.
- DSH retains its native workspaces, tool permissions, and user approvals.
- Task revisions, operation ownership, and result evidence are checked to prevent duplicate execution and decisions based on stale state.

Long-running unattended operation, automatically waking ChatGPT, and orchestration across multiple executors are outside the first-version scope.

## Installation and usage

Local source installation is available; there is no published release. Use Node.js 22.19 or newer. The current DSH compatibility target is `0.2.1-rc.2`.

```sh
npm ci --ignore-scripts
npm test
npm run check
```

Install this repository's absolute directory through DSH's Plugins page and enable the `cd-connect` bundle. Alternatively, fully quit DSH, use the **Desktop installation's** CLI to run `dsh plugin --profile desktop add link:/absolute/path/to/cd-connect --ignore-scripts`, and reopen Desktop. The ordinary npm CLI cannot manage the Desktop profile. Desktop retains profile ownership; never start a second CLI Host against it.

The plugin listens only on `127.0.0.1:48763/mcp`. Each activation generates an independent random credential in `cd-connect/connection.json` under the actual DSH home, with mode `0600`. The adapter reads only bridge-owned credentials, not DSH account secrets. The native plugin's `port` option overrides the port. Port conflicts, unavailable runtime metadata, invalid storage, storage ownership conflicts, or discovery write failures fail plugin loading. Disposal removes discovery and closes the listener while retaining the task ledger.

```sh
npm run health
npm run verify:native
codex mcp add cd-connect -- /absolute/path/to/node /absolute/path/to/cd-connect/src/stdio.js
```

The MCP stdio adapter forwards the tools advertised by the existing desktop Host. Task submission creates an ordinary native DSH session, and continuation reuses it with the existing model and permissions. Reload the DSH plugin after updates and refresh the MCP connection to discover the new tools. Its default state directory is `${DSH_HOME:-~/.dsh-linux}/cd-connect`; set `CD_CONNECT_STATE_DIR` in MCP configuration for a custom home. Refresh desktop MCP connections after registration, then ask the target conversation to call `bridge_health` directly. `verify:native` is a local SDK check, not target-conversation acceptance.

Health reports a profile fingerprint, a new ID per plugin activation, Host PID and start time, runtime version and app-boot artifact digest. `native_services` reports registered services only; also check `bridge.phase`, `capabilities.tools` and `task_storage` for the loaded version.

See the [official local MCP configuration guide](https://developers.openai.com/codex/mcp). For ChatGPT web, use a [custom MCP plugin](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) targeting the local stdio adapter. That route needs account permissions and secure runtime-key entry and was not configured or verified here. Do not expose the listener publicly or put connection files, tokens or account credentials in the repository or chat.

To remove the connection, run `codex mcp remove cd-connect` and disable or remove the bundle in DSH's Plugins page. To remove it through the Desktop CLI, fully quit Desktop before running `dsh plugin --profile desktop remove cd-connect`.

## Stage tasks

Follow the [task workflow guide](docs/TASK_WORKFLOW.md) (Chinese): submit a full authorized specification, wait using event cursors, page through current-run evidence, and record a review. Continue concrete rework in the same native session, then inspect new evidence. Waits default to 25 seconds; pages contain at most 50 items. Execution completion and reviewer acceptance are separate states. Continuation and cancellation require the current `run_id`, `expected_revision` and a new request ID; stale run or revision controls are rejected.

The private ledger lives at `cd-connect/ledger/tasks.json` under the actual DSH home, with mode `0600`. Retain the task ID and original request identity. After restart, read `task_get`, then call `task_recover` with the current revision, a new request ID and `action: inspect`. Uncertain native actions remain unresolved and are never automatically replayed. Explicit `dispatch_prepared` only sends intents durably proven unattempted. Retries return their original result; read a fresh snapshot afterward.

Unaccepted tasks exclude the same workspace and overlapping parent/child paths within one bridge store. Artifact witnesses captured at completion are rechecked before review; changes invalidate `artifacts.valid` and prevent acceptance based on old evidence. Tasks completed while the bridge was offline require rework to obtain a fresh completion witness. Witnesses exclude `.git`, do not follow symlinks or cover external services, and cannot prevent or attribute concurrent writes by other processes. Storage failure fences further operations until repair, reload and reconciliation. See the [workflow guide](docs/TASK_WORKFLOW.md) for recovery ordering, limits and errors. Exactly-once external side effects are not guaranteed.

## Approvals, cancellation and failures

`waiting_approval` and `status_detail.pending_approvals` expose native approval IDs, tools, call IDs and reasons for the current run. Review the full command and approve or reject it in DSH. The bridge has no approval-grant tool and does not change native approval policy, models or permissions. Only native `allowed-once` permits the requested operation. Rejection or an unavailable answerer records a permission failure and prevents acceptance even if the model later claims completion.

`task_cancel` targets only a matched active run. Queued requests that have not started, completed runs, replacement runs, and sessions with additional queued input reject control. `cancel_requested` / `run.cancellation.status: accepted` acknowledges the request; only an `aborted` ending of that matched turn followed by idle confirms `cancelled` / `confirmed`. If execution wins the race, it still requires review and the cancellation becomes `not_cancelled`. A late cancel cannot stop later work. Cancellation does not roll back effects or release workspace ownership. Inspect effects before explicitly continuing in the same session; successful verification and acceptance release the workspace.

A wait timeout is not completion. For `failed`, `status_detail` distinguishes permission denial, model or execution errors, and other execution failures, with the native ending reason. Provider error bodies and account configuration are excluded. Native `error` can represent either model or execution failure; the bridge does not guess a finer cause. Inspect DSH and run evidence before explicitly continuing a failed or cancelled run with its current ID and revision. `needs_human`, uncertain cancellation outcomes and unexpected native activity require human reconciliation rather than automatic continuation or replay.

Before upgrading, save task IDs and check for active operations that need preservation. Reload through the DSH Plugins page; if the old version remains loaded, fully quit DSH (including the tray), reopen it and refresh the current client's MCP connection. Check `bridge.version: 0.4.1`, `bridge.phase: 3`, `storage.healthy: true`, `approval_display: true`, `run_scoped_cancel: true` and nine tools including health. After restart, read a snapshot before `task_recover inspect`. Phase 2 continuation records remain readable and unchanged legacy retries retain their original results; new continuations require `run_id`. On load, `0.4.1` repairs the old recovery-event cursor collision: `cursor` retains bridge paging order and `native_cursor` retains the native log position. It does not replay work or change native checkpoints or deduplication records.

Removing MCP or the plugin retains the ledger, native sessions and task artifacts. Only consider manually deleting `cd-connect/ledger` under the actual DSH home after fully quitting DSH, resolving tasks and backing up needed records. Deletion removes deduplication and recovery evidence; it is not a fix for repeated requests. See the [workflow guide](docs/TASK_WORKFLOW.md) (Chinese) for detailed scenarios and limits. Live restart recovery covers completed tasks, retained artifact witnesses, log reconciliation and same-session continuation. In-flight crashes, unknown receipts, unavailable approval answerers and model errors are covered by isolated or native-component tests; the existing desktop and real model were not deliberately disrupted to manufacture failures.

## Related projects

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the upstream execution framework.
- [DSH Linux](https://github.com/M1racleShih/dsh-linux): the initial integration target.
- [dsh-chatgpt-bridge](https://github.com/jiezeng2004-design/dsh-chatgpt-bridge): a related bridge implementation.
- [codex-bridge](https://github.com/Fanch-hui/codex-bridge): a bridge supporting multiple executors.

cd-connect is an independent project and is not affiliated with or endorsed by OpenAI or DeepSeek.
