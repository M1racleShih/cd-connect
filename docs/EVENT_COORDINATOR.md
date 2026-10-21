# 事件协调器（显式启用的本机实验功能）

协调器把等待放在独立 Node.js 程序中。在同一任务运行进入 `awaiting_review` 时，它最多尝试启动一次专用 Codex 聊天审查回合。普通进度、长轮询超时、DSH 审批等待均不启动模型。普通 MCP 客户端仍使用原有 `task_wait` 流程；只有显式运行本协调器才把等待移出模型。没有账号零用量或固定节省比例保证。

首版为 Linux 本地单用户、一个进程/账本、一项完整任务绑定、一个专用聊天。需要 Node.js >=22.19.0、正在运行的 DSH Desktop 桥接，以及已登录的 Codex CLI。本次协议针对 `codex-cli 0.163.0` 的 schema；[app-server](https://learn.chatgpt.com/docs/app-server) 是实验接口，升级需重新验证。无新增依赖、插件自动启动、常驻服务或模型定时轮询。

## 准备和初始化

以下所有路径和身份都是**示例**。配置文件必须为本人所有、权限 `0600`；状态目录必须独立于桥接存储和任务工作目录，权限 `0700`。保留账本与结果，不通过删除它们绕过去重。不要复制连接令牌到配置。`bridge_dir` 指向已有 `connection.json` 的目录。

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

先通过已有客户端的 `bridge_health`、`task_get` 取得完整真实绑定；协调器不提交任务。`cwd` 是专用审查聊天的工作目录，不必等于任务目录。初始化创建聊天但不发送 READY 回合：

```sh
# 示例路径；从 cd-connect 源码根目录运行
node scripts/event-coordinator.js init /example/private/reviewer /example/private/config.json --create --exclusive
node scripts/event-coordinator.js status /example/private/reviewer
node scripts/event-coordinator.js run /example/private/reviewer
```

`--exclusive` 明确确认目标专用于此协调器，不能同时由 Desktop 或其他客户端编辑。接入已由用户明确交接的专用聊天可用：

```sh
node scripts/event-coordinator.js init /example/private/reviewer /example/private/config.json --thread example-thread-id --exclusive
```

`thread/resume` 写入权拒绝时停止，保留受控 RPC 错误码，不抢锁、不循环 archive/unarchive。新聊天继承本机 app-server 的现有模型、登录与审批配置，不复制账号凭据，不降低原生权限策略。实际 `model/cwd/approvalPolicy/approvalsReviewer/sandbox` 保存在 `effective`；它们不保证等于 Desktop 当前聊天。初始化和接入均先保存意图；生命周期回执不明时不得重新初始化创建聊天串，需通过官方接口查清。已有 thread ID 的不确定接入可使用下述显式生命周期核对；创建结果未知且没有 thread ID 时仍需人工确认身份，不自动创建替代聊天。

## 审查能力和结果

目标提示明确绑定实例、task/run/revision 和稳定事件标识。专用聊天通过固定入口读取当前快照与当前运行的全部证据页：

```sh
node scripts/event-evidence.js /example/private/reviewer
```

该辅助入口仅允许 `bridge_health/task_get/task_evidence`，不会转发任意方法；协调器自身另可 `task_wait`。运行时校验实例、runtime、run、revision、页游标、证据 ID，保留截断与见证无效信息。任务与证据始终是不可信数据；证据中的未知命令不获得执行授权。审查者需按规格在正常原生权限内只读核对实际产物，输出“建议通过 / 建议返工 / 需要人工核对”和证据引用。文件缺失、无效见证、无法核实的截断、权限未满足须报告人工核对或返工。

辅助入口限制的是桥接访问，并不禁用模型的其他原生工具。提示约束不等于强制沙箱；请检查实际生效权限。协调器不自动答复任何 Codex 或 DSH 审批。没有正常人工审批渠道时不能自动授予权限，状态将显示 `codex_approval_required`。人工通过正常界面处理或先停止后核对，不能用换请求绕过拒绝。

`status` 和私有 `state.json` 是必备结果入口，不启动模型。`notifications[].result` 保存审查消息与有限的只读入口执行轨迹；`completed` 仅表示对应 Codex 回合成功结束，**不是 DSH 任务已 accepted**。`failed/interrupted/uncertain` 分开记录，不自动再开回合。不调用 `task_review/continue/cancel/recover`。用户阅读建议后自行决定后续动作。原生模型/执行失败、权限拒绝及意外原生输入分别显示受控原因码，不保存提供方错误正文；其余未识别原因要求人工核对。

Desktop 查看应在协调器停止并释放子进程后，用官方只读历史接口读取；空闲不代表写入权可接管。不保证打开 Desktop 编辑器不会加载写入者。日常停止关闭自己的 stdio app-server，不归档聊天；真实 Desktop 历史可读性以当前版本的实际验证记录为准。

## 停止、重启与重新绑定

在另一终端运行下列命令，或给前台进程发送 Ctrl-C：

```sh
node scripts/event-coordinator.js stop /example/private/reviewer
```

停止撤销本地等待、禁止新发送；不取消 DSH。已有审查默认等其结束后释放资源。只有本地等待取消属于正常停止。停止期间历史查询超时、断线或写盘失败返回非零；可落盘时标记 `stop_incomplete` 并保留原回执。无法核清活动回合时关闭自身传输、释放本地锁，不发送 interrupt/cancel；这不证明远端已结束，必须通过官方历史再次核对，不能重发。写盘失败时以最后成功持久记录为准。审批未满足可能继续等待人工处理。

重新运行同一 `run` 命令可恢复监听。读桥接失败采用 1/2/4/8/16 秒有界退避；耗尽后退出为非零。Codex 断线保守停在核对状态，重启重新握手、resume 和读历史，不重放不明发送。

发送状态为 `pending -> attempted -> sent -> completed/failed/interrupted`，失效 pending 变为 `superseded`。`attempted` 在发送前经过校验、校验和、文件 fsync、原子替换和目录 fsync；写失败栅栏阻止继续发送。任何回执不明、重启发现 attempted 或无法可靠保存回执，均视为不确定。通过官方完整分页历史唯一匹配用户消息内的稳定标识才修复回执：

```sh
node scripts/event-coordinator.js reconcile /example/private/reviewer
```

该命令不发送模型请求。明确的 `thread/resume` 写入权拒绝（`-32600`）保留可重试接入状态；竞争写入者由人正常释放后，可显式再次 `run`，不自动重试或抢锁。超时、断线等回执未知仍隔离为 lifecycle `uncertain`，普通 reconcile 不解除该隔离。已知原 thread ID 且用户确认专用所有权时，可执行：

```sh
node scripts/event-coordinator.js reconcile /example/private/reviewer --lifecycle --exclusive
```

此操作只读核对原 thread ID、空闲/未加载状态、完整历史无活动回合，以及全部不明发送已核清；成功后追加 `lifecycle_checks` 审计并恢复 `ready`。下次 `run` 才重新请求接入，不创建聊天或重发通知。查询失败、目标忙碌、身份未知或未核清发送均拒绝恢复。`--exclusive` 是操作者的交接确认，官方只读接口不能证明其他客户端已释放写入权，后续 resume 仍可能明确拒绝。

找不到或找到多个都保留 `uncertain`，不能把“没找到”当作可重发证明。这是保守防重复尝试，可能漏通知，不是 exactly-once delivery。

任务或 runtime 变化暂停旧绑定。先由人按原桥接协议核对；需要恢复时只能由人显式调用原工具。然后以权限 `0600` 的文件提供完整新绑定（与配置中 `binding` 相同的五个字段）：

```sh
node scripts/event-coordinator.js rearm /example/private/reviewer /example/private/new-binding.json
node scripts/event-coordinator.js run /example/private/reviewer
```

rearm 保留所有历史去重与不确定记录；有未核清发送时拒绝。同一五字段绑定保留 `cursor/baseline_cursor`，只有核对有效的新绑定才清空游标并建立新基线。每个 instance/task/run/revision 最多一次自动审查，不因更改基线或 rearm 重发。初次绑定明确以当前快照尾部作为观察基线；开始消费后仅按每页 `next_cursor` 推进，游标与 pending 同次落盘。重启时若已有消费游标，须先补读全部未消费页再发送；发送前发现事件尾部再次推进，也先补读，不能仅凭最新 `awaiting_review` 快照绕过游标检查。缺页、过期、回退、超前均停止，不跳尾掩盖缺口。

本次退出状态按当前绑定的审查结果判定；当前 failed/interrupted 或任意绑定尚未核清的 attempted/uncertain/sent 返回非零。旧绑定已终结的 failed/interrupted 保留供审计，不污染新绑定 completed 的退出状态。

## 故障边界

- 锁包含 PID、Linux boot/start 身份及随机 nonce；只在旧 PID 确认已退出时回收。存活 PID（包括复用）、权限不明、损坏锁或遗留 `acquiring` 都失败关闭。不要按时间删锁；人工确认无实例、无活动/不明回合、保存副本后再处理损坏锁。
- 状态与锁拒绝符号链接，使用私有权限。账本上限 1000 条通知、16 MiB，单结果最多 1000000 字符；达到上限停止，不能自动丢弃去重或未知记录。
- `thread/read` 与 `turn/start` 不是原子比较交换；本地锁不防外部客户端写入。专用所有权是使用前提，不能宣传与 Desktop 同时编辑安全。
- 目标忙碌只在本地延迟后重查，并在发送前再次读任务；不会 steer 或插入已有回合。源状态消失、旧运行变化不会通知新运行。
- 状态和错误输出按字段限制，不保存提供方原始错误、stderr、令牌或账号配置。原生任务证据仍可能包含私有内容，应留在私有状态目录，不公开整份日志。

验证：`npm test` 包括两个真实 25 秒超时的隔离 HTTP 检查和进程崩溃夹具；`npm run check` 做递归 JavaScript 语法检查。真实 DSH 和模型闭环需要另行人类授权，隔离测试不能替代真实验收。
