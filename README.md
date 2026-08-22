# Prism

OpenCode 插件：视觉自动解读、后台并行 Agent、复杂任务拆分。

- **视觉解读**：带图片附件的工具输出自动解读并追加进工具输出（落会话历史）；对话贴图/任意图片用 `vision_look` 工具（支持 `goal` 关注点与 `"last"` 哨兵解读会话内最近图片）或 `/vision` 命令手动解读，结果直接注入对话。未配置时继承主会话当前模型（支持图片时自动启用，否则跳过并提示）；图片支持 URL、data URL 及本地文件路径（相对路径按项目目录解析；仅 http(s) 会被 fetch，`file://` 等协议一律拒绝）
- **后台并行**：`/bg` 命令 + `bg_spawn` 工具，独立子会话并行执行（继承主会话模型），toast 进度 + 会话内汇总通知；`/bg output <id> --full` 附 `opencode attach` 提示可随时回看子会话
- **任务拆分**：`/split` 命令，规划器拆出带依赖的子任务图，按层并发执行

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
    "tools": ["read"]
  },
  "background": { "concurrency": 5 }
}
```

**配置发现与覆盖规则**：从项目根目录向上逐级查找 `.prism/prism.jsonc`（到 `$HOME` 为止，最近的生效），叠加在用户级 `~/.prism/prism.jsonc` 之上，最后盖在内置默认值上。即 项目级 > 用户级 > 默认值，任何层级都可以只写需要覆盖的部分。

**分工建议**：

| 场景 | 放哪里 |
|---|---|
| 团队约定的视觉模型、并发 | 项目 `.prism/prism.jsonc`，提交进 git |
| 个人临时偏好（如调整并发） | 用户 `~/.prism/prism.jsonc`，不提交 |
| 一次性实验/QA | 环境变量 `PRISM_CONFIG=/path/to/config.jsonc` |

## 配置

项目 `.prism/prism.jsonc` 覆盖用户 `~/.prism/prism.jsonc` 覆盖内置默认值（环境变量 `PRISM_CONFIG` 可指向任意配置文件，QA 用）：

```jsonc
{
  "vision": {
    "model": "",                                 // provider/model + 可选 variant；空字符串 = 继承主会话模型（默认）
    "mode": "sync",                              // sync | background
    "tools": ["read"]                            // 可选：只拦这些工具的输出；不填 = 所有工具
  },
  "background": {
    "concurrency": 5                             // 每个 provider/model 的并行上限
  }
}
```

会话模型零配置：后台任务、/split 子任务和**视觉解读**（未配置 `vision.model` 时）都**继承主会话当前模型**，主会话切模型后自动跟随。视觉继承走 `chat.params` hook 的 `capabilities.input.image`——与 opencode 运行时判断"能否收图"用的是同一个信号：主会话模型支持图片就自动启用，不支持就直接跳过（不创建子会话、不开后台任务），模型切换即时生效。配置非法（引用格式错误）时视觉保持关闭。

其余全部走固定默认值：单次视觉解读上限 4 张图片、60s 视觉超时（超时不重试）、后台任务排队超 30 分钟自动取消（**运行中任务超时只告警不取消**，长任务不会被误杀）、3s 轮询等。旧配置里的 `tmux` 节会被静默忽略（tmux pane 可视化已移除，子任务可见性走 toast + 完成通知 + `/bg output --full` 的 attach 提示）。

## 命令与工具

| 接口 | 用法 |
|---|---|
| `/bg <描述> [--parallel N]` | 启动后台任务（--parallel 拆 N 个并行子任务） |
| `/bg status \| output <id> \| cancel <id> \| resume <id> <追问>` | 查询/取消/续问（插件原生执行；resume 在已结束任务的子会话里继续追问，保留其上下文） |
| `/split <任务> [--dry-run] [--sequential] [--max N]` | 复杂任务拆分并发执行 |
| `/split status \| output <id> \| cancel <id>` | 同上 |
| `bg_spawn / bg_output / bg_cancel` | 模型中途可用的工具接口 |
| `vision_look(images: [url/路径/"last"], goal?)` | 手动视觉解读；`"last"` = 本会话最近的图片，goal = 只回答关注点相关内容 |
| `/vision <路径/URL ... \| last> [--goal <关注点>]` | 命令式视觉解读（插件原生执行，结果直接注入对话） |

## 模型语义

- **会话模型**：三级获取（`session.get` 的 data.model → 父会话最新消息的 info.model → opencode 配置默认模型），每次启动后台任务时读取，主会话 `/models` 切换后新任务自动跟随
- **视觉模型**：显式 `provider/model` 配置；未配置时继承主会话当前模型（`chat.params` 的 `capabilities.input.image` 门控，模型切换自动跟随）。不探测连接状态，不可用即优雅降级：解读失败留图给主模型，重试耗尽后图片保留在主上下文。配置了不支持图片的模型会在解读阶段失败并重试耗尽
- **重试**：可重试错误（限流/5xx/超时）**同模型重建会话重试 1 次**，再失败报错；没有换 provider、没有换模型

## 内部消息注入闸门

所有发往父会话的内部消息（完成通知、split 汇总）只走 `PromptGate`：按会话预留、同文本去重、会话活跃时等待 settle、失败可重排。这是防止重复注入的核心纪律。

单任务完成时，通知会把**完整结果**注入父会话（上限 20k 字符，超出截断并附 `bg_output` 指引）；批量任务保持逐条 200 字符预览 + `bg_output` 指针，避免多份完整结果刷屏。

## 日志与静默错误

Prism 不向控制台输出任何内容（插件与 TUI 同进程，stderr 会漏进界面）。日志写入 `~/.local/share/opencode/log/prism.log`（跟随 `XDG_DATA_HOME`，可用 `PRISM_LOG_FILE` 覆盖）。所有 hook 经 `guardHook` 包裹：内部错误只进日志文件，绝不以 opencode 的 `Session.Event.Error` 形式弹到 TUI；视觉/规划器/拆分等核心路径同样捕获网络拒绝并优雅降级。

## 目录结构

```
src/
├── index.ts            # 插件装配：模型解析、hooks/tools/commands 接线、dispose
├── config/             # zod schema（vision/background）、JSONC 解析、加载与合并
├── models/             # provider/model 解析、错误分类
├── core/
│   ├── prompt-gate.ts  # 内部消息注入闸门（唯一通道）
│   ├── background/     # 后台引擎：manager / concurrency / 状态机
│   ├── vision/         # 视觉管线：detector / interpreter / pipeline
│   └── split/          # 拆分：planner / scheduler（DAG）/ service
├── hooks/              # tool.execute.after / chat.params / event / command.execute.before
├── tools/              # bg_spawn / bg_output / bg_cancel / vision_look
└── commands/           # /bg /split 模板
tests/                  # bun:test 单测（与 src 同构）
scripts/qa/             # 隔离 XDG 沙箱 QA 脚本
docs/qa/                # 每次 harness 验证的证据记录
```

## 开发

```bash
bun install
bun test        # 单测：并发、gate、模型解析、split DAG、视觉管线
bun run typecheck
bun run build   # dist/index.js
```

## QA

Harness 级验证在隔离 XDG 沙箱进行，不碰真实 `~/.local/share/opencode`：

```bash
scripts/qa/sandbox-run.sh   # 隔离 XDG + 本地插件路径 + opencode run，grep 沙箱内 prism.log 初始化日志
```

QA 记录：`docs/qa/`（每次 harness 验证一份）。

## 已知边界

- **`opencode run` 非交互模式**：主会话结束后进程退出，未完成的后台任务会被 dispose 中止。TUI 模式不受影响。修复方向：CLI run 模式的 continuation marker（保持未完成 todo 直到后台任务清空）。
- **插件实例重启（opencode 重启/升级/崩溃后重开）**：在途后台任务不跨实例存活——新实例没有旧任务的记录，旧子会话在服务端继续运行但不再被管理（完成通知不会到达）。重启前请先等待任务结束或手动 `/bg cancel`。

后台任务归属当前会话：`/bg status`、`/bg output`、`bg_output`、`bg_cancel` 只能访问发起会话自己的任务（子任务会话不能读取或取消其他会话的任务）。`/bg cancel` 与 `/split cancel`（不带任务 id）可整体取消当前会话的全部后台任务。

## 版本历史

见 [CHANGELOG.md](./CHANGELOG.md)。
