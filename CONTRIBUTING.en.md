# Contributing

[中文](CONTRIBUTING.md) · [English](CONTRIBUTING.en.md)

cd-connect is an early-stage JavaScript project for one local user on Linux. The source repository is `M1racleShih/cd-connect`. A CI workflow is included; repository Actions records establish whether it ran. This guide explains development setup, validation layers, and the interfaces and behavior that must remain compatible.

Related guides: [README](README.en.md) · [Installation](docs/INSTALLATION.en.md) · [Architecture](docs/ARCHITECTURE.en.md) · [Task workflow](docs/TASK_WORKFLOW.en.md) · [Security](SECURITY.en.md) · [Agent instructions](AGENTS.en.md)

Install from the complete [M1racleShih/cd-connect](https://github.com/M1racleShih/cd-connect) source tree. No npm package is provided.

## Development environment

You need Linux, Node.js `22.19.0` or newer, and npm. Basic isolated tests require neither a DSH account nor a desktop. Connections, health checks, and native-component tests require their respective environments.

```sh
cd /absolute/path/to/cd-connect   # Example path
npm ci --ignore-scripts
npm test
npm run check
```

`--ignore-scripts` matches the current installation flow. This is pure ESM JavaScript, loaded directly by Node.js after changes, with no build, transpilation, or type-checking step. Do not introduce a TypeScript migration, build chain, new runtime dependency, or installation lifecycle script as part of an ordinary contribution.

### Entry points

| Path | Responsibility |
| --- | --- |
| `src/plugin.js` | Register the plugin inside the Desktop Host, start the listener, write the connection file |
| `src/server.js` | Loopback HTTP MCP service, Bearer authentication, tool registration, controlled error responses |
| `src/stdio.js`, `src/connection.js` | Local stdio adapter and credential reading |
| `src/protocol.js` | Tool names, Zod input schemas, agent instructions |
| `src/tasks.js` | Task state machine, request deduplication, evidence, review, cancellation, recovery |
| `src/native.js` | Narrow adapter for DSH public services and synchronous control checks |
| `src/storage.js` | Single-writer lock, checksummed snapshots, atomic persistence, compatibility with older task records |
| `src/workspace.js` | Workspace witnesses and directory-overlap checks |
| `test/` | Isolated tests, native-component tests, fault-injection helpers |
| `docs/` | Detailed user and contributor guides |

## Validation layers

Each check covers a different layer. Report which layers actually ran and which were skipped.

### 1. Isolated tests (run by default)

```sh
npm test
```

The default command uses temporary directories and simulated native services. It neither accesses a real DSH account nor changes the current desktop. It skips native-component tests that require `CD_CONNECT_DSH_SOURCE` in the layer below. Skipped tests have not passed; do not report that all tests passed.

Changes to task state, recovery, storage, workspace witnesses, or cancellation must cover both success and rejection paths. Fault-injection tests start `scripts/fault-worker.js` subprocesses and use only their own disposable paths.

### 2. Syntax check (run by default)

```sh
npm run check
```

This recursively visits `src/`, `scripts/`, and `test/` and runs `node --check` on every `.js` file, including helpers in `test/support/`. It does not inspect types. Do not describe it as type safety or complete static analysis.

### 3. Continuous integration (GitHub Actions)

`.github/workflows/ci.yml` runs these commands on Linux with Node.js `22.19.0` and `24.18.0`:

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run check:docs
```

The workflow uses read-only repository permissions. It requires no DSH account, real desktop, or target client. It excludes native-component tests and does not establish target-client acceptance. Local or candidate-directory results cannot substitute for hosted CI records. Check actual run records to establish whether the workflow ran.

### 4. Native-component tests (for adapter-boundary changes)

```sh
CD_CONNECT_DSH_SOURCE=/absolute/path/to/dsh-source \
  node --test test/native-lifecycle.test.js
```

This requires a DSH source checkout matching `0.2.1-rc.2`. Tests use isolated Cordis contexts, temporary sessions, and fixture models to verify cold startup, JSONL log reading, native approval auditing, controlled continuation, and cancellation. They **do not** start or disrupt the real desktop or replace real-task acceptance. Report a version mismatch rather than claiming a pass.

### 5. Local runtime paths (requires an active Desktop)

```sh
npm run health
npm run verify:native
```

`npm run health` reads the actual `connection.json` and calls `bridge_health`. `npm run verify:native` compares the local HTTP and stdio SDK paths, nine tools, and Host identity. Both require a loaded plugin. Tool discovery and calls from the target session still require checks in the target client.

### 6. End-to-end target-client workflow (independent acceptance)

In the target Codex desktop session, call `bridge_health` directly, submit a small task with explicit scope, wait for completion, read every current-run evidence page, inspect actual artifacts, and record a specific rework request followed by final `accepted`. This requires a real desktop, real model, and independent judgment by a human or user-authorized planning/review agent. Repository tests cannot replace it.

### Checks beyond the defaults

- Clean local-environment results do not substitute for hosted CI. Consult actual repository Actions results.
- Default tests and CI skip native-component tests requiring `CD_CONNECT_DSH_SOURCE`. Prepare matching DSH source and record that layer's results separately.
- Windows/macOS, other ChatGPT clients, and web/tunnel routes have not been verified.
- Tool discovery, a full task workflow, and independent acceptance require separate real-desktop checks in the target client. Default tests and CI do not cover them.
- `npm run health` and `npm run verify:native` require an active Desktop and a valid connection file. Neither runs in default tests or CI.

Maintainers can set `CD_CONNECT_TEST_EVIDENCE_DIR` to a private temporary directory to retain a test matrix. Generated files contain task states and local paths; do not commit or publish them.

## Change conventions

- **Keep interfaces and behavior compatible**: callers depend on tool names, input fields, error codes, status names, task-record format, default pagination, and permission behavior. Explain compatibility and migration separately when they must change; do not hide changes in a refactor.
- **Preserve runtime validation**: Zod schemas define tool-input boundaries. Storage loading also validates specifications and requests. Do not replace them with forced type assertions or looser parsing.
- **Preserve persistence order**: request registration, creation/dispatch intent, native receipts, and evidence have separate save points. For `tasks.js` or `storage.js` changes, explain recovery from a crash at each point and keep unknown outcomes from being replayed.
- **Bind controls to the current run**: continuation and cancellation require `run_id`, `expected_revision`, and checks within the same native call stack. Do not add an asynchronous gap between checking and enqueueing or let an old run control a new one.
- **Return controlled errors**: tool errors may contain only controlled codes, without provider error bodies, native stacks, account configuration, tokens, or connection-file contents.
- **Preserve witness semantics**: exclude `.git`, never follow symlinks, limit entries and bytes, and detect changes during comparison. Directory ownership is not a system-wide lock; do not present it as one.
- **Keep tests portable**: use temporary directories. Never copy real task records, session logs, or private evidence into public fixtures, or interrupt an existing desktop for tests.
- **Synchronize documentation**: behavior changes require updates to support, commands, and limits in `README.md` and `README.en.md`. Every project guide needs Chinese `.md` and English `.en.md` versions; update sections, numbers, examples, limits, and cross-links together.
- **Keep public materials free of private data**: do not reference private planning or implementation records, author-machine paths, real sessions, or private evidence. Mark example paths explicitly.

## Submission and review

1. Keep changes focused. Do not migrate languages, upgrade dependencies, or reorder unrelated files.
2. Run `npm test` and `npm run check`. Also run native-component tests for changes to native adaptation, log reading, or cancellation.
3. Update relevant Chinese and English explanations and the task protocol. Check local Markdown links and diagram rendering in both languages.
4. Report changed files, actual commands and exit statuses, skipped checks, risks, and open questions.
5. Commits, pushes, public-repository creation, and npm releases require explicit human authorization. Do not change `private: true` or the JavaScript approach on your own.

Review focuses on clear task and authorization boundaries, no replay of unknown outcomes, separation of execution and acceptance, compatibility with older task records and requests, and agreement between public documentation and actual commands. Test counts do not replace these checks.

## Bilingual documentation and diagram maintenance

Project guides come in pairs: Chinese `.md` and English `.en.md`. This applies to `README`, `AGENTS`, `CONTRIBUTING`, `SECURITY`, and guides in `docs/`. Keep a language switch at the top of each page and prefer same-language guide links in the body.

Update corresponding sections, tables, commands, input fields, versions, numbers, limits, captions, and navigation together. Preserve the official English `LICENSE` text. Tool configuration, generated images, and third-party skill files are not project guides requiring translation.

```sh
npm run docs:diagrams
npm run check:docs
```

Both diagram languages share layout and colors, with separate labels. After changing a diagram, run the first command and include source and exported images. The second checks guide pairs, heading levels, table-row counts, commands, JSON-example structure, technical identifiers and numbers, relative links and anchors, and generated diagrams against their source. It cannot judge translation accuracy: compare every section with the original and review the complete prose with `plain-docs`. See [diagram maintenance](docs/DIAGRAMS.en.md).

## Data and security

Never commit or paste connection credentials, `connection.json`, complete task records, native-session logs, account configuration, or fixtures containing private task content. Use disposable workspaces and clean up temporary data.

The bridge listens only on loopback, but it is a local tool boundary rather than a multi-tenant sandbox. Do not expose it to the internet or claim sandbox isolation. Report vulnerabilities privately to [hanqshih@gmail.com](mailto:hanqshih@gmail.com) under the [security policy](SECURITY.en.md), without publishing exploitable details in issues.

The project is licensed under MIT; see [LICENSE](LICENSE) for the full text and copyright notice. New code must be MIT-compatible. Retain original licenses and attribution for copied or adapted code, and document its source in the submission. Referencing an architecture does not establish permission. Dependencies retain their own licenses; check provenance and licensing before adding one.
