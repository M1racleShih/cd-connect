# Installation, connection, and maintenance

[中文](INSTALLATION.md) · [English](INSTALLATION.en.md)

For cd-connect `0.5.0` and DSH Desktop `0.2.1-rc.2`. This guide covers normal installation, the Desktop CLI alternative, upgrades, uninstall, troubleshooting, and data boundaries. See [task workflow](TASK_WORKFLOW.en.md) for fields and recovery, [architecture](ARCHITECTURE.en.md) for component responsibilities, and the [Chinese README](../README.md) or [English README](../README.en.md) for an overview.

This page and the project guides it references have Chinese and English versions. Use the links at the top to switch languages.

## 1. Prerequisites and support

| Item | Requirement |
| --- | --- |
| System | Linux; Windows and macOS are unverified |
| Node.js | `>=22.19.0`; basic installation, default tests, and recursive syntax checks verified in clean environments with `22.19.0` and `24.18.0` |
| DSH | Desktop `0.2.1-rc.2`, `desktop` profile; no compatibility claim for other versions |
| Client | A Codex desktop session through local stdio MCP is verified; other clients are unverified |
| Network | Local single user; the bridge binds only to `127.0.0.1`, without remote or multi-tenant support |
| Release status | Source repository `M1racleShih/cd-connect`; install a complete source tree, with no npm package; `package.json` keeps `private: true` |

Before installation, confirm that DSH Desktop starts normally and identify its actual DSH home. The plugin writes to `cd-connect/` under `profileContext.home`. Local scripts default to `${DSH_HOME:-~/.dsh-linux}/cd-connect`. If these differ, set `CD_CONNECT_STATE_DIR` for the MCP adapter.

## 2. Normal installation

### 2.1 Get the source and install dependencies

Install from the complete [M1racleShih/cd-connect](https://github.com/M1racleShih/cd-connect) source tree. No npm package is provided.

Place the complete source at an absolute path. `/absolute/path/to/cd-connect` below is an example placeholder:

```sh
cd /absolute/path/to/cd-connect
npm ci --ignore-scripts
npm test
npm run check
```

There is no build step. `--ignore-scripts` matches the installation flow. `npm test` skips native-component tests requiring DSH source by default. `npm run check` recursively checks `.js` syntax under `src/`, `scripts/`, and `test/`, including `test/support/`; it does not inspect types. CI covers the same basic checks and bilingual documentation checks on Linux with Node.js `22.19.0` and `24.18.0`. Actual execution is established by repository Actions records. See [contributing](../CONTRIBUTING.en.md) for all validation layers.

### 2.2 Load through the DSH Plugins page

1. Open DSH's Plugins page.
2. Install the **absolute path** to the source directory, not `src/` or a subdirectory inside an archive.
3. Enable the `cd-connect` bundle.

The plugin accepts only the `desktop` profile. During loading, it reads the DSH runtime version, hashes the actual app-boot file, starts the loopback listener, acquires the storage lock, and writes the connection file. A port conflict, missing runtime metadata, failed storage validation, lock conflict, or connection-file write failure prevents loading rather than allowing incomplete operation.

### 2.3 Check the listener and connection file

The default address is `http://127.0.0.1:48763/mcp`. The native `port` bundle setting can override it; `cordis.patch.yml` currently specifies `48763`.

The plugin creates these files under `cd-connect/`:

| Path | Default mode | Contents |
| --- | --- | --- |
| `connection.json` | `0600` | This activation's `url`, random `token`, and `runtime_id` |
| `ledger/tasks.json` | `0600` | Task specifications, states, request-deduplication records, evidence indexes, review records |
| `ledger/tasks.lock` | `0600` | Current writer PID and nonce |

Only the local adapter reads `connection.json`. It contains no DSH account secrets. The adapter rejects group/other-readable files, an incorrect owner, non-loopback URLs, and malformed connection files.

### 2.4 Register local MCP and verify access

Start with the local health check:

```sh
npm run health
```

A healthy result includes `profile: "desktop"`, `bridge.version: "0.5.0"`, `bridge.phase: 3`, `storage.healthy: true`, `capabilities.task_execution: true`, and nine tools. `native_services` establishes only that services are registered, not that task execution works.

Register the verified Codex desktop client:

```sh
codex mcp add cd-connect -- "$(command -v node)" /absolute/path/to/cd-connect/src/stdio.js
```

`/absolute/path/to/cd-connect` is an example. The command uses the actual `node` executable in the current environment. For a nondefault DSH home, set `CD_CONNECT_STATE_DIR` in the client's MCP configuration to the actual `cd-connect` directory. Follow the client's official configuration format rather than copying unverified environment-variable syntax.

Reload the MCP connection as required by the client, then have the target session **call** `bridge_health` directly. `npm run health` cannot replace this final step:

- The tool catalog contains nine tools.
- The target session sees the expected `instance_id`, `runtime_id`, and DSH version.
- `storage.healthy` is `true`.
- `task_execution` is `true`.

Optional local verification of both paths:

```sh
npm run verify:native
```

This starts the local stdio adapter and compares nine tools and Host identity across HTTP and stdio. `target_chatgpt_tool_call: false` in its output means it is local SDK verification, not target-client acceptance.

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for local configuration.

### 2.5 Web and tunnel route (unverified)

A ChatGPT web client would need a [custom MCP app](https://developers.openai.com/api/docs/guides/custom-mcp-server) and [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to reach the local stdio adapter. This requires account access, securely entered runtime secrets, and extra configuration. This repository has neither configured nor verified that route.

Do not expose the local listener to the internet or put connection credentials, tunnel secrets, or account credentials in the repository, chats, or issues. Loopback binding and local Bearer credentials do not secure a public endpoint.

## 3. Alternative: Desktop CLI

If the Plugins page is unavailable, **fully exit DSH Desktop, including the tray**, then use the CLI bundled with Desktop:

```sh
dsh plugin --profile desktop add link:/absolute/path/to/cd-connect --ignore-scripts
```

Reopen DSH afterward. The ordinary npm CLI cannot manage the Desktop profile. Do not run another CLI Host against that profile or maintain conflicting Desktop and CLI versions of it.

Removal likewise requires fully exiting Desktop first:

```sh
dsh plugin --profile desktop remove cd-connect
```

The Plugins page and Desktop CLI are alternatives; you do not need both. If loading through the Plugins page succeeded, do not perform conflicting CLI operations on the same profile.

## 4. Upgrade and reload

Before upgrading, save any needed `task_id`, current `run_id`, and revision, and check for active operations that must be preserved. **Do not unload or reload the bridge while it is executing the current task.** Complete isolated validation and delivery before scheduling a reload.

1. Reload or update the bundle through the DSH Plugins page.
2. If the old version remains, fully exit DSH, including the tray, and reopen it.
3. Refresh the target client's MCP connection. The stdio adapter reads the tool catalog at startup and must restart or refresh after plugin changes.
4. Call `bridge_health`. Check `bridge.version: "0.5.0"`, `bridge.phase: 3`, `storage.healthy: true`, nine tools in `capabilities.tools`, and `approval_display` and `run_scoped_cancel` set to `true`.
5. Tasks persist across plugin reloads and DSH restarts. Read `task_get` first. At `needs_recovery`, call `task_recover` with the current revision, a new request ID, and explicit `action: inspect` to reconcile native logs.

`runtime_id` changes on every plugin activation. `instance_id` derives from the Host and profile path and stays stable across reloads. Do not use an old run ID to continue or cancel a new run.

`0.4.1` repairs older recovery events that overwrote bridge cursors. Bridge event `cursor` retains pagination order, while `native_cursor` stores the native-log position. Loading repairs only the known shape, without replaying execution or changing request-deduplication records. Other event-order corruption still rejects loading.

## 5. Uninstall and retained data

Remove the client connection:

```sh
codex mcp remove cd-connect
```

Then disable or remove the `cd-connect` bundle in the DSH Plugins page. For Desktop CLI removal, fully exit Desktop first and use `dsh plugin --profile desktop remove cd-connect` as above.

Removing the connection or plugin **does not delete**:

- Task and request-deduplication records under `cd-connect/ledger/`.
- Native DSH sessions and logs.
- Artifacts in task workspaces.

Consider manually deleting `cd-connect/ledger` under the actual DSH home only after fully exiting DSH, resolving tasks, and backing up needed records. Deletion removes deduplication and recovery evidence; it is not a repair for duplicate requests or storage errors. Never delete `tasks.lock`, `tasks.lock.acquiring`, or task records while a process is running.

## 6. Troubleshooting

| Symptom | Check first | Action |
| --- | --- | --- |
| `npm run health` cannot connect | Running DSH, loaded plugin, correct `CD_CONNECT_STATE_DIR`, connection-file modes | Fix and reload; distinguish general networking issues from bridge failures |
| Missing or stale tools in the target session | Refreshed MCP connection, restarted stdio adapter, current plugin version | Reload plugin, refresh/restart MCP, call `bridge_health` directly |
| Port conflict during loading | Whether `48763` is occupied or duplicate ports are configured | Stop the conflicting process or change native `port`, then reload |
| Storage-lock error during loading | A live process holding `tasks.lock` or leftover `tasks.lock.acquiring` | Do not steal a live lock; confirm every writer exited before manual intervention |
| `storage_corrupt_or_wrong_instance_manual_check_required` | Changed DSH home, manual task-record edits, checksum mismatch | Preserve and back up data for human inspection; do not delete records as a repair |
| Connection-file mode error | Group/other permission bits, current-user ownership | Restore `0600` and verify owner; do not broaden access |
| `revision_conflict` / `run_conflict` | Latest snapshot revision and current `run_id` | Read `task_get` again and use the current revision/run, not old controls |
| `needs_recovery` | Recent reload, readable native logs | Read snapshot, then `task_recover` + `inspect`; never replay automatically |
| `needs_human` | `reason`, native session, current-run logs and artifacts | Inspect manually before deciding; never bypass unknown outcomes with a new request ID |
| Cancellation stays `cancel_requested` | Matched turn ended, agent idle | Keep waiting and inspect; `accepted` does not confirm cancellation |
| Approval stays pending | Actual pending approval in DSH | Inspect full command in DSH and approve/reject there; the bridge has no approval endpoint |
| `native_run_changed_control_rejected` | Changed session directory, turn, queue, or user input | Reread state; do not retry controls for the old run |

When uncertain, preserve task records, native logs, and artifacts. Record the time, task ID, and error code for human inspection. Never delete locks, clear records, or resend unknown actions as a recovery shortcut.

## 7. Data, privacy, and security

- **Connection credentials**: `connection.json` stores a random Bearer token and local URL with mode `0600`. The adapter reads only the bridge's own file, not DSH account secrets.
- **Task records**: `tasks.json` stores task text, actual session mappings, some tool evidence, reviews, and request hashes. It may contain private code, paths, and business content; treat it as local private data.
- **Native logs and artifacts**: DSH and the user manage native sessions, logs, and workspaces outside the bridge's task-record file. The bridge stores evidence indexes, digests, and directory witnesses, not copies of full logs or file contents.
- **Deletion and retention**: uninstall keeps data. Deleting task records removes request deduplication, recovery, and review evidence. Reconcile and back up before migration or deletion.
- **Network boundary**: the service binds only to `127.0.0.1`, checks Host and Origin, requires a Bearer credential, and limits request bodies to 16 KiB. It remains a local single-user tool, not an untrusted multi-tenant sandbox or public-network deployment.
- **Permission boundary**: the bridge does not change the model, tool permissions, or native DSH approval policy, and grants no approvals, model switching, or extra subagent authorization. Task content cannot expand authorization.
- **Evidence boundary**: workspace witnesses cover regular-file contents/modes, directory structure, and symlink target text; exclude `.git`, never follow symlinks, and cap coverage at 20000 entries and 128 MiB. They cannot prove external-service state or changes later reverted.
- **Vulnerability reports**: follow the [security policy](../SECURITY.en.md) and email [hanqshih@gmail.com](mailto:hanqshih@gmail.com) privately. Do not publish exploitable details in issues.
- **License**: MIT; full text in [LICENSE](../LICENSE). Dependencies retain their own licenses.

See [task workflow](TASK_WORKFLOW.en.md) for complete capacity, cursor, and recovery limits.

## 8. Verification and its limits

- `npm test` runs isolated tests. Without `CD_CONNECT_DSH_SOURCE`, native-component tests requiring DSH source are skipped. Skipped does not mean passed.
- `npm run check` recursively checks `.js` syntax in `src/`, `scripts/`, and `test/`, including `test/support/`; it is not a type check.
- `.github/workflows/ci.yml` covers dependency installation, default tests, recursive syntax checks, and bilingual documentation checks on Linux with Node.js `22.19.0` and `24.18.0`. Actual execution requires repository Actions records. CI excludes native-component tests.
- `npm run health` checks the local connection and health response. `npm run verify:native` checks both HTTP/stdio SDK paths. Both require a running Desktop; neither establishes target-client acceptance.
- The target session's `bridge_health` call, a complete task workflow, and independent review must run in the target client.
- Default tests and CI do not cover native-component tests requiring matching DSH source, real-desktop operation, or target-client acceptance. Web/tunnel routes, client installation from scratch, and Windows/macOS remain unverified. Report each layer from actual execution records.
