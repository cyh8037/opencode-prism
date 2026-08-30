# QA 记录: 2026-08-30 全面审查修复（P0 图片丢文本 / retry 瞬态误判 / 目录一致性 / 注入重试 / 场景补齐）

## 背景

对全部 47 个源文件（约 6.6k 行）做安全 / 逻辑 / 场景覆盖 / 冗余 / 体验五维审查，确认 2 个高优先级逻辑 bug 与一批中低优先级问题，本次全部修复。修复不改变三大能力的对外语义，只收正确性、健壮性与安全口子。

## 改动范围

| 文件 | 改动 |
|---|---|
| `hooks/command-execute-before.ts` | ① **P0 修复**：`/bg <描述>` + 图片时 parts 自带任务文本 part（此前 startTask 语义"parts 完全取代 prompt"导致任务指令整个丢失，子会话只收到图）；② Prism 子会话内 `/bg`、`/split` 拒绝；③ `--parallel` 封顶 `2–MAX_SUBTASKS`；④ `/split cancel sp_xxx` 的逐任务 abort 并行化（`Promise.all`）；⑤ `fence()` 按内容最长反引号串加长围栏 + 过 `sanitizeSystemReminder`；⑥ `formatTaskOutput` 的 error/resultText 走清洗管线 |
| `core/background/manager.ts` | ① **P0 修复**：`session.status` retry 事件从"tryRetry/finalize error"改为仅刷新看门狗锚点（与轮询路径、prompt-gate 对 retry 瞬态的语义对齐）；② `validateSessionHasOutput` 改用 `task.directory ?? 插件目录`（跨目录任务此前 fail-closed 挂 30 分钟被看门狗杀）；③ `abortSession` 增加 `directory` 参数，全部任务侧调用点传入；④ `handlePromptFailure` 终态路径 abort 孤儿子会话；⑤ `notifyParent` 改走 `gate.dispatchWithRetry`（外层退避，注入失败不再永久丢失）；⑥ `cancelAllByParentSession` 并行化；⑦ `bg_` id 随机段 8→12 hex |
| `core/prompt-gate.ts` | 新增 `dispatchWithRetry`（外层 5 轮退避阶梯）；删除从未被调用的 `queueBehavior: "enqueue"` 死参数与分支；共享 `sleep` |
| `core/split/service.ts` | 手写退避重试链收敛为 `gate.dispatchWithRetry`；新增同会话活跃 run 上限（`MAX_ACTIVE_SPLIT_RUNS=2`，超限返回 `run-limit` 结果） |
| `core/split/scheduler.ts` | `buildSplitReport` 的 title/error/resultText 从仅封闭标签逃逸升级为 `sanitizeCell` 全管线（换行压平，无法伪造报告条目）；`TERMINAL` 收敛为共享定义 |
| `core/background/types.ts` | 新增 `TERMINAL_TASK_STATUSES` 单一定义（manager/visualizer/scheduler 三处收敛） |
| `hooks/chat-message.ts` | fail-closed：`output.message?.id` 缺失时跳过提醒（不推 `messageID: undefined` 的非法 part，防会话冻结事故复发）；命令回合判定改用模板标记常量 |
| `commands/templates.ts` | 模板首行标记导出为常量（hook 共用）；新增 `navigationHint` 统一出口（`tools/bg.ts` 去重） |
| `config/load.ts` | `deepMerge` 跳过 `__proto__`/`constructor`/`prototype`；`PRISM_CONFIG` 独占生效（跳过项目级，语义与"一次性实验"对齐） |
| `models/error-classifier.ts` | 状态码词模式 `\b` 锚定（"1500 tokens" 不再误判可重试） |
| `core/shared/width.ts` | `Intl.Segmenter` 模块级缓存（每次渲染数百次构造消除） |
| `core/vision/interpreter.ts`、`core/split/json-prompt.ts` | abort 补 `directory` 作用域；共享 `sleep` |
| `core/client-types.ts` | `session.abort` 类型补 `query: { directory? }`（SDK `SessionAbortData` 实测有此参数） |
| `index.ts` | `bg`/`split` 命令与用户自定义同名命令冲突时留日志 |
| `tools/bg.ts` | 导航指引改用共享 `navigationHint` |

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 437 pass / 0 fail / 1020 expect，27 文件（基线 407 → 437，+30）
bun run build       # index.js 183.33 KB
```

新增测试（关键回归）：
- `bg-command.test.ts`：图片跟随时 parts 必含任务文本 part（P0 回归）；子会话内 /bg、/split 拒绝；`--parallel 50` 上限拦截。
- `background-manager.test.ts`：`session.status` retry 事件只刷锚点不失败不 abort（P0 回归）；非可重试 prompt 拒绝后孤儿子会话被 abort。
- `prompt-gate.test.ts`：`dispatchWithRetry` 外层阶梯穷尽（12 次尝试）与中途成功两向。
- `split.test.ts`：`buildSplitReport` 多行内容压平（伪造条目无法自成一行）；活跃 run 上限命中 / settled 不计入。
- `config.test.ts`：`PRISM_CONFIG` 独占；`deepMerge` 原型链键防护（JSON.parse 构造 `__proto__`）。
- `models.test.ts`：状态码词 `\b` 锚定。
- `vision.test.ts`：chat-message 无 message id 时不推 part（fail-closed）。

### 2. 沙箱真实验证（`opencode serve` 常驻 + HTTP API 驱动，opencode 1.18.25，模型 opencode/big-pickle）

| 验证项 | 实际输出 | 结论 |
|---|---|---|
| 原生 `/bg` 启动 + 回执 | 日志 `background task queued → launching`（单次，id `bg_ce498ac0c61a` 为新 12 位格式）；回执 part 逐字注入 | ✅ |
| 完成通知（新 `dispatchWithRetry` 路径） | `<system-reminder>[PRISM BACKGROUND TASKS]` 管道表格 + 完整结果"沙箱正常"注入主会话 | ✅ 重试包装路径端到端正常 |
| 子会话内 `/bg`、`/split` 拒绝 | 子会话注入"Prism 后台子会话内不能执行 /bg|/split…请回到主会话"，子模型如实转达，无任务被创建 | ✅ 命令面防线生效 |
| `--parallel 50` 上限 | 注入"用法: /bg <任务描述> --parallel <2-12>…"，日志无新 `background task queued` | ✅ 无界 spawn 指令消除 |
| `/split` 意图判定 → DAG 启动 → 汇总回注 | verdict(split) 正确放行（3 个独立文件任务）→ 3 子任务并行（6s/6s/9s 全 COMPLETED）→ `[PRISM SPLIT REPORT]` 经新重试路径注入 | ✅ 拆分全链路 |
| `/split` 意图判定拦截琐碎任务 | 3 个不同琐碎任务 verdict(direct) 均给出合理原因（含依赖识别："子任务B依赖子任务A的输出"） | ✅ 防误拆兜底 |
| `/bg cancel`（落地时任务已自然完成） | 走全终态路径，无异常、无多余注入；运行中取消语义由单测 `cancel aborts the child session and notifies` 覆盖 | ✅ |
| 活跃 run 上限（自然触发） | 未能在沙箱内自然触发：并发发起的拆分被意图判定正确拦截（direct）或按序完成，窗口内从未同时存在 2 个未结算 run —— 上限逻辑以单测两向覆盖（命中 + settled 不计入），属预期 | ⚠️ 单测覆盖，自然触发不可达 |

### 3. 已知边界（如实记录）

1. **P0 修复的图片路径**：headless command API 无法携带附件（0.5.0 QA 已知边界），端到端仍只能单测覆盖 hook parts 组装与 manager promptBody 语义；TUI 真实贴图建议人工验证一次。
2. **session.status retry 修复**：沙箱无法自然制造 provider 429 退避（本地模型不触发），修复以单测 + 既有语义对齐论证（轮询路径与 prompt-gate 注释均确认 retry 为瞬态）。
3. **`directory` 参数**：SDK 类型确认 `SessionAbortData.query.directory` 存在；沙箱为单目录环境，跨目录行为无法端到端复现，属条件触发的健壮性修复。
4. 沙箱日志确认 manager 成功路径保持静默（完成不打日志），证据全部取自回注消息与状态。

## 文档同步

- README：`PRISM_CONFIG` 独占语义、视觉安全边界（远程拉取不做内网过滤的理由与收窄方式）、sync 模式最坏延迟、`--parallel` 上限、子会话拒绝、运行规则补宿主退避语义。
- CHANGELOG：[Unreleased] 新增"2026-08-30 全面审查"小节（修复 4 / 加固 4 / 场景 4 / 体验 6 项）。
