# AGENTS.md

本文件是 AI 代理(Claude Code 等)在本仓库工作的唯一契约。改代码前必读。

## 项目是什么

**Prism**(`opencode-prism`):OpenCode 插件,三大能力:
- **视觉解读**:工具输出中的图片自动解读(经 `messages.transform` 两阶段);
  `vision_look` 工具手动解读任意图片
- **后台并行**:`/bg` 命令与 `bg_*` 工具在独立子会话并行执行,支持
  `bg_send` 投递补充指令、`bg_wait` 阻塞等待、完成通知回注主会话
- **任务拆分**:`/split` / `split_task` 把复杂任务拆成带依赖的子任务图,
  依赖满足即启动(ASAP),全部完成后汇总回注

插件边界:**只依赖 `@opencode-ai/plugin` 和 `zod`**(构建时 external)。
不引入其他运行时依赖;不依赖任何特定 harness 之外的 API。

## 架构地图

    src/index.ts                    # 插件入口:组装 config → gate → 各服务 → hooks → tools
    src/config/                     # 多级配置加载与按字段回退校验
    src/core/prompt-gate.ts         # 内部消息注入门控(见不变量 #2)
    src/core/background/            # 后台子会话管理器(并发/生命周期核心)
    src/core/split/                 # 任务拆分:planner → plan-schema → scheduler → service
    src/core/vision/                # 视觉流水线:pipeline → interpreter → model-tracker → detector
    src/models/                     # 模型引用解析、错误分类
    src/hooks/                      # 每个 hook 一个工厂函数 createXxxHook(plugin-input)
    src/tools/                      # vision_look / bg_* / split_task 工具定义
    src/commands/                   # /bg、/split 命令模板(config hook 原地注册)
    src/shared/                     # log、hook-guard、api-result 等横切设施
    tests/*.test.ts                 # bun:test 单元测试(平铺)

hook 职责速查:

| hook | 职责 |
|---|---|
| `tool-execute-after` | 自动解读(trigger A):拦截带图片附件的工具输出 |
| `chat-message` | 贴图提示:给无图模型注入"调 `vision_look`"提醒(零阻塞) |
| `chat-params` | 只读:喂 `CurrentModelTracker`(当前模型 + 图片能力) |
| `event` | 转发后台引擎消费的事件子集;`session.deleted` 时清理 gate/tracker 状态 |
| `command-execute-before` | `/bg`、`/split` 命令入口 |

## 架构不变量(改代码前必读,违反 = 破坏行为)

1. **hook 绝不向插件外抛错**。所有 hook 必须经 `guardHook` 包裹:
   内部失败只 `log()` 后吞掉——插件 hook 抛错会被 opencode 发布成会话内
   错误消息,污染对话。`src/shared/hook-guard.ts`
2. **所有注入主会话的内部消息必须走 `PromptGate`**,禁止裸调
   `client.session.prompt / promptAsync`。gate 承担:同源 reservation、
   语义去重(同一通知不重复唤醒)、wait-for-idle(消息落在回合间隙)、
   dispatchChain 串行化、服务端确认拒绝时的有限重试。
   `src/core/prompt-gate.ts`
3. **子会话工具过滤与递归防护**:后台子会话恒禁用 `bg_*` 与 `question`
   (`manager.ts` 的 `childToolFilters`);`vision_look` 在视觉启用时**保留**
   (async 后台视觉任务需要解读自己的图片),视觉禁用时才移除。同步解读
   子会话另用 `VISION_CHILD_TOOL_FILTERS` 禁用全部 Prism 工具 + question。
   **递归防护的承重机制是运行时守卫 `isInterpretationSession`**
   (`vision-look` / `pipeline.onToolOutput` / `chat-message` 三处)——工具
   过滤只是其中一层,删除守卫 = 复发 0.4.0-beta.1 递归风暴事故。
4. **模型继承按三级回退**:session 对象 → 最新消息的 info.model →
   config 默认。主会话 `/models` 切换后新任务自动跟随。
5. **配置按字段回退**:无效字段单独回退默认值,同节其他有效设置保留
   (如过时的 `vision.mode: "background"` 只回退该字段)。
   启动时弹配置警告 toast。
6. **`vision.enabled: false` 是完全关闭**:`vision_look` 不注册、自动解读
   不触发——区别于"没有可用模型时的自然关闭"。
7. **Client 调用契约:4xx/5xx 解析为 `{ error }` 而不是 reject**。
   resolved-but-rejected 不算成功;且 resolved rejection 是**唯一**安全
   可重试的失败类(thrown error = 请求可能已送达,重试会向主会话重复
   注入)。所有 client 调用用 `errorInfoFromResult`
   (`src/shared/api-result.ts`)判定失败。
8. **vision 门控三重冗余是故意的,禁止"简化"**:`config.vision.enabled`
   的检查在 `tool-execute-after`、`getVisionModel`(index.ts)、
   `pipeline.onToolOutput` 三处重复,每处注释互相点名。不要以"重复"为
   由删任何一处——单点门控会静默重开已关闭的功能。
9. **依赖 opencode 具体版本行为的代码必须注释注明验证版本**(如
   `session.status` 的 busy/retry 字段,1.18 验证)。升级
   `@opencode-ai/plugin` 前必须跑真实环境 QA。
10. **改在途消息 parts 的注入面(chat-message)不走 gate,但有字段契约**:
    push 的 part 必须携带 `id`(`prt_` 前缀)/ `sessionID` / `messageID`,
    否则消息保存死("invalid user part before save",2026-08-25 会话冻结
    事故)。`messageID` 来自 `output.message.id`(TUI 不发,opencode 在
    hook 触发前赋值)。`src/hooks/chat-message.ts:46`
11. **config hook 原地修改 `configInput`,返回值被丢弃**(1.18 验证):
    新命令只能靠原地改 `configInput.command` 注册,写成 return 会静默
    失败(命令不出现、无报错)。`src/index.ts:178`

## 约定

- **Bun only**:测试 `bun test`,类型检查 `bun run typecheck`,构建 `bun run build`
- **strict TS + `noUncheckedIndexedAccess`**,`verbatimModuleSyntax`(type-only 导入用 `type`)
- 测试用 `bun:test` 的 `describe/test`,`tests/` 平铺,`*.test.ts`
- 提交信息**无语言强制**(仓库现状为中文),保持 conventional 前缀:
  `feat:` / `fix:` / `chore:` / `release:`
- 内部失败的边界约定:能降级就降级,降级路径必须 log
- 日志只经 `src/shared/log.ts` 写文件(`PRISM_LOG_FILE` 可覆盖),**禁止
  console.log / console.error**——插件跑在 opencode 服务进程,控制台输出
  会漏进 TUI 界面
- 用户可感知的改动(配置项、命令、工具名、行为)必须同步 README 与
  CHANGELOG[Unreleased],防止文档漂移

## 测试与 QA(硬性契约)

1. **功能实现后必须新会话审查**:实现完一个功能,不得在同一会话内自行
   审查收尾——必须新开会话进行审查(审查会话有干净的上下文,不受实现
   过程的路径依赖影响)。审查通过后才允许提交。
2. **"typecheck 通过" ≠ 完成**。单元测试覆盖不了真实 opencode 的插件
   行为(hook 触发、子会话生命周期、消息回注)。
3. 涉及 hook 触发 / 子会话 / 消息注入的改动,必须跑真实环境验证:
   `scripts/qa/sandbox-run.sh`(沙箱隔离,别污染真实会话)。
4. **证据写盘**:验证结论写入 `docs/qa/YYYY-MM-DD-<主题>.md`
   (参考现有 `docs/qa/2026-08-13-sandbox-qa.md`),包含:改动范围、
   验证步骤、实际输出。没有证据文件的改动不提交。
5. **单元测试只测纯逻辑**:禁止对 LLM 输出文本、消息时序或真实会话行为
   做断言(现有测试全为 schema 解析 / 调度 / 配置等纯逻辑)。这类行为
   由真实环境 QA 覆盖。

## 常用命令

    bun test                  # 全部单元测试
    bun test tests/vision.test.ts
    bun run typecheck         # tsc --noEmit
    bun run build             # bun build → dist/(发布前自动跑)

## 配置系统

- 优先级:项目 `.prism/prism.jsonc`(自会话目录向上逐级查找至 $HOME,
  home 自身跳过)> 用户 `~/.prism/prism.jsonc` > 内置默认
- 项目配置随仓库提交(团队约定);个人偏好不提交
- 一次性实验:`PRISM_CONFIG=/path/to/config.jsonc`
- 注意:`vision.mode` 只有 `"sync" | "async"`;旧值 `"background"` 已弃用

## 发布流程

1. `CHANGELOG.md` 记录用户可感知的变化(Keep a Changelog,中文)
2. 版本号在 `package.json`(如 `0.4.0-beta.2`)
3. 提交形如 `release: 0.4.0-beta.2` 的独立发布提交
