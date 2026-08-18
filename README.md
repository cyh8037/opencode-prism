# Prism

OpenCode 插件：视觉自动解读、后台并行 Agent、复杂任务拆分，附带 tmux pane 可视化。

- **视觉解读**：截图工具输出或对话图片自动交给配置的视觉模型解读，结果回注主会话；未配置时继承主会话当前模型（支持图片时自动启用，否则跳过，图片留在主上下文）；图片支持 URL、data URL、file:// 及本地文件路径（相对路径按项目目录解析）
- **后台并行**：`/bg` 命令 + `bg_spawn` 工具，独立子会话并行执行（继承主会话模型），toast 进度 + 会话内汇总通知
- **任务拆分**：`/split` 命令，规划器拆出带依赖的子任务图，按层并发执行
- **tmux**：每个后台任务一个 pane，实时显示子 agent 的 TUI，完成即关

## 安装

要求 **opencode ≥ 1.15.0**(会话创建的 `model` 字段从 1.15 起才被服务端接受;更早版本插件仍可加载,但后台子会话无法继承主会话模型)。

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
    "model": "dashscope/qwen3.6-flash",          // provider/model；不填 = 继承主会话模型（支持图片时自动启用）
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
    "model": "",                                 // provider/model + 可选 variant；空字符串 = 继承主会话模型（默认）
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

会话模型零配置：后台任务、/split 子任务和**视觉解读**（未配置 `vision.model` 时）都**继承主会话当前模型**，主会话切模型后自动跟随。视觉继承走 `chat.params` hook 的 `capabilities.input.image`——与 opencode 运行时判断"能否收图"用的是同一个信号：主会话模型支持图片就自动启用，不支持就直接跳过（不创建子会话、不开后台任务），模型切换即时生效。配置非法（引用格式错误）时视觉保持关闭。

其余全部走固定默认值：单次视觉解读上限 4 张图片、120s 视觉超时、30 分钟任务 TTL、3s 轮询、pane 容量等。

## 命令与工具

| 接口 | 用法 |
|---|---|
| `/bg <描述> [--parallel N]` | 启动后台任务（--parallel 拆 N 个并行子任务） |
| `/bg status \| output <id> \| cancel <id>` | 查询/取消（插件原生执行） |
| `/split <任务> [--dry-run] [--sequential] [--max N]` | 复杂任务拆分并发执行 |
| `/split status \| output <id> \| cancel <id>` | 同上 |
| `bg_spawn / bg_output / bg_cancel` | 模型中途可用的工具接口 |
| `vision_look(images: [url/路径...])` | 手动视觉解读（支持 URL、file://、本地路径） |

## 模型语义

- **会话模型**：三级获取（`session.get` 的 data.model → 父会话最新消息的 info.model → opencode 配置默认模型），每次启动后台任务时读取，主会话 `/models` 切换后新任务自动跟随
- **视觉模型**：显式 `provider/model` 配置；未配置时继承主会话当前模型（`chat.params` 的 `capabilities.input.image` 门控，模型切换自动跟随）。不探测连接状态，不可用即优雅降级：解读失败留图给主模型，重试耗尽后图片保留在主上下文。配置了不支持图片的模型会在解读阶段失败并重试耗尽
- **重试**：可重试错误（限流/5xx/超时）**同模型重建会话重试 1 次**，再失败报错；没有换 provider、没有换模型

## 内部消息注入闸门

所有发往父会话的内部消息（完成通知、视觉解读、split 汇总）只走 `PromptGate`：按会话预留、同文本去重、会话活跃时等待 settle、失败可重排。这是防止重复注入的核心纪律。

单任务完成时，通知会把**完整结果**注入父会话（上限 20k 字符，超出截断并附 `bg_output` 指引）；批量任务保持逐条 200 字符预览 + `bg_output` 指针，避免多份完整结果刷屏。

## 日志与静默错误

Prism 不向控制台输出任何内容（插件与 TUI 同进程，stderr 会漏进界面）。日志写入 `~/.local/share/opencode/log/prism.log`（跟随 `XDG_DATA_HOME`，可用 `PRISM_LOG_FILE` 覆盖）。所有 hook 经 `guardHook` 包裹：内部错误只进日志文件，绝不以 opencode 的 `Session.Event.Error` 形式弹到 TUI；视觉/规划器/拆分等核心路径同样捕获网络拒绝并优雅降级。

## 目录结构

```
src/
├── index.ts            # 插件装配：模型解析、hooks/tools/commands 接线、dispose
├── config/             # zod schema（vision/background/tmux）、JSONC 解析、加载与合并
├── models/             # provider/model 解析、错误分类
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
scripts/qa/sandbox-run.sh   # 隔离 XDG + 本地插件路径 + opencode run，grep 沙箱内 prism.log 初始化日志
```

tmux 验证：`tmux -L prism-qa new-session -d` 内跑 opencode，断言 `tmux list-panes` 中 pane 命令包含 `opencode attach`。

QA 记录：`docs/qa/`（每次 harness 验证一份）。

## 已知边界

- **`opencode run` 非交互模式**：主会话结束后进程退出，未完成的后台任务会被 dispose 中止。TUI 模式不受影响。修复方向：CLI run 模式的 continuation marker（保持未完成 todo 直到后台任务清空），参考 oh-my-openagent 的 background-task-marker 机制。
- **tmux isolation window/session**：配置 schema 已预留，v1 实现 inline；window/session 两种隔离待实现。

## 变更记录

- **0.1.0**（未发布）：视觉自动解读（系统提示词 + 单模型配置）、后台并行引擎（并发信号量 + toast/会话通知）、/split DAG 调度、tmux pane 可视化、PromptGate 注入闸门
- **2026-08-15 重构**：会话模型改为继承主会话当前模型（删除 categories 与 fallback 链），视觉模型改为单 `provider/model` 配置，移除整套多 provider 机制（provider 探测/反向解析/id 转换），重试简化为同模型单次
- **2026-08-17**：视觉模型未配置时经 `chat.params` 能力门控继承主会话模型（`capabilities.input.image`，与运行时同源信号；新会话首条消息的图片等待快照最长 3s，修复跨会话历史召回图片不解读的问题）；后台视觉任务钉死门控模型；本地图片路径支持（魔数校验）；轮询状态分叉（streaming/error/deleted）；配置逐节回退 + 启动 toast 警告；删除静态能力快照；toast 加固（可选链防 API 缺失、批量任务只弹首条启动与最后一条终态、cancelled 用 warning 样式）
- **2026-08-17（静默与完整结果）**：修复后台任务结果捕获（opencode 的 part 数据不带 role/state，原来按 part.role/state 判断永远取不到结果文本——/bg 解析图后父会话只收到 COMPLETED 状态行；改为消息历史 API 权威捕获 + 事件捕获按 synthetic 排除提示词）；单任务完成通知注入完整结果（上限 20k 字符）；日志从 console.error 改写入 opencode 日志目录下的 prism.log（XDG 感知）；所有 hook 加 guardHook 静默兜底，内部错误不再以 Session.Event.Error 弹到 TUI
