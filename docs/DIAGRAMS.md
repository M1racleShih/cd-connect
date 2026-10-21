# README 图表维护

[中文](DIAGRAMS.md) · [English](DIAGRAMS.en.md)

README 中的架构图使用 `diagram-design` 重绘。中文版和英文版共用节点、连接与配色，只替换标签和无障碍说明。图表解释组件关系；任务步骤和权限限制以[任务协议](TASK_WORKFLOW.md)与[架构说明](ARCHITECTURE.md)为准。

## 文件与生成方式

| 文件 | 用途 |
| --- | --- |
| [`scripts/render-diagrams.js`](../scripts/render-diagrams.js) | 共用布局、中英文标签、HTML 生成与 SVG 导出 |
| [`docs/diagram-style.json`](diagram-style.json) | 项目配色与字体配置 |
| [中文 HTML](assets/architecture.html) / [English HTML](assets/architecture.en.html) | 含内联 SVG 的完整可编辑图表 |
| [中文 SVG](assets/architecture.svg) / [English SVG](assets/architecture.en.svg) | README 使用的静态矢量图片 |

从源码根目录运行：

```sh
npm run docs:diagrams
npm run check:docs
```

生成程序先写出含 SVG 的 HTML，再从同一内容中提取独立 SVG。不要只改导出的 SVG；修改标签或布局后重新生成两种语言，并在浏览器中查看两份 HTML。程序仅使用 Node.js 标准库，不连接 DSH，不增加运行时依赖。

## 配色与字体

本项目选用蓝灰底色、深蓝重点，替代 skill 的默认橙色。项目配置保存在 `docs/diagram-style.json`，不修改 dskills 管理的 skill 副本。

| 配置项 | 值 | 用途 |
| --- | --- | --- |
| `paper` | `#f3f5f8` | 图表背景 |
| `paper2` | `#e7ecf2` | 输入与持久记录背景 |
| `ink` | `#1e293b` | 主要文字和边框 |
| `muted` | `#475569` | 次要文字与连接 |
| `rule` | `#b8c4d3` | Host 边界与图例分隔 |
| `accent` / `accentTint` | `#254e88` / `#e5edf9` | 插件重点节点 |
| `link` | `#345f9e` | MCP 与原生接口连接 |

字体优先使用 Geist、Instrument Serif 和 Geist Mono，并配置 Noto CJK 与系统字体回退。文件不加载远程字体；本机未安装这些首选字体时会使用回退字体，不同系统的字形可能不同。中英文标签都须检查截断、重叠和小尺寸可读性。SVG 包含 `title`、`desc` 和 `aria-labelledby`；README 另有对应语言的图片说明。

## 原图内容的保留

重绘采用 Architecture 类型、`doc-wide` 尺寸（1280 × 720）、`balanced` 细节和 `mixed` 读者层级。主节点名称使用 20 px，记录节点使用 16 px，辅助文字使用 12 px，方便在 README 中缩放阅读。

原 Mermaid 图有 11 个组件、1 个 Host 容器和 13 条连接。重绘保留全部组件含义与关系，显示为 9 个节点、1 个容器和 10 条连接：

- MCP 服务与任务/审查管理合并为“cd-connect 插件”，省去内部连接。
- 原生接口适配与原生会话/Agent 合并为“DSH 原生执行”，省去内部连接。
- 执行写日志与恢复读日志合并为执行端和原生日志之间的双向连接。
- 用户授权、DSH 人工审批、本地 stdio、回环 HTTP、持久任务记录、目录见证及实际工作目录均保留；没有删除组件含义。

## 使用技能复查

本地 dskills 池需已有 `diagram-design` 和 `plain-docs`。仅在项目尚未初始化时执行：

```sh
dskills init --agent codex --mode copy --no-track
```

然后安装或检查项目选择的版本：

```sh
dskills plug diagram-design plain-docs
dskills status
```

这组技能供本项目文档工作使用，配置与生成的 skill 副本保留在本机，不随公开项目文档提交。更换版本后重新阅读技能说明；dskills 的固定版本不会因全局池更新而自动前移。

生成后可运行 diagram-design 自带的检查：

```sh
python3 .agents/skills/diagram-design/scripts/self_check.py docs/assets/architecture.html docs/assets/architecture.en.html
```

该检查覆盖可访问性和单文件输出的基础要求。仍须打开两种语言的图表，逐条检查箭头方向、Host 内外归属、文字、连接交叉和标签间距。文档及图中文字修改完成后，按 `plain-docs` 全文复读并对照中英文，保留准确的状态名、数值和权限限制。
