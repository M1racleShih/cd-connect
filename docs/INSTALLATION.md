# 安装、连接与维护

[中文](INSTALLATION.md) · [English](INSTALLATION.en.md)

适用 cd-connect `0.5.0` 与 DSH Desktop `0.2.1-rc.2`。本文覆盖正常安装、Desktop CLI 替代路径、升级、卸载、故障恢复与数据边界。任务字段和恢复协议见[任务处理说明](TASK_WORKFLOW.md)，组件职责见[架构说明](ARCHITECTURE.md)，功能概览见[中文 README](../README.md)或[English README](../README.en.md)。

本页及所引用的项目指南均提供中英文版本；可通过页首链接切换语言。

## 1. 前提与支持范围

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux；未验证 Windows 或 macOS |
| Node.js | `>=22.19.0`；已在干净环境用 `22.19.0`、`24.18.0` 验证基础安装、默认测试与递归语法检查 |
| DSH | Desktop `0.2.1-rc.2`，`desktop` profile；其他版本未声明兼容 |
| 客户端 | 已实测 Codex 桌面会话通过本地 stdio MCP；其他客户端未验证 |
| 网络 | 本机单用户；桥接只监听 `127.0.0.1`，不支持远程或多租户 |
| 发布状态 | 源码仓库为 `M1racleShih/cd-connect`；不提供 npm 包，从完整源码目录安装，`package.json` 保持 `private: true` |

安装前确认 DSH 桌面可以正常启动，且你知道当前实际使用的 DSH home。插件写入的是 `profileContext.home` 下的 `cd-connect/`；本地脚本默认查找 `${DSH_HOME:-~/.dsh-linux}/cd-connect`。两者不一致时，需要给 MCP 适配器设置 `CD_CONNECT_STATE_DIR`。

## 2. 正常安装路径

### 2.1 获取源码并安装依赖

源码仓库为 [M1racleShih/cd-connect](https://github.com/M1racleShih/cd-connect)。使用完整源码目录安装，不提供 npm 包。

将完整源码放在任意绝对目录。下面的 `/absolute/path/to/cd-connect` 是示例占位：

```sh
cd /absolute/path/to/cd-connect
npm ci --ignore-scripts
npm test
npm run check
```

项目没有构建步骤，`--ignore-scripts` 与现有安装流程一致。`npm test` 默认会跳过需要 DSH 源码的原生组件测试；`npm run check` 递归检查 `src/`、`scripts/`、`test/`（含 `test/support/`）中的 `.js` 文件，不解析类型。CI 在 Linux 上覆盖 Node.js `22.19.0` 与 `24.18.0` 的同样基础检查，并运行双语文档检查；执行结果以仓库 Actions 记录为准。需要完整验证分层时见[贡献指南](../CONTRIBUTING.md)。

### 2.2 通过 DSH 插件页加载

1. 打开 DSH 的“插件”页面。
2. 安装上述源码目录的**绝对路径**，而不是 `src/` 或压缩包内的子目录。
3. 启用 `cd-connect` bundle。

插件只接受 `desktop` profile。加载时会确认可以读取 DSH 运行时版本、计算实际 app-boot 文件的摘要，启动回环监听，获取存储锁并写入连接文件。端口冲突、运行时元数据缺失、存储校验失败、存储锁冲突或连接文件写入失败都会使插件加载失败，而不会带着不完整状态继续运行。

### 2.3 确认监听与连接文件

默认地址为 `http://127.0.0.1:48763/mcp`。bundle 配置中的原生 `port` 可以覆盖端口；`cordis.patch.yml` 当前写入默认值 `48763`。

插件在 `cd-connect/` 下创建：

| 路径 | 默认权限 | 内容 |
| --- | --- | --- |
| `connection.json` | `0600` | 本次激活的 `url`、随机 `token`、`runtime_id` |
| `ledger/tasks.json` | `0600` | 任务规格、状态、请求去重记录、证据索引与审查记录 |
| `ledger/tasks.lock` | `0600` | 当前写入者 PID 与 nonce |

`connection.json` 只供本地适配器读取；它不包含 DSH 账号秘密。适配器会拒绝组/其他用户可读、所有者不匹配、非回环 URL 或格式错误的连接文件。

### 2.4 注册本地 MCP 并验收

先做本地健康检查：

```sh
npm run health
```

正常结果应包含 `profile: "desktop"`、`bridge.version: "0.5.0"`、`bridge.phase: 3`、`storage.healthy: true`、`capabilities.task_execution: true` 和九个工具。`native_services` 只表示服务已注册，不能单独证明任务路径可用。

再注册已实测的 Codex 桌面客户端：

```sh
codex mcp add cd-connect -- "$(command -v node)" /absolute/path/to/cd-connect/src/stdio.js
```

其中 `/absolute/path/to/cd-connect` 是示例；`node` 使用当前环境中的真实可执行文件。若 DSH home 不是默认值，在客户端的 MCP 配置中设置 `CD_CONNECT_STATE_DIR`，指向实际 `cd-connect` 目录。配置格式以客户端官方说明为准，不要照抄未经验证的环境变量语法。

注册后按客户端方式重新加载 MCP 连接，再让目标会话**直接调用** `bridge_health`。这最后一步不能由 `npm run health` 代替：

- 工具目录应包含九个工具；
- 目标会话能看到预期 `instance_id`、`runtime_id` 和 DSH 版本；
- `storage.healthy` 为 `true`；
- 任务路径的 `task_execution` 为 `true`。

可选的本地双路径检查：

```sh
npm run verify:native
```

它会启动本地 stdio 适配器，对比 HTTP 与 stdio 的九个工具和同一 Host 身份。输出中的 `target_chatgpt_tool_call: false` 表示这只是本地 SDK 验证，不是目标客户端验收。

Codex 本地 MCP 配置可参考[官方说明](https://developers.openai.com/codex/mcp)。

### 2.5 网页与隧道路径（未验证）

若目标改为 ChatGPT 网页，需要[自定义 MCP 插件](https://developers.openai.com/api/docs/guides/custom-mcp-server)与 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)，由隧道连接本地 stdio 适配器。该路径还需要账号权限、安全输入运行密钥和额外配置；本仓库没有配置或验证它。

不要把本地监听公开到互联网，也不要把连接凭据、隧道密钥或账号凭据写入仓库、聊天或 issue。回环监听和本地 Bearer 凭据不是公网安全方案。

## 3. 替代路径：Desktop CLI

如果无法使用插件页，可以在**完全退出 DSH 桌面（包括托盘）**后，使用 Desktop 安装自带的 CLI：

```sh
dsh plugin --profile desktop add link:/absolute/path/to/cd-connect --ignore-scripts
```

然后重新打开 DSH。普通 npm CLI 不允许管理 Desktop profile；不要让另一个 CLI Host 使用这个 profile，也不要同时维护一个“桌面版”和一个“CLI 版”的同一 profile。

对应移除命令同样要求先完全退出桌面：

```sh
dsh plugin --profile desktop remove cd-connect
```

插件页和 Desktop CLI 是两条替代路径，不需要同时执行。若插件页已经加载成功，不要再用 CLI 对同一 profile 做冲突操作。

## 4. 升级与重载

升级前先记录需要保留的 `task_id`、当前 `run_id` 和版本，并确认没有需要保留的活跃操作。**不要在桥接正通过本任务执行时卸载或重载它**；先完成隔离验证与交付，再安排重载。

1. 在 DSH 插件页重新加载或更新 bundle。
2. 若仍显示旧版本，完全退出 DSH（包括托盘）后重新打开。
3. 刷新目标客户端的 MCP 连接。stdio 适配器在启动时读取工具目录，插件更新后必须重启/刷新适配器。
4. 调用 `bridge_health`，确认 `bridge.version: "0.5.0"`、`bridge.phase: 3`、`storage.healthy: true`、`capabilities.tools` 为九个工具，且 `approval_display`、`run_scoped_cancel` 为 `true`。
5. 任务跨插件重载和 DSH 重启保留。读取任务时先 `task_get`；状态为 `needs_recovery` 时再用当前版本和新请求编号调用 `task_recover`，并显式使用 `action: inspect` 核对原生日志。

`runtime_id` 每次插件激活都会变化，`instance_id` 由 Host 与 profile 路径决定，跨重载保持稳定。升级后不要用旧运行编号继续或取消新运行。

`0.4.1` 会修复旧恢复事件覆盖桥接游标的问题：桥接事件 `cursor` 保持分页顺序，原生日志位置保存在 `native_cursor`；加载时只修复已知形状，不重放执行，也不改请求去重记录。旧版任务记录中其他事件顺序损坏仍会拒绝加载。

## 5. 卸载与数据保留

移除客户端连接：

```sh
codex mcp remove cd-connect
```

然后在 DSH 插件页关闭或移除 `cd-connect` bundle。若使用 Desktop CLI，先完全退出桌面，再执行上文 `dsh plugin --profile desktop remove cd-connect`。

移除连接或插件**不会删除**：

- `cd-connect/ledger/` 中的任务记录与请求去重记录；
- DSH 原生会话和原生日志；
- 任务工作目录中的产物。

只有在完全退出 DSH、确认任务已妥善处理并备份所需记录后，才考虑手动删除实际 DSH home 中的 `cd-connect/ledger`。删除会失去去重与恢复依据，不应作为修复重复请求或存储错误的方法。不要在进程运行期间删除 `tasks.lock`、`tasks.lock.acquiring` 或任务记录。

## 6. 常见故障

| 现象 | 先检查 | 处理 |
| --- | --- | --- |
| `npm run health` 报无法连接 | DSH 是否运行、插件是否加载、`CD_CONNECT_STATE_DIR` 是否指向实际目录、连接文件权限 | 修复后重新加载插件；不要把通用网络排障当作桥接问题 |
| 目标会话看不到工具或工具仍是旧的 | 客户端 MCP 连接是否刷新、stdio 适配器是否重启、插件是否加载新版 | 重载插件，刷新/重启 MCP 连接，直接调用 `bridge_health` |
| 插件加载报端口冲突 | `48763` 是否被占用、是否配置了重复端口 | 停用冲突进程或修改原生 `port`，再重新加载 |
| 插件加载报存储锁相关错误 | 是否有其他 live 进程持有 `tasks.lock`、是否有遗留 `tasks.lock.acquiring` | 不要抢占活跃锁；确认所有写入者退出后再人工处理 |
| `storage_corrupt_or_wrong_instance_manual_check_required` | DSH home 是否变化、任务记录是否被手工修改、校验和是否匹配 | 保留现场并备份，人工核对；不要直接删任务记录“修复” |
| 连接文件权限错误 | 权限是否含组/其他位、所有者是否当前用户 | 改回 `0600` 并确认所有者；不要放宽读取范围 |
| `revision_conflict` / `run_conflict` | 快照版本与当前 `run_id` 是否最新 | 重新 `task_get`，使用当前版本和当前运行；不要复用旧控制 |
| `needs_recovery` | 插件是否刚重载、原生日志是否仍可读 | 先快照，再 `task_recover` + `inspect`；不自动重放 |
| `needs_human` | `reason`、DSH 原生会话、当前运行日志与产物 | 人工核对后再决定；不要用新请求编号绕过未知结果 |
| 取消一直停在 `cancel_requested` | 匹配轮次是否结束、Agent 是否空闲 | 继续等待并核对；`accepted` 不是已确认取消 |
| 审批状态一直等待 | 审批是否真的在 DSH 中待处理 | 在 DSH 界面核对完整命令并批准/拒绝；桥接没有批准接口 |
| `native_run_changed_control_rejected` | 会话目录、运行轮次、队列或用户输入是否变化 | 重新读取当前状态；不要重试针对旧运行的控制 |

无法确认时，优先保留任务记录、原生日志和产物，记录具体时间、任务编号与错误码，再请人工核对。不要通过删除锁、清空任务记录或重发未知动作来“恢复”。

## 7. 数据、隐私与安全边界

- **连接凭据**：`connection.json` 含随机 Bearer token 和本机 URL，权限 `0600`；适配器只读取桥接自己的文件，不读取 DSH 账号秘密。
- **任务记录**：`tasks.json` 保存任务正文、实际会话映射、部分工具证据、审查记录和请求哈希。它可能包含私有代码、路径和业务内容，应按本地私有数据处理。
- **原生日志与产物**：DSH 原生会话、原生日志和任务工作目录由 DSH/用户管理，不在桥接任务记录内。桥接只保存证据索引、摘要和目录见证，不复制完整日志或文件内容。
- **删除与保留**：卸载不删除数据；手动删除任务记录会失去请求去重、恢复和审查依据。迁移或删除前先完成核对并备份。
- **网络边界**：服务只监听 `127.0.0.1`，校验 Host 与 Origin，要求 Bearer 凭据，限制请求体为 16 KiB。它仍是本机单用户工具，不是不可信多租户沙箱，也没有公网暴露方案。
- **权限边界**：桥接不改变模型、工具权限或 DSH 原生审批策略，不提供批准、模型切换或额外子 agent 授权。任务内容不能扩大授权。
- **证据边界**：目录见证只覆盖普通文件内容/权限、目录结构和符号链接目标文本，排除 `.git`，不跟随符号链接，上限 20000 个条目与 128 MiB；不能证明外部服务或修改后恢复的历史。
- **漏洞报告**：请按[安全策略](../SECURITY.md)私下发送到 [hanqshih@gmail.com](mailto:hanqshih@gmail.com)，不要用公开 issue 披露可利用细节。
- **许可**：项目采用 MIT，全文见 [LICENSE](../LICENSE)；第三方依赖保留各自许可。

更完整的容量、游标与恢复限制见[任务处理说明](TASK_WORKFLOW.md)。

## 8. 验证方式与边界

- `npm test` 运行隔离测试；未设置 `CD_CONNECT_DSH_SOURCE` 时，需要 DSH 源码的原生组件测试会跳过。跳过不等于通过。
- `npm run check` 递归检查 `src/`、`scripts/`、`test/`（含 `test/support/`）的 `.js` 语法，不是类型检查。
- `.github/workflows/ci.yml` 在 Linux 上覆盖 Node.js `22.19.0` 与 `24.18.0` 的依赖安装、默认测试、递归语法检查和双语文档检查；执行结果以仓库 Actions 记录为准。CI 不包含原生组件测试。
- `npm run health` 验证本机连接与健康响应；`npm run verify:native` 验证本地 HTTP/stdio 两条 SDK 路径。两者都需要正在运行的 Desktop，且都不是目标客户端验收。
- 目标会话中的 `bridge_health`、一次完整任务闭环和人工审查，只能在目标客户端执行。
- 默认测试和 CI 不覆盖原生组件测试（需要匹配的 DSH 源码）、真实桌面与目标客户端验收。网页/隧道、从零客户端安装及 Windows/macOS 尚未验证；各层结果以实际执行记录为准。
