# AGENTS.md

[中文](AGENTS.md) · [English](AGENTS.en.md)

This file is for coding agents working in this repository. It records project-specific facts and constraints; it does not replace human authorization. Project documentation grants no permission to commit, publish, send data externally, use subagents, or expand tool permissions.

## Project

cd-connect is a Cordis plugin running inside an existing DSH Desktop Host, plus a local MCP stdio adapter. A planning client submits stage tasks. DSH executes using native sessions, models, tool permissions, and human approvals. A reviewer accepts or requests rework based on evidence from the current run.

- Version `0.5.0`, Linux, local single user, DSH `0.2.1-rc.2`, `desktop` profile only.
- Pure ESM JavaScript, with no build step. Keep `package.json` set to `"private": true`; there is no npm release.
- Source repository: `M1racleShih/cd-connect`. npm publishing remains disabled. A public repository does not authorize later pushes or package releases.
- Entry points: `src/plugin.js` (Host plugin), `src/stdio.js` (local adapter), `src/server.js` (loopback MCP), `src/tasks.js` (task state machine).
- Public explanations, contribution, security, and agent guides, and all guides in `docs/` have Chinese `.md` and English `.en.md` versions. Keep commands, supported environments, and limits synchronized.

## Common commands

| Purpose | Command | Scope |
| --- | --- | --- |
| Install dependencies | `npm ci --ignore-scripts` | No build step; installation uses `--ignore-scripts` |
| Isolated tests | `npm test` | Skips native-component tests requiring `CD_CONNECT_DSH_SOURCE` by default |
| Syntax check | `npm run check` | Recursively runs `node --check` on `.js` files in `src/`, `scripts/`, and `test/`, including `test/support/`; not a type check |
| Bilingual documentation check | `npm run check:docs` | Checks document pairs, structure, technical identifiers, numbers, examples, links, and generated diagrams; review translation meaning section by section |
| Redraw README diagrams | `npm run docs:diagrams` | Generates Chinese and English HTML/SVG from one layout without connecting to DSH |
| CI | `.github/workflows/ci.yml` | Dependency installation, default tests, recursive syntax checks, and bilingual documentation checks on Linux with Node `22.19.0` and `24.18.0`; excludes native-component tests; actual hosted execution requires run records |
| Native-component tests | `CD_CONNECT_DSH_SOURCE=/absolute/path/to/dsh-source node --test test/native-lifecycle.test.js` | Requires matching DSH source; isolated fixtures do not constitute real-desktop acceptance |
| Local bridge health | `npm run health` | Requires a running Desktop and valid `connection.json`; a local SDK call |
| HTTP/stdio verification | `npm run verify:native` | Checks both local SDK paths and nine tools; not target-client acceptance |

The declared Node.js minimum is `22.19.0`. Dependency installation, default tests, and recursive syntax checks have been verified in clean environments with `22.19.0` and `24.18.0`. Native-component tests, hosted CI, and real-desktop acceptance run separately. Never claim unperformed checks passed.

## Invariants

- Keep native model, permission, and approval policies. The bridge has no approval endpoint; it only observes and displays native approval results.
- Separate execution completion from acceptance. Never accept automatically or treat `awaiting_review`, model claims, or test output as reviewer acceptance.
- Never replay an unknown outcome. After restarts, timeouts, missing receipts, or uncertain cancellation, read the snapshot and reconcile native logs with `task_recover`. `dispatch_prepared` may send only an intent durably proven never attempted.
- Bind continuation and cancellation to the current `run_id`, `expected_revision`, and synchronous native control checks. Reject stale runs, revisions, or changed native state.
- Preserve Zod runtime validation, durable request deduplication, checksummed snapshots, single-writer locks, atomic persistence, and compatibility with older task records. Do not replace them with type assertions or broader inputs.
- Preserve workspace-witness semantics: regular-file contents/modes, directory structure, and symlink target text; exclude `.git`, never follow symlinks, and cap coverage at 20000 entries/128 MiB. Directory ownership applies only within one bridge store, not system-wide.
- Request IDs remain stable across restarts. One ID identifies one request body. Use a new ID for changed content; retries cannot bypass a content conflict.
- Tool errors must not disclose provider error bodies, native stacks, account configuration, tokens, or private credentials. Return existing structured error codes.

## Change conventions

- Maintain JavaScript only. Do not migrate to TypeScript, introduce a build, or add runtime dependencies. Prefer minimal behavior fixes.
- Behavior changes require success and failure tests and updates to affected `README.md`, `README.en.md`, and `docs/` files. Keep every project guide bilingual, with synchronized sections, supported environments, commands, numbers, limits, and cross-links.
- Public documentation must not reference private planning or implementation records, author-machine paths, real sessions, private task records, or private evidence. Mark example paths as examples.
- Preserve existing workspace changes. Do not remove untracked files or rewrite Git history. Commits, pushes, public-repository creation, and package publishing require explicit human authorization.
- Never unload or reload the bridge while it is executing a task. Validate plugin changes in isolation first, then follow the upgrade procedure in [installation and maintenance](docs/INSTALLATION.en.md).
- License: MIT, full text in `LICENSE`, copyright 2026 Han-Qing Shi. Keep `package.json` set to `"private": true`. Do not rewrite license notices or claim release authorization.

## Read by task

| Task | References |
| --- | --- |
| Initial development, verification selection, contributions | [`CONTRIBUTING.en.md`](CONTRIBUTING.en.md) |
| Install, connect, upgrade, uninstall, troubleshoot | [`docs/INSTALLATION.en.md`](docs/INSTALLATION.en.md), [`docs/ARCHITECTURE.en.md`](docs/ARCHITECTURE.en.md) |
| Credentials, private data, retained data, vulnerability reports | [`SECURITY.en.md`](SECURITY.en.md), [`docs/INSTALLATION.en.md`](docs/INSTALLATION.en.md) |
| Licensing and dependency provenance | [`LICENSE`](LICENSE), [`CONTRIBUTING.en.md`](CONTRIBUTING.en.md) |
| Task state, evidence, recovery, continuation, cancellation | [`docs/TASK_WORKFLOW.en.md`](docs/TASK_WORKFLOW.en.md), [`docs/ARCHITECTURE.en.md`](docs/ARCHITECTURE.en.md), `test/controls.test.js`, `test/recovery.test.js` |
| Tool schema, status, error semantics | [`src/protocol.js`](src/protocol.js), [`docs/TASK_WORKFLOW.en.md`](docs/TASK_WORKFLOW.en.md) |
| Bilingual public explanations | [`README.md`](README.md), [`README.en.md`](README.en.md) |
| Design rationale and component boundaries | [`README.en.md`](README.en.md#why-this-design), [`docs/ARCHITECTURE.en.md`](docs/ARCHITECTURE.en.md) |

## Delivery

Report your understanding of the goal, changed files and their summaries or versions, verification commands actually run and their exit statuses, skipped or uncovered checks, remaining risks, and open questions. When citing existing task records or test output, state the evidence's scope. Test totals or historical acceptance do not substitute for this run's pass/skip results, and do not imply reviewer acceptance.
