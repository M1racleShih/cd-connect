# cd-connect

[中文](README.md) | [English](README.en.md)

Connect the ChatGPT desktop app to DeepSeek Harness: ChatGPT defines goals, makes decisions between stages, and reviews results; DeepSeek Harness executes the work.

The **c** stands for **ChatGPT**, and the **d** stands for **DeepSeek Harness**.

## Project status

The repository has been initialized and an initial design has been prepared. A working bridge has not been implemented, and connectivity between the real clients has not been verified. The capabilities below are targets for the first version, not available features.

## Intended workflow

1. The user describes the goal, constraints, and acceptance criteria in ChatGPT.
2. ChatGPT delegates one stage of work to DeepSeek Harness.
3. DeepSeek Harness uses its own model to plan, implement, test, and repair within the authorized scope.
4. ChatGPT reads the results and verification evidence, then accepts the work, requests changes, or starts the next stage.
5. The user approves consequential actions.

The first version targets the ChatGPT desktop app and [DSH Linux](https://github.com/M1racleShih/dsh-linux) on the same Linux computer, with an emphasis on connecting to the existing DSH desktop instance. MCP is the planned interface for task submission, status retrieval, result review, and continuation. The connection method and supported versions will be established through implementation and verification.

## First-version scope

- A single user, with an automatic execution and review loop during an active ChatGPT conversation.
- DSH works autonomously within each delegated task; ChatGPT makes decisions between stages.
- The user resumes interrupted work using verifiable task and session records.
- DSH retains its native workspaces, tool permissions, and user approvals.
- Task revisions, operation ownership, and result evidence are checked to prevent duplicate execution and decisions based on stale state.

Long-running unattended operation, automatically waking ChatGPT, and orchestration across multiple executors are outside the first-version scope.

## Installation and usage

There is no installable release yet. Connection and installation instructions will be provided after a complete workflow has been verified with the real clients.

## Related projects

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the upstream execution framework.
- [DSH Linux](https://github.com/M1racleShih/dsh-linux): the initial integration target.
- [dsh-chatgpt-bridge](https://github.com/jiezeng2004-design/dsh-chatgpt-bridge): a related bridge implementation.
- [codex-bridge](https://github.com/Fanch-hui/codex-bridge): a bridge supporting multiple executors.

cd-connect is an independent project and is not affiliated with or endorsed by OpenAI or DeepSeek.
