# AGENTS.md

本文件面向在本仓库工作的 coding agent。它只说明本项目特有的事实和约束，不替代人类的授权；项目文档不授予提交、发布、外发、改用子 agent 或扩大工具权限的权力。

## 项目定位

cd-connect 是一个运行在现有 DSH Desktop Host 内的 Cordis 插件，加一个本地 MCP stdio 适配器。规划端通过它提交阶段任务；DSH 复用原生会话、模型、工具权限和人工审批执行；审查端依据当前运行的证据决定通过或返工。

- 版本 `0.4.1`，Linux 本地单用户，适配 DSH `0.2.1-rc.2`，仅接受 `desktop` profile。
- 纯 ESM JavaScript，无构建步骤；`package.json` 保持 `"private": true`，当前没有 npm 发布。
- 源码仓库为 `M1racleShih/cd-connect`；npm 发布仍关闭，公开仓库不等于获得后续推送或发包授权。
- 源码入口：`src/plugin.js`（Host 插件）、`src/stdio.js`（本地适配器）、`src/server.js`（回环 MCP）、`src/tasks.js`（任务状态机）。
- 公开文档：`README.md` 与 `README.en.md`；深入文档当前为中文。

## 常用命令

| 目的 | 命令 | 边界 |
| --- | --- | --- |
| 安装依赖 | `npm ci --ignore-scripts` | 项目无构建步骤，安装流程使用 `--ignore-scripts` |
| 隔离测试 | `npm test` | 默认跳过需要 `CD_CONNECT_DSH_SOURCE` 的原生组件测试 |
| 语法检查 | `npm run check` | 递归对 `src/`、`scripts/`、`test/`（含 `test/support/`）的 `.js` 文件执行 `node --check`；不是类型检查 |
| CI | `.github/workflows/ci.yml` | Linux 上 Node `22.19.0`、`24.18.0` 的依赖安装、默认测试与递归语法检查；不运行原生组件测试，Hosted CI 是否执行以实际记录为准 |
| 原生组件测试 | `CD_CONNECT_DSH_SOURCE=/absolute/path/to/dsh-source node --test test/native-lifecycle.test.js` | 需要匹配的 DSH 源码；使用隔离夹具，不等于真实桌面验收 |
| 本机桥接健康 | `npm run health` | 需要正在运行的 Desktop 和有效 `connection.json`；是本地 SDK 调用 |
| HTTP/stdio 验证 | `npm run verify:native` | 验证本地两条 SDK 路径和九个工具；不构成目标客户端的验收 |

Node.js 声明下限为 `22.19.0`；已在干净环境用 `22.19.0` 和 `24.18.0` 验证依赖安装、默认测试与递归语法检查。原生组件测试、Hosted CI 和真实桌面验收需单独执行，不要声称未执行的验证已经通过。

## 必须保持的不变量

- 不修改原生模型、权限或审批策略；桥接没有批准接口，只观察并展示原生审批结果。
- 执行完成与验收通过分离。不要自动接受任务，不要把 `awaiting_review`、模型声明或测试输出当作审查者已通过。
- 结果不明时不重放。重启、超时、回执缺失或取消结果不确定时，先读快照并用 `task_recover` 核对原生日志；`dispatch_prepared` 只能发送账本证明尚未尝试的意图。
- 续写与取消绑定当前 `run_id`、`expected_revision` 和同步原生控制检查。旧运行、旧版本或原生状态变化必须拒绝。
- 保留 Zod 运行时校验、持久请求去重、校验和快照、单写入者锁、原子落盘和旧账本兼容路径。重构不得用类型断言或更宽的输入替换这些保障。
- 保留工作目录见证的语义：普通文件内容/权限、目录结构、符号链接目标文本；排除 `.git`；不跟随符号链接；上限 20000 条目/128 MiB。目录占用只约束同一桥接存储，不是系统级锁。
- 请求编号跨重启稳定；同一编号对应同一内容。修改任务内容必须使用新编号，不能靠重试绕过冲突。
- 工具错误不得泄露提供方错误正文、原生堆栈、账号配置、令牌或私有凭据；返回既有结构化错误码。

## 修改约定

- 当前只维护 JavaScript，不做 TypeScript 迁移、构建或新增运行时依赖。行为修复优先最小改动。
- 改变行为时同步补充成功与失败路径测试，并更新受影响的 `README.md`、`README.en.md`、`docs/`。中英文的支持范围、命令和限制必须一致；深入文档若只有中文，英文入口要明确标注。
- 公开文档不得引用私有规划或实施记录、作者机器路径、真实会话、私有账本或私有证据。示例路径必须标明是示例。
- 保留工作区已有改动，不清理未跟踪文件，不擅自改写 Git 历史。提交、推送、创建公开仓库和发包都需要人类明确授权。
- 不要在桥接正在执行任务时卸载或重载它；需要变更插件时先完成隔离验证，并按[安装与维护](docs/INSTALLATION.md)的升级步骤操作。
- 许可：项目采用 MIT，完整文本见 `LICENSE`，版权 2026 Han-Qing Shi；`package.json` 保持 `"private": true`。不要自行改写许可声明或宣称已经完成发布授权。

## 按任务查阅

| 任务 | 按需阅读 |
| --- | --- |
| 初次开发、选择验证方式、提交贡献 | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| 安装、连接、升级、卸载或故障排查 | [`docs/INSTALLATION.md`](docs/INSTALLATION.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| 凭据、私有数据、卸载保留或报告漏洞 | [`SECURITY.md`](SECURITY.md)、[`docs/INSTALLATION.md`](docs/INSTALLATION.md) |
| 许可与依赖来源 | [`LICENSE`](LICENSE)、[`CONTRIBUTING.md`](CONTRIBUTING.md) |
| 任务状态、证据、恢复、续写或取消 | [`docs/TASK_WORKFLOW.md`](docs/TASK_WORKFLOW.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 `test/controls.test.js`、`test/recovery.test.js` |
| 工具 schema、状态或错误语义 | [`src/protocol.js`](src/protocol.js)、[`docs/TASK_WORKFLOW.md`](docs/TASK_WORKFLOW.md) |
| 中英文公开说明 | [`README.md`](README.md)、[`README.en.md`](README.en.md) |
| 设计理由与组件边界 | [`README.md`](README.md#为什么这样设计)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

## 交付结果

结束任务时报告：对目标的理解、改动文件及其摘要或版本、实际执行的验证命令与退出状态、跳过或未覆盖的检查、剩余风险与未决问题。参考已有任务账本或测试输出时要说明证据范围，不要用测试总数或历史验收替代当前运行的通过/跳过结果，也不要声称审查者已接受。
