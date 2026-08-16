# Prism

OpenCode 插件：视觉自动解读、后台并行 Agent、复杂任务拆分，附带 tmux pane 可视化。

- **视觉解读**：截图工具输出或对话图片自动交给配置的视觉模型解读，结果回注主会话
- **后台并行**：`/bg` 命令 + `bg_spawn` 工具，独立子会话并行执行（继承主会话模型），toast 进度 + 会话内汇总通知
- **任务拆分**：`/split` 命令，规划器拆出带依赖的子任务图，按层并发执行
- **tmux**：每个后台任务一个 pane，实时显示子 agent 的 TUI，完成即关

## 安装

```bash
bunx opencode-prism install   # 待发布；当前开发期用本地路径
```

开发期在 `~/.config/opencode/opencode.json` 中直接引用本地路径：

```jsonc
{
  "plugin": ["/path/to/prism"]
}
```

## 项目级使用

推荐团队/仓库场景：插件引用和 prism 配置都放在项目里，随仓库提交，打开项目的每个人自动获得相同行为。

**1. 项目 opencode.json 引用插件**（项目根目录 `opencode.json`）：

```jsonc
{
  // 开发期：本地路径（指向 clone 下来的 prism 仓库）
  // 发布后：直接写包名
  "plugin": ["opencode-prism"]
}
```

**2. 项目 `.prism/prism.jsonc` 配置**（随仓库提交，团队共享）：

```jsonc
{
  "vision": {
    "model": "anthropic/claude-fable-5 xhigh",
    "mode": "sync",
    "tools": ["read"],
    "chatImages": true
  },
  "background": { "concurrency": 5 },
  "tmux": { "enabled": true, "layout": "main-vertical", "isolation": "inline" }
}
```

**配置发现与覆盖规则**：从项目根目录向上逐级查找 `.prism/prism.jsonc`（到 `$HOME` 为止，最近的生效），叠加在用户级 `~/.prism/prism.jsonc` 之上，最后盖在内置默认值上。即 项目级 > 用户级 > 默认值，任何层级都可以只写需要覆盖的部分。

**分工建议**：

| 场景 | 放哪里 |
|---|---|
| 团队约定的视觉模型、并发、tmux 布局 | 项目 `.prism/prism.jsonc`，提交进 git |
| 个人临时偏好（如关掉 chatImages、调整并发） | 用户 `~/.prism/prism.jsonc`，不提交 |
| 一次性实验/QA | 环境变量 `PRISM_CONFIG=/path/to/config.jsonc` |

## 配置

项目 `.prism/prism.jsonc` 覆盖用户 `~/.prism/prism.jsonc` 覆盖内置默认值（环境变量 `PRISM_CONFIG` 可指向任意配置文件，QA 用）：

```jsonc
{
  "vision": {
    "model": "anthropic/claude-fable-5 xhigh",  // provider/model + 可选 variant；空字符串 = 关闭视觉功能
    "mode": "sync",                              // sync | background
    "tools": ["read"],                           // 可选：只拦这些工具；不填 = 所有工具
    "chatImages": true                           // 对话贴图自动解读（主模型多模态时可关）
  },
  "background": {
    "concurrency": 5                             // 每个 provider/model 的并行上限
  },
  "tmux": {
    "enabled": true,                             // 不在 tmux 内时自动降级
    "layout": "main-vertical",                   // main-vertical | main-horizontal | tiled | even-*
    "isolation": "inline"                        // inline | window | session
  }
}
```

会话模型零配置：后台任务和 /split 子任务**继承主会话当前模型**（主会话切模型后自动跟随）。

其余全部走固定默认值：3s/4 张的视觉合并、120s 视觉超时、30 分钟任务 TTL、3s 轮询、pane 容量、视觉能力快照等。

## 命令与工具

| 接口 | 用法 |
|---|---|
| `/bg <描述> [--parallel N]` | 启动后台任务（--parallel 拆 N 个并行子任务） |
| `/bg status \| output <id> \| cancel <id>` | 查询/取消（插件原生执行） |
| `/split <任务> [--dry-run] [--sequential] [--max N]` | 复杂任务拆分并发执行 |
| `/split status \| output <id> \| cancel <id>` | 同上 |
| `bg_spawn / bg_output / bg_cancel` | 模型中途可用的工具接口 |
| `vision_look(images: [url...])` | 手动视觉解读 |

## 模型语义

- **会话模型**：三级获取（`session.get` 的 data.model → 父会话最新消息的 info.model → opencode 配置默认模型），每次启动后台任务时读取，主会话 `/models` 切换后新任务自动跟随
- **视觉模型**：显式 `provider/model` 配置，不探测连接状态（不可用即优雅降级：解读失败留图给主模型）；内置能力快照校验，配了纯文本模型启动时告警
- **重试**：可重试错误（限流/5xx/超时）**同模型重建会话重试 1 次**，再失败报错；没有换 provider、没有换模型

## 内部消息注入闸门

所有发往父会话的内部消息（完成通知、视觉解读、split 汇总）只走 `PromptGate`：按会话预留、同文本去重、会话活跃时等待 settle、失败可重排。这是防止重复注入的核心纪律。

## 目录结构

```
src/
├── index.ts            # 插件装配：模型解析、hooks/tools/commands 接线、dispose
├── config/             # zod schema（vision/background/tmux）、JSONC 解析、加载与合并
├── models/             # provider/model 解析、视觉能力快照、错误分类
├── core/
│   ├── prompt-gate.ts  # 内部消息注入闸门（唯一通道）
│   ├── background/     # 后台引擎：manager / concurrency / 状态机
│   ├── vision/         # 视觉管线：detector / interpreter / pipeline
│   └── split/          # 拆分：planner / scheduler（DAG）/ service
├── tmux/               # pane 生命周期、attach 命令、布局、清扫（vendored 模式）
├── hooks/              # tool.execute.after / chat.message / event / command.execute.before
├── tools/              # bg_spawn / bg_output / bg_cancel / vision_look
└── commands/           # /bg /split 模板
tests/                  # bun:test 单测（与 src 同构）
scripts/qa/             # 隔离 XDG 沙箱 QA 脚本
docs/qa/                # 每次 harness 验证的证据记录
```

## 开发

```bash
bun install
bun test        # 49 个单测：并发、gate、模型解析、split DAG、tmux 命令
bun run typecheck
bun run build   # dist/index.js
```

## QA

Harness 级验证在隔离 XDG 沙箱进行，不碰真实 `~/.local/share/opencode`：

```bash
scripts/qa/sandbox-run.sh   # 隔离 XDG + 本地插件路径 + opencode run，grep [prism] 初始化日志
```

tmux 验证：`tmux -L prism-qa new-session -d` 内跑 opencode，断言 `tmux list-panes` 中 pane 命令包含 `opencode attach`。

QA 记录：`docs/qa/`（每次 harness 验证一份）。

## 已知边界

- **`opencode run` 非交互模式**：主会话结束后进程退出，未完成的后台任务会被 dispose 中止。TUI 模式不受影响。修复方向：CLI run 模式的 continuation marker（保持未完成 todo 直到后台任务清空），参考 oh-my-openagent 的 background-task-marker 机制。
- **`prism refresh-models` CLI**：模型能力快照刷新命令尚未实现，当前快照为打包内置（`src/models/capabilities.ts`）。
- **tmux isolation window/session**：配置 schema 已预留，v1 实现 inline；window/session 两种隔离待实现。

## 变更记录

- **0.1.0**（未发布）：视觉自动解读（系统提示词 + 单模型配置）、后台并行引擎（并发信号量 + toast/会话通知）、/split DAG 调度、tmux pane 可视化、PromptGate 注入闸门
- **2026-08-15 重构**：会话模型改为继承主会话当前模型（删除 categories 与 fallback 链），视觉模型改为单 `provider/model` 配置，移除整套多 provider 机制（provider 探测/反向解析/id 转换），重试简化为同模型单次
