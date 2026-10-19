# cd-connect

[中文](README.md) | [English](README.en.md)

连接 ChatGPT 桌面应用与 DeepSeek Harness，让 ChatGPT 负责目标、阶段决策和验收，让 DeepSeek Harness 负责执行。

项目名中的 **c** 代表 **ChatGPT**，**d** 代表 **DeepSeek Harness**。

## 项目状态

目前已完成仓库初始化和初步方案设计，尚未实现可运行的桥接，也未完成真实客户端之间的连通验证。下述能力是第一版目标，不代表已经可用。

## 目标工作流

1. 用户在 ChatGPT 中说明目标、约束和验收条件。
2. ChatGPT 向 DeepSeek Harness 委派一个阶段任务。
3. DeepSeek Harness 使用自己的模型，在授权范围内规划、实现、测试和修复。
4. ChatGPT 读取执行结果与验证证据，决定通过、返工或继续下一阶段。
5. 关键操作由用户审批。

第一版面向同一台 Linux 电脑上的 ChatGPT 桌面应用与 [DSH Linux](https://github.com/M1racleShih/dsh-linux)，优先接入已有 DSH 桌面实例。计划通过 MCP 提供任务提交、状态读取、结果审查和继续执行能力；实际连接方式与版本兼容性以实现后的验证结果为准。

## 第一版范围

- 单用户，在活跃的 ChatGPT 会话中形成自动执行与审查闭环。
- DSH 在子任务内自主工作，ChatGPT 负责阶段之间的决策。
- 中断后由用户恢复，沿用可核对的任务和会话记录。
- 保留 DSH 原生工作区、工具权限与用户审批机制。
- 核对任务版本、操作归属和结果证据，避免重复执行或使用过期状态。

长期无人值守、自动唤醒 ChatGPT 和多个执行器之间的调度不在第一版范围内。

## 安装与使用

当前没有可安装的发布版本。连接和安装步骤将在真实客户端闭环验证通过后提供。

## 相关项目

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：上游执行框架。
- [DSH Linux](https://github.com/M1racleShih/dsh-linux)：第一版接入目标。
- [dsh-chatgpt-bridge](https://github.com/jiezeng2004-design/dsh-chatgpt-bridge)：相关桥接实现参考。
- [codex-bridge](https://github.com/Fanch-hui/codex-bridge)：多执行器桥接实现参考。

cd-connect 是独立项目，与 OpenAI 或 DeepSeek 不存在官方隶属或背书关系。
