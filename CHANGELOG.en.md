# Changelog

[中文](CHANGELOG.md) · [English](CHANGELOG.en.md)

This page records feature changes and upgrade considerations. See [installation and maintenance](docs/INSTALLATION.en.md) for setup and [task workflow](docs/TASK_WORKFLOW.en.md) for fields and recovery rules.

## 0.5.0 — 2026-10-21

### Waiting and review

- Add an explicitly started local event coordinator that calls `task_wait` in a separate Node.js program. Ordinary progress, long-poll timeouts, and DSH approval waits start no model turns.
- When the bound instance, task, run, and revision reach `awaiting_review`, attempt at most one wake-up of a dedicated Codex review chat. Results are recommendations with evidence references, without automatically accepting, continuing, cancelling, or recovering tasks.
- Provide `init/run/status/stop/rearm/reconcile` commands, durable request records, consumed cursors, and a save point before sending. Uncertain sends require official-history reconciliation without automatic replay. Rearming the same binding preserves its cursor; unresolved reviews on stop return nonzero.
- The fixed evidence helper permits only `bridge_health/task_get/task_evidence`; the coordinator can also wait for events. Native models, tool permissions, and human approvals remain unchanged. Dedicated chat ownership is required. Experimental app-server use does not guarantee zero account usage or exactly-once external side effects.

### Native sessions and task descriptions

- Create or reuse DSH sidebar workspaces by canonical task directory, then create and attach native sessions through `workspaceId`. Preserve existing workspace names. Attachment failure stops dispatch for human inspection.
- Present the complete goal, workspace, scope, exclusions, constraints, acceptance criteria, and continuation instruction through a fixed Markdown template. Persisted run prompts and digests are not regenerated.
- Add success and rejection coverage for workspace membership, prompt fidelity, event waits, recovery, stopping, and error handling.
- Synchronize integration-test progress with the registered server wait instead of startup timing. Retain two real 25000-millisecond timeouts and the zero-model-start assertion.

### Documentation and appearance

- Rewrite both READMEs. Project guides have Chinese `.md` and English `.en.md` versions, with synchronized commands, numbers, limits, and cross-links.
- Add an original centered logo and bilingual architecture diagrams sharing one layout. Retain diagram generation and color configuration.
- Add `npm run docs:diagrams` and `npm run check:docs`. CI runs basic checks and bilingual documentation checks with Node.js `22.19.0` and `24.18.0`.
- Documentation checks cover paired files, sections, examples, technical identifiers, numbers, links, and stale generated images. Translation meaning and visual layout still require human review.

### Upgrade and compatibility

- Synchronize package, MCP server, and coordinator handshake versions at `0.5.0`. Keep Linux local single-user support, DSH Desktop `0.2.1-rc.2`, the `desktop` profile, nine MCP tools, and phase 3.
- `task_wait` still defaults to and allows at most 25000 milliseconds. Event cursors, evidence pagination, and task review rules are unchanged. Recovery-cursor compatibility introduced in `0.4.1` remains.
- Resolve active work before reloading the plugin and refreshing client MCP connections. Read old-task snapshots first and explicitly reconcile native logs where needed. Old coordinator runtime bindings require human inspection before rearming.
- Keep `package.json` set to `private: true`, with no added runtime dependencies or npm package. The experimental coordinator remains explicitly enabled; it neither starts with the plugin nor installs a background service.

### Verification scope

Default tests use isolated fixtures. Native-component tests require matching DSH source selected through `CD_CONNECT_DSH_SOURCE`. CI excludes native-component tests and real-desktop acceptance. Report each layer from its actual run records. Model claims or passing tests do not establish task-review acceptance.
