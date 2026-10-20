# 贡献指南

cd-connect 目前是本地单用户、Linux、JavaScript 的早期项目。源码仓库为 `M1racleShih/cd-connect`；CI 工作流已加入，执行结果以仓库 Actions 记录为准。本指南说明怎样搭建开发环境、怎样按层级验证，以及哪些契约不能顺手改掉。

相关入口：[README](README.md) · [安装与维护](docs/INSTALLATION.md) · [架构与边界](docs/ARCHITECTURE.md) · [任务协议](docs/TASK_WORKFLOW.md) · [安全策略](SECURITY.md) · [Agent 工作入口](AGENTS.md)

源码仓库为 [M1racleShih/cd-connect](https://github.com/M1racleShih/cd-connect)。使用完整源码目录安装，不提供 npm 包。

## 开发环境

需要 Linux、Node.js `22.19.0` 或更新版本、npm。基础隔离测试不需要 DSH 账号或桌面；连接、健康检查和原生组件测试需要相应环境。

```sh
cd /absolute/path/to/cd-connect   # 示例路径
npm ci --ignore-scripts
npm test
npm run check
```

`--ignore-scripts` 与现有安装方式一致。项目是纯 ESM JavaScript，没有构建、转译或类型检查步骤；修改后直接由 Node.js 加载。请不要在普通贡献中引入 TypeScript 迁移、构建链、新运行时依赖或安装生命周期脚本。

### 目录入口

| 路径 | 职责 |
| --- | --- |
| `src/plugin.js` | 在 Desktop Host 内注册插件、启动监听、写入连接文件 |
| `src/server.js` | 回环 HTTP MCP 服务、Bearer 认证、工具注册与错误收敛 |
| `src/stdio.js`、`src/connection.js` | 本地 stdio 适配器与凭据读取 |
| `src/protocol.js` | 工具名、Zod 输入 schema、面向 Agent 的使用说明 |
| `src/tasks.js` | 任务状态机、请求去重、证据、审查、取消与恢复 |
| `src/native.js` | 对 DSH 公开服务的窄适配与同步控制检查 |
| `src/storage.js` | 单写入者锁、校验和快照、原子落盘、旧账本兼容 |
| `src/workspace.js` | 工作目录见证与目录重叠判断 |
| `test/` | 隔离测试、原生组件测试和故障注入辅助 |
| `docs/` | 面向使用者和贡献者的深入说明 |

## 验证分层

不要用一种检查替代另一种。提交结果时应说明实际运行了哪几层，以及哪些层被跳过。

### 1. 隔离测试（默认应运行）

```sh
npm test
```

默认命令使用临时目录和模拟原生服务，不访问真实 DSH 账号，也不修改现有桌面。默认会跳过需要下一层 `CD_CONNECT_DSH_SOURCE` 的原生组件测试；跳过不等于通过，不能因此宣称“全部通过”。

修改任务状态、恢复、存储、目录见证或取消逻辑时，必须同时覆盖成功路径与拒绝路径。故障注入测试会启动 `scripts/fault-worker.js` 子进程；只使用它自己创建的一次性路径。

### 2. 语法检查（默认应运行）

```sh
npm run check
```

它递归遍历 `src/`、`scripts/` 和 `test/`，对其中所有 `.js` 文件执行 `node --check`，因此覆盖 `test/support/` 等测试辅助文件。它不解析类型，也不是类型检查；不要把它描述为类型安全或完整静态分析。

### 3. 持续集成（GitHub Actions）

`.github/workflows/ci.yml` 在 Linux 上对 Node.js `22.19.0` 与 `24.18.0` 分别执行：

```sh
npm ci --ignore-scripts
npm test
npm run check
```

工作流使用只读仓库权限，不依赖 DSH 账号、真实桌面或目标客户端。它不运行原生组件测试，也不构成目标客户端验收。本地或候选目录中的执行结果不能替代 Hosted CI 记录；工作流是否已执行，以实际运行记录为准。

### 4. 原生组件测试（修改适配边界时运行）

```sh
CD_CONNECT_DSH_SOURCE=/absolute/path/to/dsh-source \
  node --test test/native-lifecycle.test.js
```

需要与 `0.2.1-rc.2` 匹配的 DSH 源码检出。该组测试使用隔离的 Cordis 上下文、临时会话和夹具模型，验证冷启动、JSONL 日志读取、原生审批审计、受控续写与取消；它**不**启动或破坏真实桌面，也不替代真实任务验收。若版本不匹配，先报告实际版本，不要伪造通过。

### 5. 本机运行路径（需要活跃 Desktop）

```sh
npm run health
npm run verify:native
```

`npm run health` 读取实际 `connection.json` 并调用 `bridge_health`；`npm run verify:native` 比较本地 HTTP 与 stdio 两条 SDK 路径、九个工具和同一 Host 身份。两者都要求插件已加载。它们仍不是目标客户端验收：目标会话是否真的能发现并调用工具，只能在目标客户端中确认。

### 6. 目标客户端闭环（独立验收）

在目标 Codex 桌面会话中直接调用 `bridge_health`，提交一个范围明确的小任务，等待完成，逐页读取当前运行证据，检查实际产物，再记录一次具体返工和最终 `accepted`。这一步需要真实桌面、真实模型和独立判断（由人或用户授权的规划/审查 Agent 执行），仓库内测试不能代替。

### 默认检查之外的验证

- 本地干净环境结果不能替代 Hosted CI 记录，请查阅仓库 Actions 的实际结果。
- 默认测试和 CI 会跳过需要 `CD_CONNECT_DSH_SOURCE` 的原生组件测试；运行该层需要另行准备匹配的 DSH 源码并记录结果。
- 没有在 Windows/macOS、其他 ChatGPT 客户端或网页隧道路径上验证。
- 目标客户端中的工具发现、完整任务闭环和独立验收需在真实桌面单独执行，默认测试和 CI 不覆盖这一层。
- `npm run health` 与 `npm run verify:native` 需要活跃的 Desktop 和有效连接文件，不在默认测试或 CI 中运行。

维护者如需保留测试矩阵，可设置 `CD_CONNECT_TEST_EVIDENCE_DIR` 指向私有临时目录。生成文件含任务状态与本地路径，不要提交或公开。

## 变更约定

- **保持契约稳定**：工具名称、输入字段、错误码、状态名、账本格式、默认分页和权限行为都是外部契约。确需改变时，单独说明兼容与迁移方案，不要夹在重构中。
- **运行时校验不能消失**：Zod schema 是工具输入的边界；存储加载还会重新校验规格和请求。不要用强制类型断言或更宽松的解析替换它。
- **持久化顺序不能倒置**：请求登记、创建/派发意图、原生回执和证据各自有保存点。修改 `tasks.js` 或 `storage.js` 时，要说明崩溃落在任意保存点时的恢复行为，并保持“未知不重放”。
- **控制必须绑定当前运行**：续写和取消依赖 `run_id`、`expected_revision` 以及原生同栈检查。不要引入检查与入队之间的异步窗口，也不要让旧运行控制新运行。
- **错误要收敛**：工具错误只能返回受控错误码，不能包含提供方错误正文、原生堆栈、账号配置、令牌或连接文件内容。
- **目录见证语义不能弱化**：排除 `.git`、不跟随符号链接、限制条目与容量、检测核对期间变化。目录占用不是系统级锁，不要这样宣传。
- **测试要可移植**：使用临时目录；不要复制真实任务账本、真实会话日志或私有证据进公开测试；不要为了测试中断现有桌面。
- **文档要同步**：行为变化时更新 `README.md` 与 `README.en.md` 的支持范围、命令和限制；深入文档当前为中文，若新增英文版本，记得修改英文入口的语言说明。
- **公开资料要干净**：不得引用私有规划或实施记录、作者绝对路径、真实会话或私有证据。示例路径要明确标为示例。

## 提交与审查

1. 保持改动聚焦，不顺手迁移语言、升级依赖或重排无关文件。
2. 运行 `npm test` 与 `npm run check`；修改原生适配、日志读取或取消逻辑时，再运行原生组件测试。
3. 更新相关的中英文说明和任务协议；检查本地 Markdown 链接与 Mermaid 图。
4. 在结果中列出改动文件、实际命令及退出状态、跳过项、风险和未决问题。
5. 提交、推送、创建公开仓库、发布 npm 包都需要人类明确授权。当前 `private: true` 与 JavaScript 路线不要自行改变。

审查者会关注：任务与授权边界是否仍然清晰、未知结果是否仍不重放、执行与验收是否仍分离、旧账本和旧请求是否仍可读、公开文档是否与实际命令一致。测试数量不能替代这些语义检查。

## 数据与安全

不要提交或粘贴连接凭据、`connection.json`、完整账本、原生会话日志、账号配置或包含私有任务内容的测试夹具。使用一次性工作区并清理临时数据。

桥接只监听回环地址，但它是本地工具边界，不是多租户沙箱；不要把监听公开到互联网，也不要在公开材料中宣称具备沙箱隔离。漏洞请按[安全策略](SECURITY.md)私下发送到 [hanqshih@gmail.com](mailto:hanqshih@gmail.com)，不要用公开 issue 披露可利用细节。

许可：项目采用 MIT，完整文本与版权声明见 [LICENSE](LICENSE)。新增代码需与 MIT 兼容；复制或改编其他来源的代码时，必须保留原许可与归属，并在提交说明中记录来源，不能只凭“参考架构”推断授权。依赖保留各自许可，新增依赖前先核对来源与许可。
