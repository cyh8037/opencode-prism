# AGENTS.md — Prism 仓库 Agent 协作契约

本文件是 AI Agent 在本仓库工作的**最高工程契约**。修改代码与提交前必须严格遵循。

---

## 1. 项目定位与硬性边界 (Boundaries)

**Prism (`opencode-prism`)** 是 OpenCode 的多模型赋能插件，提供三大核心能力：
- **视觉解读 (`Vision`)**：工具输出附图自动解读（经 `messages.transform` 两阶段） + `vision_look` 手动解读。
- **后台并行 (`Background`)**：`/bg` 命令与 `bg_*` 工具在独立子会话并行运行，支持 `bg_send` 投递指令、`bg_wait` 阻塞等待、完成通知回注主会话。
- **任务拆分 (`Split`)**：`/split` / `split_task` 复杂任务依赖图（DAG）调度与合并，依赖满足即启动（ASAP），完成后汇总回注。

### 🚨 绝对红线 (Zero-Tolerance Rules)
1. **零额外运行时依赖**：生产依赖**仅限** `@opencode-ai/plugin` 与 `zod`（构建时 external），严禁引入任何其他 npm 包；不依赖特定 harness 之外的 API。
2. **Hook 绝不向外抛错**：所有 Hook 必须经 `guardHook` (`src/shared/hook-guard.ts`) 包裹，内部异常仅 `log()` 后吞掉。插件 Hook 抛错会被 OpenCode 发布为会话内错误消息，严重污染 TUI 对话。
3. **禁止控制台输出**：严禁使用 `console.log/error/info`（会漏进 TUI 界面破坏渲染），统一经 `src/shared/log.ts` 写文件（`PRISM_LOG_FILE` 可覆盖）。
4. **主会话消息注入唯一入口**：除 Hook 原生返回值外，所有向主会话注入的内部消息**必须走 `PromptGate`** (`src/core/prompt-gate.ts`)，严禁裸调 `client.session.prompt / promptAsync`。

---

## 2. 架构心智模型与职责地图 (Mental Model)

```
src/
├── index.ts                 # 插件入口: 组装 config → gate → 各服务 → hooks → tools
├── config/                  # 多级配置加载与按字段回退校验
├── core/
│   ├── prompt-gate.ts       # 内部消息注入门控 (同源 reservation / 语义去重 / wait-for-idle / 串行调度 / 拒绝重试)
│   ├── background/          # 后台子会话管理 (并发控制 / 生命周期调度)
│   ├── split/               # 任务拆分 (Planner 规划 -> Plan-Schema -> Scheduler 调度 -> Service)
│   └── vision/              # 视觉流水线 (Pipeline -> Interpreter -> ModelTracker -> Detector)
├── models/                  # 模型引用解析、错误分类
├── hooks/                   # Hook 工厂函数 createXxxHook (单一职责)
├── tools/                   # LLM 可调用工具 (vision_look / bg_* / split_task)
├── commands/                # /bg, /split 命令模板 (config hook 原地注册)
└── shared/                  # 日志 (log)、防护 (hook-guard)、API 错误解析 (api-result) 等横切设施
```

### 核心 Hook 职责速查
| Hook | 触发时机 | 核心职责 | 特殊契约 / 注意事项 |
|---|---|---|---|
| `command-execute-before` | 用户触发命令 | `/bg`、`/split` 命令拦截入口 | 拦截并转交对应引擎调度 |
| `tool-execute-after` | 工具执行返回 | 自动解读 (Trigger A)：拦截带图片附件的工具输出 | 受视觉三重门控硬拦截 |
| `chat-message` | 消息发送前 | 贴图提示：为无图模型注入调用 `vision_look` 提醒（零阻塞） | **必须满足 Part 字段完整性契约** |
| `chat-params` | 生成对话参数 | 只读：喂 `CurrentModelTracker`（追踪当前模型与多模态能力） | 只读消费，不改参数 |
| `event` | OpenCode 事件流 | 转发后台引擎消费的事件子集；`session.deleted` 时清理 Gate / Tracker 状态 | 监听会话生命周期 |
| `config` | 插件初始化 | 原地注册 `/bg`、`/split` 命令模板 | **原地修改 `configInput`，返回值被丢弃** (1.18 验证) |

---

## 3. 核心架构不变量 (Invariants / 承重墙)

> ⚠️ **警告**：以下设计是多次事故与踩坑后定型的核心机制，**严禁以「代码重构 / 简化 / 消除重复」为由改动**！

### 3.1 视觉门控三重冗余 (Triple-Gate Defense)
- `config.vision.enabled: false` 为完全关闭：`vision_look` 不注册、自动解读不触发。
- 门控检查在 `tool-execute-after`、`getVisionModel` (`src/index.ts`)、`pipeline.onToolOutput` **三处硬编码重复**，每处注释互相点名。禁止以“去重”为由删减任何一处。

### 3.2 子会话工具隔离与递归防护 (Recursion Defense)
- **工具列表硬过滤**：
  - 后台子会话恒禁用 `bg_*` 与 `question`（`manager.ts` 的 `childToolFilters`）；`vision_look` 在视觉启用时保留（支持 async 视觉任务解读自身图片），视觉禁用时移除。
  - 同步解读子会话使用 `VISION_CHILD_TOOL_FILTERS` 禁用全部 Prism 工具 + `question`。
- **运行时守卫承重**：递归防护的核心承重墙是运行时守卫 `isInterpretationSession`（在 `vision-look`、`pipeline.onToolOutput`、`chat-message` 三处生效）。**删除守卫必然复发 0.4.0-beta.1 递归风暴事故**。

### 3.3 消息构造与客户端调用契约
- **Chat-Message Part 契约**：在 `chat-message` 中动态 `push` 的 part **必须**携带 `id`（带 `prt_` 前缀）、`sessionID`、`messageID`（取自 `output.message.id`）。缺少字段会导致持久化失败（"invalid user part before save" 导致会话冻结事故，2026-08-25）。
- **Client 4xx/5xx 契约**：OpenCode Client 调用的 4xx/5xx 错误会被解析为 `{ error }` 而不是 reject。
  - 必须统一使用 `errorInfoFromResult` (`src/shared/api-result.ts`) 判定失败。
  - Resolved rejection 是**唯一**安全可重试的失败类；Thrown error 说明请求可能已送达，禁止盲目重试，防止主会话重复注入。

### 3.4 模型继承与配置回退
- **模型继承三级回退链**：`Session 对象` → `最新消息 info.model` → `Config 默认模型`。主会话 `/models` 切换后新任务自动跟随。
- **配置按字段回退**：无效字段单独回退默认值，同节其他有效设置保留（例如 `vision.mode: "background"` 仅将 mode 回退为默认值，启动时弹出 warning toast）。
- **版本行为依赖标注**：凡依赖 OpenCode 具体版本行为的代码（如 `session.status` 的 busy/retry 字段，1.18 验证），必须在注释中显式注明验证版本。

---

## 4. 开发与测试准则 (Development Standards)

### 环境与语言规范
- **Runtime**：纯 Bun 环境（`bun test` / `bun run typecheck` / `bun run build`）。
- **TypeScript**：Strict 模式，开启 `noUncheckedIndexedAccess`，必须使用 `verbatimModuleSyntax`（类型导入统一用 `import type`）。
- **提交规范**：Conventional Commits（`feat:`, `fix:`, `chore:`, `release:`），无语言强制（仓库现状为中文）。
- **禁止自动提交**：代码实现、修复或审查收尾即止，**未经用户在当前指令中明确要求，Agent 不得执行 `git commit`**（push 同理）。完成标志是"代码 + 测试 + QA 证据 + 文档就绪、工作区留待用户检视"，提交时机、拆分方式与提交信息由用户决定；用户要求提交时才按上述提交规范执行。

### 常用命令速查
```bash
bun test                  # 运行全部单元测试
bun test tests/vision.test.ts # 运行特定单测
bun run typecheck         # 静态类型检查 (tsc --noEmit)
bun run build             # 构建打包 → dist/
```

### 测试与 QA 准则（硬性契约）
1. **"typecheck 通过" ≠ 完成**：单元测试无法覆盖真实的 OpenCode 插件生命周期与注入行为。
2. **测试严格划界**：
   - **单元测试 (`tests/*.test.ts`)**：**只测纯逻辑**（Schema 解析、状态机调度、拓扑排序、配置回退规则）。严禁对 LLM 文本输出、消息时序做脆弱断言。
   - **真实环境 QA (`scripts/qa/sandbox-run.sh`)**：凡涉及 Hook 触发、子会话生命周期、消息回注的改动，**必须在沙箱中跑真实验证**。
3. **证据写盘交付**：
   - 真实验证结论必须写入 `docs/qa/YYYY-MM-DD-<主题>.md`（包含改动范围、验证步骤、实际输出）。**无 QA 证据文件不提交代码**。
4. **文档同步**：用户可感知改动（配置、命令、工具、行为）必须同步更新 `README.md` 与 `CHANGELOG.md` [Unreleased]。

---

## 5. 配置与发布流程

### 配置加载优先级
1. 项目级 `.prism/prism.jsonc`（自当前工作目录向上逐级查找至 `$HOME`，`$HOME` 自身跳过）
2. 用户级 `~/.prism/prism.jsonc`
3. 插件内置默认配置
*(一次性实验可通过环境变量覆盖：`PRISM_CONFIG=/path/to/config.jsonc`)*

### 发布流程
1. 更新 `CHANGELOG.md`（遵循 Keep a Changelog 规范，中文）。
2. 在 `package.json` 更新版本号（如 `0.4.0-beta.2`）。
3. 提交独立 Release 提交（如 `release: 0.4.0-beta.2`）。
