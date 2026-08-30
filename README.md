# Prism (`opencode-prism`)

[中文文档](./README.md) · [English Documentation](./README_EN.md)

OpenCode 多模型工程赋能插件：视觉图文自动解读、后台子会话并行、基于依赖有向无环图（DAG）的任务拆分与异步调度执行。

---

## 快速上手 (Quick Start)

### 1. 安装插件
在全局配置 (`~/.config/opencode/opencode.json`) 或项目根目录 `opencode.json` 中添加 `opencode-prism`（要求 **OpenCode ≥ 1.15.0**）：

```jsonc
{
  "plugin": ["opencode-prism"]
}
```
*启动 OpenCode 时，系统将通过 Bun 自动下载并缓存插件。*

### 2. 验证安装
重启 OpenCode 并运行任意 Prism 命令进行验证：

```text
/bg status
/split "重构认证模块并补充单元测试" --dry-run
```

---

## 核心能力 (What This Is)

Prism 将 OpenCode 拓展为多 Agent 协同编排引擎，且保持零额外运行时依赖：

- **视觉解读流水线 (Vision)**：工具输出附图自动解读 + 目标导向的 `vision_look` 手动解读（支持对话贴图 `"last"` 哨兵）。
- **原生后台并行引擎 (Background)**：`/bg` 命令原生极速拦截执行、图片附件自动转发、运行中指令投递（`bg_send`）与阻塞屏障等待（`bg_wait`）。
- **任务依赖拆分与调度 (Split)**：`/split` 将复杂任务拆分为依赖 DAG，具备意图门控检测，并在前置依赖满足时立即启动子任务（ASAP 并发），自动聚合结果回注。
- **GFM 管道表格可视化**：跨 TUI（等宽字符对齐）与 Web 端（HTML 原生表格解析，解决 CJK 字体比例错位）完美渲染状态看板。
- **加固注入门控 (`PromptGate`)**：子会话向主会话注入结果的唯一安全入口，具备同源预约、回合去重、空闲等待与指数退避重试。

---

## 架构设计 (Architecture)

```
                       ┌───────────────────────────────────────────────┐
                       │              OpenCode Host (TUI / Web)        │
                       └───────────────────────┬───────────────────────┘
                                               │
               ┌───────────────────────────────┴───────────────────────────────┐
               │                  Prism 插件引擎 (`index.ts`)                   │
               │                                                               │
               │   Hooks: command-execute-before · tool-execute-after          │
               │          chat-message · chat-params · event · config          │
               └───────┬───────────────────────┬───────────────────────┬───────┘
                       │                       │                       │
         ┌─────────────▼─────────────┐   ┌─────▼─────────────┐   ┌─────▼─────────────┐
         │     Background Manager    │   │ Split DAG Service │   │  Vision Pipeline  │
         │   (并发控制 / 调度队列 /   │   │(意图检测 / 规划器 / │   │ (自动解读 / 探测 / │
         │      TUI 会话导航)        │   │    ASAP 调度器)   │   │    模型追踪器)    │
         └─────────────┬─────────────┘   └─────┬─────────────┘   └─────┬─────────────┘
                       │                       │                       │
                       └───────────────────────┼───────────────────────┘
                                               │
                               ┌───────────────▼───────────────┐
                               │   PromptGate (单一注入入口)   │
                               │  (预约 / 去重 / 空闲重试)     │
                               └───────────────┬───────────────┘
                                               │ (结果聚合回注)
                               ┌───────────────▼───────────────┐
                               │       主会话 (Parent Chat)     │
                               └───────────────────────────────┘
```

| 引擎分层 | 核心模块 | 职责说明 |
|---|---|---|
| **命令与拦截层** | `command-execute-before` | 拦截 `/bg` 与 `/split`，无需消耗 LLM 回合即可原生完成任务创建、查询与取消。 |
| **后台执行核心** | `BackgroundManager` | 管理子会话生命周期、模型并发槽位池、运行中指令队列及异常恢复。 |
| **任务编排核心** | `SplitService` & `Scheduler` | 评估任务拆分必要性、生成拓扑依赖 DAG，并在前置依赖就绪后 ASAP 触发执行。 |
| **多模态视觉核心** | `VisionPipeline` | 拦截工具输出图片、魔数校验格式并建立独立同步/异步解读子会话。 |
| **主会话门控** | `PromptGate` | 串行化、去重并受控分发后台完成通知与聚合报告至主会话。 |

---

## 功能组件 (Components)

| 分类 | 组件名称 | 功能描述 |
|---|---|---|
| **命令** | `/bg` | 原生后台任务管理：启动、状态监控、指令投递（`send`/`resume`）及取消。 |
| **命令** | `/split` | 原生任务拆分：意图检测、dry-run 预审、DAG 依赖并发执行与状态看板。 |
| **工具** | `bg_spawn` | 显式或自主触发启动独立后台子会话（自动继承主会话模型）。 |
| **工具** | `bg_output` | 查询后台任务执行进度、工具调用数、待投递指令队列及执行结果。 |
| **工具** | `bg_send` | 向运行中任务投递调整指令（回合边界投递）或恢复已完成会话继续对话。 |
| **工具** | `bg_cancel` | 中止后台子任务并立即释放并发槽位。 |
| **工具** | `bg_wait` | 阻塞式屏障等待，用于在汇总前等待全部或指定后台任务完成。 |
| **工具** | `split_task` | 将多步骤、多模块复杂任务拆解为 DAG 并行执行并自动聚合回注。 |
| **工具** | `vision_look` | 专用图片检查工具，支持对话附图（`"last"`）、本地路径、远程 URL 及 `[Image N]` 占位符。 |
| **可视化** | `renderBgDashboard` | 渲染 GFM 管道表格，展示后台任务运行状态与模型并发资源池占用。 |
| **可视化** | `renderSplitDag` | 渲染基于 Wave 轮次与依赖树结构的 DAG 任务拆分看板。 |

---

## 核心工作流与用法 (Workflows & Usage)

### 1. 后台并行 (`/bg`)

在独立子会话中并发执行耗时调研、测试或子模块开发：

```text
/bg 重构认证模块并补充单元测试                       # 原生启动：立即返回任务 ID
/bg 调研竞品 API 差异 --parallel 3                   # 模型辅助：拆解为 3 个并发子任务
/bg 分析当前架构图 [附带截图]                         # 自动将当前消息中的图片转发至子会话
/bg status                                           # 渲染 GFM 管道状态表格看板
/bg status --all                                     # 查看包含已终止任务在内的完整历史
/bg status bg_a1b2c3d4e5f6                           # 查看指定任务的详细进度与工具调用
/bg output bg_a1b2c3d4e5f6                           # 获取任务输出、错误与结果摘要
/bg output bg_a1b2c3d4e5f6 --full                    # 附带 opencode attach 调试指令
/bg send bg_a1b2c3d4e5f6 "注意不要修改公开 API 签名"  # 运行中调整：在下一个回合边界投递
/bg resume bg_a1b2c3d4e5f6 "继续执行第二阶段"         # 在已结束的子会话中继续推进
/bg cancel bg_a1b2c3d4e5f6                           # 取消指定的后台任务
/bg cancel                                           # 取消当前会话下的所有排队/运行中任务
```

#### 状态看板示例 (`/bg status`)
```text
PRISM BACKGROUND TASKS (Running: 2, Queued: 1)
| ID              | Description      | Status     | Duration | Progress |
| --------------- | ---------------- | ---------- | -------- | -------- |
| bg_a1b2c3d4e5f6 | 重构认证模块      | RUNNING    | 42s      | 12 calls |
| bg_e5f6a7b8c9d0 | 执行 E2E 测试    | RUNNING    | 18s      | 3 calls  |
| bg_9f8e7d6c5b4a | 压测数据库        | QUEUED     | -        | queued   |

+ 3 finished: 2 COMPLETED, 1 CANCELLED (Use /bg status --all to see full history)
Pool: anthropic/claude-3-7-sonnet: 2/5 running
```

#### TUI 实时子会话导航
每个后台任务均运行在真实的 OpenCode 子会话中（命名为 `[bg_xxxxxxxx] Description (prism)`）：
- 在 OpenCode TUI 中，按下 **`Ctrl+X` 后按 `↓`** 即可实时查看子会话输出流。
- 使用 `←` / `→` 在各运行中子任务间快速切换，按 `↑` 返回主会话。
- 以上为 TUI 默认键位（可通过 opencode 的 `keybinds` 配置自定义）。

---

### 2. 复杂任务拆分 (`/split`)

将多步骤架构改造或跨模块任务拆解为拓扑依赖执行图：

```text
/split "将登录页重构为 Tailwind CSS" --dry-run        # 仅生成并预览拆分计划，不实际执行
/split "将登录页重构为 Tailwind CSS"                  # 规划 -> 依赖 DAG 执行 -> 聚合汇总
/split "大型模块重构" --sequential                   # 强制按顺序串行执行子任务
/split "大型模块重构" --max 6                        # 限制子任务最大数量 (2–12)
/split status                                        # 查看当前活跃拆分运行的 DAG 状态树
/split status sp_7f8a9b0c                            # 查看指定 run 的详细依赖状态
/split cancel sp_7f8a9b0c                            # 取消整组拆分，依赖任务标记为 SKIPPED
```

#### DAG 依赖结构示例 (`/split status`)
```text
[prism split] sp_7f8a9b0c (1/4 tasks finished)

  Wave 1 (无前置依赖，立即并行启动)
  [t1] 提取通用组件库                 COMPLETED (35s, 8 tools)
  [t2] 升级 Tailwind 配置文件         RUNNING   (15s, 3 tools)

  Wave 2 (依赖 Wave 1，前置满足后 ASAP 启动)
  [t3] 重构 Header 组件              BLOCKED   (Waiting for: t1)
  [t4] 重构 Footer 页面              BLOCKED   (Waiting for: t1, t2)
```

---

### 3. 视觉图文解读 (`vision_look`)

1. **自动拦截解读**：当工具输出包含图片附件（如浏览器截图）时，Prism 在 `messages.transform` / `tool-execute-after` 中自动拦截并追加 `[prism vision]` 视觉解读结论。
2. **主动调用解读 (`vision_look`)**：
   - 对话贴图与截图：`vision_look(images: "last", goal: "提取表单字段与校验规则")`
   - 本地文件：`vision_look(images: ["./docs/arch.png"], goal: "检查组件布局与走线")`
   - 远程 URL：`vision_look(images: ["https://example.com/mockup.png"])`

---

## 配置说明 (Configuration)

配置多级加载与按字段回退优先级：
1. 环境变量覆盖：`PRISM_CONFIG=/path/to/config.jsonc`（具备最高优先级）
2. 项目级配置：`.prism/prism.jsonc`（自当前目录向上递归查找至 `$HOME`）
3. 用户级配置：`~/.prism/prism.jsonc`
4. 插件内置默认配置

```jsonc
{
  "vision": {
    "enabled": true,                             // 视觉主开关（false 时注销 vision_look 工具）
    "model": "",                                 // 指定视觉模型（如 "openai/gpt-4o"）；留空继承主会话模型
    "mode": "sync",                              // "sync"（阻塞等待解读） | "async"（后台子任务解读）
    "tools": ["read"]                            // 拦截的工具列表；缺省全量拦截；[] 禁用自动拦截
  },
  "background": {
    "concurrency": 5,                            // 每个 provider/model 的最大并发子任务数
    "autoTrigger": true                          // 允许模型在长耗时任务中自主调用 bg_spawn
  },
  "split": {
    "tool": true,                                // split_task 工具与 /split 命令主开关
    "intentCheck": true,                         // 快速意图分类，避免简单任务过度拆分
    "autoTrigger": true                          // 允许模型对复杂任务自主调用 split_task
  }
}
```

---

## 权限与安全边界 (Permissions & Safety Boundaries)

| 维度 | 安全与运行时契约 |
|---|---|
| **零额外运行时依赖** | 生产依赖严格锁定为 `@opencode-ai/plugin` 与 `zod`。无任何外部二进制或原生依赖。 |
| **Hook 异常全量吸收** | 全部 Hook 均由 `guardHook` 包裹保护，异常写入日志，绝不抛出至 OpenCode TUI。 |
| **禁止控制台污染** | 严禁 `console.log/error/info`。诊断日志统一写入 `~/.local/share/opencode/log/prism.log`（可通过 `PRISM_LOG_FILE` 覆盖）。 |
| **子会话工具隔离与防递归** | 后台子会话硬禁用 `bg_*` 与 `question` 工具；视觉子会话禁用全部 Prism 工具，彻底阻断递归会话风暴。 |
| **远程图片安全拉取** | 仅拉取 `http://` 与 `https://` 协议，单图上限 4MB，并通过魔数校验真实图片格式。 |
| **单一入会话门控** | 所有向主会话的异步通知均经由 `PromptGate` 统一排队、去重与调度分发。 |

---

## 开发与构建 (Development)

```bash
bun install
bun test              # 运行单元测试（Schema 解析、状态机调度、拓扑排序、可视化看板）
bun run typecheck     # 严格 TypeScript 静态检查 (tsc --noEmit)
bun run build         # 构建打包至 dist/index.js
```

### 源码结构
```
src/
├── index.ts                 # 插件入口：装配配置、门控、各项服务、Hooks 与工具
├── config/                  # 多级 JSONC 配置加载器，支持字段级回退
├── core/
│   ├── prompt-gate.ts       # 主会话 Prompt 注入门控
│   ├── background/          # 后台子会话管理、并发控制池、状态看板
│   ├── split/               # DAG 规划器、意图分类器、ASAP 调度器及服务
│   └── vision/              # 多模态视觉流水线、图片探测、解读器、模型追踪器
├── models/                  # Provider/Model 引用解析与错误分类
├── hooks/                   # command-execute-before, chat-message, tool-execute-after 等
├── tools/                   # 工具定义：bg_spawn, bg_send, bg_wait, split_task, vision_look
├── commands/                # /bg 与 /split 命令模板及参数提示
└── shared/                  # 日志设施、Hook 保护守卫、API 结果解析器、会话数据 Schema
```

---

## 开源协议 (License)

本项目采用 MIT 许可证。详情请参阅 [LICENSE](./LICENSE)。
