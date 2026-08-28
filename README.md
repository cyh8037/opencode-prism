# Prism

OpenCode 插件：视觉自动解读、后台并行 Agent、复杂任务拆分。

- **视觉解读**：工具输出里的图片自动解读并追加到工具输出（落会话历史）；`vision_look` 工具手动解读任意图片（URL / 本地路径 / 会话贴图），支持 `goal` 关注点。未配置模型时继承主会话当前模型
- **后台并行**：`/bg` 命令与 `bg_*` 工具在独立子会话并行执行（继承主会话模型）；可中途投递补充指令（`bg_send`）、续跑已结束任务、阻塞等待（`bg_wait`）；完成通知与结果自动回注主会话
- **任务拆分**：`/split` 命令（经主模型调用 `split_task` 工具执行，输入后立即流式反馈）与 `split_task` 工具把复杂任务拆成带依赖的子任务图，各任务在自己的依赖完成后立即启动（ASAP，不等整波），全部完成后汇总回注

## 安装

要求 **opencode ≥ 1.15.0**（会话创建的 `model` 字段从 1.15 起才被服务端接受；更早版本插件可加载，但后台子会话无法继承主会话模型）。

### npm（推荐）

包已发布到 npm：[`opencode-prism`](https://www.npmjs.com/package/opencode-prism)。在全局配置 `~/.config/opencode/opencode.json` 的 `plugin` 数组中声明包名，opencode 启动时通过 Bun 自动拉取并缓存（`~/.cache/opencode/node_modules/`）：

```jsonc
{
  "plugin": ["opencode-prism"]
}
```

- 也可先执行 `npm install -g opencode-prism`（可选）提前把包装到本机；只写配置、不执行 npm 命令同样有效
- 固定版本在数组里写 `opencode-prism@<version>`（以 npm 实际版本为准）；升级时更新版本号或删除缓存目录后重启 opencode
- 重启后输入 `/bg status`、`/split <任务> --dry-run` 任一命令即可验证插件已加载

### 项目级（团队共享）

插件引用和 prism 配置都放进项目仓库，打开项目的每个人自动获得相同行为。项目根目录 `opencode.json`：

```jsonc
{
  // 直接写包名（opencode 启动时自动安装）；开发期也可指向本地路径 "/path/to/prism"
  "plugin": ["opencode-prism"]
}
```

团队约定（视觉模型、并发等）写进项目 `.prism/prism.jsonc` 随仓库提交；个人偏好放用户级 `~/.prism/prism.jsonc` 不提交；一次性实验用环境变量 `PRISM_CONFIG=/path/to/config.jsonc`。

### 本地开发

全局或项目配置中直接引用本地路径（改动即生效，无需发布）：

```jsonc
{
  "plugin": ["/path/to/prism"]
}
```

## 配置

项目 `.prism/prism.jsonc` 覆盖用户 `~/.prism/prism.jsonc` 覆盖内置默认值。项目配置从项目根目录向上逐级查找 `.prism/prism.jsonc`（到 `$HOME` 为止，最近的生效），任何层级都可以只写需要覆盖的部分：

```jsonc
{
  "vision": {
    "enabled": true,                             // 总开关；false 完全关闭（vision_look 不注册、自动解读不触发）
    "model": "",                                 // provider/model（如 "openai/gpt-4o"）；空字符串 = 继承主会话模型（默认）
    "mode": "sync",                              // sync | async（async = 投后台任务异步解读，完成后通知回注）
    "tools": ["read"]                            // 可选：只拦这些工具的输出；不填 = 所有工具；[] = 不触发自动解读
  },
  "background": {
    "concurrency": 5                             // 每个 provider/model 的并行上限
  },
  "split": {
    "tool": true                                 // split_task 工具与 /split 命令的执行入口；false = 两者都不注册
  }
}
```

会话模型零配置：后台任务、/split 子任务和**视觉解读**（未配置 `vision.model` 时）都**继承主会话当前模型**，主会话 `/models` 切换后新任务自动跟随。视觉继承用与 opencode 运行时相同的图片能力信号：主会话模型支持图片就自动启用，不支持则跳过（不会创建子会话或后台任务）。

配置校验按字段回退：无效配置项（如过时的 `vision.mode: "background"`）单独回退默认值，**同节其他有效设置保留**，启动时弹出配置警告 toast（详情见插件日志）。`vision.enabled: false` 是完全关闭的显式开关（区别于"没有可用模型时的自然关闭"：前者连 `vision_look` 工具都不注册，自动解读也不触发）。

其余默认值与运行规则见各功能小节：「视觉解读」的限制与降级、「后台并行任务」的运行规则。旧配置里的 `tmux` 节会被静默忽略（tmux pane 可视化已移除）。

## 功能使用

### 视觉解读

两种触发方式，解读结果全部落入会话历史：

**1. 自动解读（工具输出）**：`vision.mode = "sync"`（默认）下，带图片附件的工具输出（如截图工具）在返回给主模型前自动追加 `[prism vision]` 解读文本；`mode = "async"` 则改为启动一个后台视觉任务异步解读（不阻塞工具输出，完成后经通知回注）。`vision.tools` 可限定只拦截哪些工具（缺省 = 所有工具，`[]` = 不触发自动解读）。

**2. `vision_look` 工具（模型调用）**：主模型遇到无法直接读取的图片时自主调用；入参支持路径字符串或数组；`"last"` 哨兵表示"本会话最近的图片"——纯文本主模型靠它读取用户贴图；`[Image N]` 附件占位符自动按 `"last"` 提取会话贴图；`goal` 参数指定关注点，解读只回答与关注点相关的内容（信噪比更高、更省上下文，建议始终提供）。

- 图片来源支持：本地路径（相对路径按项目目录解析、`~/` 展开，Windows 风格 `C:\`、`.\`、`~\` 均可）、http(s) URL（仅此两协议会 fetch，`file://` 等一律拒绝）、data URL

**限制与降级**：单批 ≤ 4 张、单图 ≤ 4MB、批次 base64 总负载 ≤ 16MB，超限图片跳过、批次保留装得下的部分；内容按魔数校验（声称的 mime 不被信任）。单次解读 60s 超时不重试，失败按真实原因提示（无可用模型 / 引用无效 / 会话失败 / 无输出 / 超时各有明确说明），图片保留在主上下文兜底。

### 后台并行任务

**启动与管理**：

```text
/bg 重构 auth 模块并补齐单测                 # 启动一个后台子会话（继承主会话模型）
/bg 调研三个竞品的定价 --parallel 3          # 拆 3 个并行子任务
/bg status                                  # 当前会话任务表（状态/模型/工具调用/排队指令）
/bg output bg_ab12cd34                      # 查看结果与错误信息
/bg output bg_ab12cd34 --full               # 附 opencode attach 提示，可回看完整子会话
/bg cancel bg_ab12cd34                      # 取消单个任务
/bg cancel                                  # 取消当前会话的全部任务
```

**中途投递与续跑（steering）**：

```text
/bg send bg_ab12cd34 不要改公共类型定义，用适配器包一层   # 运行中 → 排队到回合边界投递，不打断执行
/bg resume bg_ab12cd34 继续展开第二步                      # 已结束 → 在原子会话里续跑（保留上下文）
```

- **运行中/排队中任务**：消息排队，在子会话**当前回合结束的边界**合并为一次补充回合投递（可观察的最细粒度是回合边界）；排队中任务的补充指令直接并入首轮启动 prompt。队列有界：单个任务未投递的补充指令超过 10 条时拒绝新消息（报错等待下一轮投递），单条消息超过 32KB 自动截断（记录到插件日志）
- **已结束任务**：等同续跑。模型组并发槽被长任务占满时最多等待 15 秒，超时返回可稍后重试的错误提示（不会无限挂起）；等待期间取消该任务会立即解除挂起
- 投递失败自动重试（上限 3 次，超限放弃并 toast 告知，期间新排队的消息不受影响）；成功投递重置该回合的工具调用预算与 30 分钟 TTL。**已承诺"排队"的补充指令绝不静默丢失**——完成判定会让位于仍在排队的消息，投递与结算竞争时消息会随下个回合边界送达

**模型侧工具**（主模型可在对话中途自主调用）：

| 工具 | 用法 |
|---|---|
| `bg_spawn(description, prompt, agent?)` | 启动后台任务（`agent` 可选，指定 opencode agent） |
| `bg_output(taskId)` | 读取任务结果 |
| `bg_cancel(taskId)` | 取消任务 |
| `bg_send(taskId, message)` | 中途投递补充指令（语义同 `/bg send`） |
| `bg_wait(taskIds?, timeoutMs?)` | 阻塞等待任务终态（缺省 = 当前会话全部未结束任务；默认 120s、上限 600s）——模型总结前等待并行任务完成用 |

**运行规则**：每个 provider/model 并发上限 5（可配）；失败自动**同模型重建会话重试 1 次**（限流/5xx/超时类错误）；排队超 30 分钟自动取消，**运行中超时只告警不取消**，但无任何输出活动超 30 分钟的挂起任务会被看门狗取消；单任务工具调用上限 4000（防失控循环）。

### 任务拆分

```text
/split 把首页迁移到新设计系统 --dry-run      # 只看计划：按依赖分波展示，不执行
/split 把首页迁移到新设计系统               # 规划 → 按依赖并发执行 → 完成后汇总回注
/split 大重构 --sequential                  # 串行执行（按计划顺序逐个启动）
/split 大重构 --max 6                       # 子任务数上限（2-12，越界自动钳制）
/split status | output <id> | cancel <id> | cancel   # 任务管理同 /bg
```

- **执行方式**：任务描述由主模型调用 `split_task` 工具执行（输入命令后立即流式响应，规划在工具执行中完成，界面全程有反馈）；旗标由模型对应传参（`--dry-run` → `dry_run`、`--sequential` → `sequential`、`--max N` → `max`）；status / output / cancel 由插件原生执行
- **流程**：规划器（用主会话模型）拆出带依赖的子任务 DAG → 调度器按依赖 ASAP 启动 → 全部结束后汇总报告回注主会话（含每个子任务的状态、错误与结果预览）
- **失败级联**：上游子任务失败/取消或**启动失败**时，依赖它的下游全部标记 `SKIPPED`（不基于空结果继续执行），报告中注明原因
- **`split_task` 工具**：既是 `/split` 命令的执行入口，也可由主模型自主发起（适合多步骤、多文件、有依赖顺序的复杂任务）；`split.tool: false` 同时关闭工具与 `/split` 命令

## 模型语义

- **会话模型**：每次启动后台任务时读取主会话当前模型（`session.get` → 最新消息 → opencode 配置默认，三级兜底），主会话 `/models` 切换后新任务自动跟随
- **视觉模型**：显式 `provider/model` 配置或继承主会话当前模型；不探测连接状态，不可用即优雅降级（解读失败留图给主模型）。配置了不支持图片的模型会在解读阶段失败并重试耗尽
- **重试**：见「后台并行任务」运行规则——可重试错误（限流/5xx/超时）**同模型重建会话重试 1 次**，不换 provider、不换模型

## 通知与日志

- **通知**：所有发往父会话的内部消息（完成通知、split 汇总）只走 `PromptGate`——防重复注入（同文本去重）、会话活跃时等待投递、失败自动重排。单任务完成注入**完整结果**（上限 20k 字符，超出截断附 `bg_output` 指引）；批量任务发逐条结果预览表 + `bg_output` 指针
- **日志**：Prism 不向控制台输出任何内容（与 TUI 同进程，stderr 会漏进界面），全部写文件：`~/.local/share/opencode/log/prism.log`（跟随 `XDG_DATA_HOME`；Windows 为 `%APPDATA%\opencode\log\prism.log`），`PRISM_LOG_FILE` 可覆盖。所有 hook 经 `guardHook` 包裹：内部错误只进日志，绝不以 opencode 的 `Session.Event.Error` 形式弹到 TUI

## 已知边界

- **`opencode run` 非交互模式**：主会话结束后进程退出，未完成的后台任务会被 dispose 中止（TUI 模式不受影响）。缓解：让模型收尾前调用 `bg_wait` 把回合撑到后台任务清空
- **插件实例重启**（opencode 重启/升级/崩溃后重开）：在途后台任务不跨实例存活——旧子会话在服务端继续运行但不再被管理。重启前请先等待任务结束或 `/bg cancel`

后台任务归属当前会话：`/bg status`、`/bg output`、`bg_output`、`bg_cancel` 只能访问发起会话自己的任务；`/bg cancel` 与 `/split cancel`（不带任务 id）可整体取消当前会话的全部后台任务。

## 开发

```bash
bun install
bun test        # 单测：并发、gate、模型解析、split DAG、视觉管线
bun run typecheck
bun run build   # dist/index.js
```

目录结构：

```
src/
├── index.ts            # 插件装配：hooks/tools/commands 接线、dispose
├── config/             # zod schema（vision/background/split）、JSONC 解析、加载合并
├── models/             # provider/model 解析、错误分类
├── core/
│   ├── prompt-gate.ts  # 内部消息注入闸门（唯一通道）
│   ├── background/     # 后台引擎：manager / concurrency / 状态机
│   ├── vision/         # 视觉管线：detector / interpreter / pipeline
│   └── split/          # 拆分：planner / scheduler（DAG）/ service
├── hooks/              # tool.execute.after / chat.params / event / command.execute.before
├── tools/              # bg_* 五件套 / vision_look / split_task
├── commands/           # /bg /split 命令模板
└── shared/             # 日志、hook 守卫、server-url、API 结果解析
tests/                  # bun:test 单测（与 src 同构）
scripts/qa/ 与 docs/qa/ # 隔离 XDG 沙箱 QA 脚本与验证记录
```

QA 级验证在隔离 XDG 沙箱进行（`scripts/qa/sandbox-run.sh`），不碰真实 `~/.local/share/opencode`。

## 版本历史

见 [CHANGELOG.md](./CHANGELOG.md)。

## License

MIT，见 [LICENSE](./LICENSE)。
