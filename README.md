# cd-connect

[中文](README.md) | [English](README.en.md)

我们希望用 cd-connect 连接 ChatGPT 桌面应用与 DeepSeek Harness：ChatGPT 负责目标、阶段决策和验收，DeepSeek Harness 负责执行。

项目名中的 **c** 代表 **ChatGPT**，**d** 代表 **DeepSeek Harness**。

## 项目状态

阶段 0–3 已完成。当前版本 `0.4.1` 提供持久任务、请求去重、手动恢复、原生审批展示、运行归属取消与结构化失败状态。59 项测试通过；当前 Codex 桌面会话与 DSH `0.2.1-rc.2` 已完成真实任务、人工批准/拒绝、取消确认、迟到控制，以及实际 DSH 重启后的冷日志核对、同会话继续和最终验收。恢复验收中发现的分页游标覆盖已修复，旧账本修复和当前桌面的分页复核均通过。

## 目标工作流

1. 在 ChatGPT 中说明目标、约束和验收条件。
2. ChatGPT 向 DeepSeek Harness 委派一个阶段任务。
3. DeepSeek Harness 使用自己的模型，在授权范围内规划、实现、测试和修复。
4. ChatGPT 读取执行结果与验证证据，决定通过、返工或继续下一阶段。
5. 遇到关键操作时，等待人工审批后再执行。

第一版优先接入同一台 Linux 电脑上已有的 [DSH Linux](https://github.com/M1racleShih/dsh-linux) 桌面实例，通过本地 MCP 提交任务、读取状态、审查和继续执行。当前实测客户端为 Codex 桌面会话；其他 ChatGPT 客户端与网页隧道路径尚未验证。

## 第一版范围

- 单用户，在活跃的 ChatGPT 会话中形成自动执行与审查闭环。
- DSH 在子任务内自主工作，ChatGPT 负责阶段之间的决策。
- 中断后手动恢复，从保存的任务和会话记录继续工作。
- 保留 DSH 原生工作区、工具权限与用户审批机制。
- 核对任务版本、操作归属和结果证据，避免重复执行或使用过期状态。

长期无人值守、自动唤醒 ChatGPT 和多个执行器之间的调度不在第一版范围内。

## 安装与使用

目前提供本地源码安装，尚无发布版本。需要 Node.js 22.19 或更新版本，当前适配 DSH `0.2.1-rc.2`。

```sh
npm ci --ignore-scripts
npm test
npm run check
```

在 DSH 的“插件”页面安装本仓库的绝对目录，启用 `cd-connect` bundle。也可以完全退出 DSH 后，使用 **Desktop 安装自带的** CLI 执行 `dsh plugin --profile desktop add link:/absolute/path/to/cd-connect --ignore-scripts`，然后重新打开桌面。普通 npm CLI 不允许管理 Desktop profile。现有 profile 继续由桌面管理，不能另起 CLI Host 使用它。

默认插件仅监听 `127.0.0.1:48763/mcp`，启动时生成独立随机凭据，存入实际 DSH home 下的 `cd-connect/connection.json`（权限 `0600`）。本地适配器读取这份桥接凭据，不读取 DSH 账号秘密。原生配置的 `port` 可覆盖监听端口。端口冲突、版本查询、存储校验、存储锁或状态保存失败会使插件加载失败；卸载插件时关闭监听并移除连接文件，保留任务账本。

```sh
npm run health
npm run verify:native
codex mcp add cd-connect -- /absolute/path/to/node /absolute/path/to/cd-connect/src/stdio.js
```

本地适配器是 MCP stdio 服务，转发已有桌面 Host 实际提供的工具；任务提交会创建普通原生 DSH 会话，续写复用该会话，不改变模型和权限。更新插件后需让 DSH 重新加载插件，并刷新 MCP 连接以更新工具目录。默认连接目录为 `${DSH_HOME:-~/.dsh-linux}/cd-connect`；自定义 home 可通过 MCP 配置的 `CD_CONNECT_STATE_DIR` 指向实际目录。注册后刷新桌面 MCP 连接，再让目标会话直接调用 `bridge_health`。`verify:native` 是本地 SDK 验证，不代表目标会话验收。

健康响应包含 profile 实例摘要、每次插件加载的运行编号、Host PID、Host 启动时间、运行时版本和 app-boot 代码摘要。`native_services` 仅说明服务已注册；同时检查 `bridge.phase`、`capabilities.tools` 和 `task_storage` 了解当前加载版本。

本地 MCP 的配置方式见 [官方说明](https://developers.openai.com/codex/mcp)。若目标改为 ChatGPT 网页，使用[自定义 MCP 插件](https://developers.openai.com/api/docs/guides/custom-mcp-server)与 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，隧道连接本地 stdio 适配器。该路径还需账号权限及安全输入运行密钥，本次未配置或验证。不要把本地监听公开到互联网，也不要将 `connection.json`、令牌或账号凭据提交到仓库或聊天。

要移除连接，执行 `codex mcp remove cd-connect`，并在 DSH 插件页面关闭或移除 bundle。使用 Desktop CLI 移除时先完全退出桌面，再执行 `dsh plugin --profile desktop remove cd-connect`。

## 阶段任务

按[任务处理说明](docs/TASK_WORKFLOW.md)提交完整规格，使用事件游标等待，执行结束后分页读取证据并记录审查决定。返工后在原生会话继续，再检查本轮证据。默认等待 25 秒，每页最多 50 条；执行完成和验收通过分别记录。续写与取消均携带当前 `run_id`、`expected_revision` 和新请求编号；旧运行或旧版本控制会拒绝。

任务账本保存于实际 DSH home 下的 `cd-connect/ledger/tasks.json`，文件权限为 `0600`，包含私有任务内容与相关证据。保留 `task_id` 和原始请求编号；重启后先 `task_get`，再使用当前版本与新请求编号调用 `task_recover`（`action: inspect`）核对原生日志。结果不明的动作保持待核对，不自动重放。只有能证明尚未尝试的意图才能由显式 `dispatch_prepared` 派发。重复请求返回原结果，再读快照获取最新状态。

同一桥接存储中，未验收任务占用同目录和父子目录。完成后保存文件摘要；后续变化使 `artifacts.valid` 失效，阻止用旧证据验收。桥接离线时完成的任务需要返工重新验证，以补齐完成时的文件见证。见证排除 `.git`，不跟随符号链接，不覆盖外部服务，也不能阻止或归属执行期间其他进程的写入。存储失败会停止后续操作；修复后重载并核对。完整恢复顺序、容量限制与错误处理见[任务处理说明](docs/TASK_WORKFLOW.md)。本项目不保证外部副作用恰好发生一次。

## 审批、取消与故障处理

`waiting_approval` 与 `status_detail.pending_approvals` 展示当前运行的原生审批编号、工具、调用编号及原因。请在 DSH 界面核对完整命令后批准或拒绝。桥接没有批准接口，不更改原生审批策略、模型或权限。只有原生 `allowed-once` 结果允许对应操作；拒绝或审批不可用会记录权限失败，即使模型随后声明完成也不能验收。

`task_cancel` 仅取消已匹配的活跃运行；尚未开始的排队请求、已完成运行、其他运行或队列中混有新输入时会拒绝控制。`cancel_requested` / `run.cancellation.status: accepted` 只表示取消请求被接受；匹配轮次以 `aborted` 结束并空闲后，才成为 `cancelled` / `confirmed`。若执行先完成，则仍需审查，取消标记为 `not_cancelled`。迟到的取消不会作用于后续运行。取消不回滚已经产生的修改，也不释放目录占用；检查影响后可显式同会话继续，完成验证并验收后释放目录。

超时不代表完成。`failed` 的 `status_detail` 区分权限失败、模型或执行错误与其他执行失败，同时保留原生结束原因；不返回提供方错误正文或账号配置。模型与执行异常可能共享原生 `error` 原因，桥接不会猜测更细的归因。失败或取消后，检查 DSH 与本轮证据，再使用当前运行编号和版本显式续写。`needs_human`、未知取消结果或意外原生活动需要人工核对，不能自动续写或重放。

升级前先记录任务编号并确认没有需要保留的活跃操作，再通过 DSH 插件页重载；若未加载新版，完全退出（包括托盘）后重新打开 DSH，再刷新当前客户端的 MCP 连接。检查 `bridge.version: 0.4.1`、`bridge.phase: 3`、`storage.healthy: true`、`approval_display: true`、`run_scoped_cancel: true` 和九个工具（含健康检查）。任务记录跨重启保留；恢复先读快照再 `task_recover inspect`。阶段 2 的旧续写记录可读取，原样重试仍返回原结果；新的续写必须明确提供 `run_id`。 `0.4.1` 加载时会修复旧恢复事件中的游标覆盖：`cursor` 保留桥接分页顺序，`native_cursor` 保存原生日志位置；不重放执行，也不改原生检查点或请求去重记录。

移除 MCP 或插件不删除任务账本、原生会话和任务产物。只有在完全退出 DSH、确认任务已妥善处理并备份需要的记录后，才考虑手动删除实际 DSH home 中的 `cd-connect/ledger`；删除会失去去重与恢复依据，不应作为修复重复请求的方法。完整场景与限制见[任务处理说明](docs/TASK_WORKFLOW.md)。 实机重启恢复覆盖已结束任务的日志核对、产物见证保留与同会话继续；执行中崩溃、未知回执、不可用审批答复器和模型错误通过隔离或原生组件测试覆盖，没有主动破坏现有桌面或真实模型来制造故障。

## 相关项目

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：上游执行框架。
- [DSH Linux](https://github.com/M1racleShih/dsh-linux)：第一版接入目标。
- [dsh-chatgpt-bridge](https://github.com/jiezeng2004-design/dsh-chatgpt-bridge)：相关桥接实现参考。
- [codex-bridge](https://github.com/Fanch-hui/codex-bridge)：多执行器桥接实现参考。

cd-connect 是独立项目，与 OpenAI 或 DeepSeek 不存在官方隶属或背书关系。
