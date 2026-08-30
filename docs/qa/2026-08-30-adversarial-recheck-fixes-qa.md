# QA 记录: 2026-08-30 对抗性复审修复（tryRetry 重入锁存 / resume 并发防重入 / parseConfig 防御 / 逃逸宽容空白变体）

## 背景

对首轮审查（`2026-08-30-review-fixes-qa.md`，已由上一批修复落地）确认过"刻意设计"标注的代码做**不信赖注释**的对抗性复审，按当前代码逐项重新校验后确认 4 个注释未覆盖的可修问题 + 1 处注释失实。本批修复全部先重新校验、后动手（工作区在首轮修复后已有改动，不能沿用旧结论）。

## 逐项校验结果（修复前）

| # | 问题 | 校验结论（基于当前工作区代码） |
|---|---|---|
| 1 | `tryRetry` 重入 TOCTOU | **确认存在**。`retries >= MAX_RETRIES` 检查（manager.ts:477）与 `task.retries += 1`（:514）之间隔着 `await abortSession`（:502）；入口无状态守卫。两个失败信号叠加（prompt 拒绝竞态 session.error、或双 resume 后的双 prompt 失败）会双双通过预算检查、双重入队：同 task 两个子会话，先启动者启动后被 `task.sessionId` 覆盖成孤儿。上一批修复只处理了 session.status retry 瞬态（与事件路径的 running 守卫），未覆盖 handlePromptFailure 直呼路径 |
| 2 | `resume` 并发重入 | **确认存在**。入口 terminal/running 检查后 `await acquire`（最长 15s），恢复后不复查；`resumingTaskIds` 已存在但入口无 `has()` 检查。同一终态任务的并发 `bg_send` 会双 acquire、对同一子会话双 prompt（第二个 busy 拒绝 → 假性 task error），且它是 #1 的现实前置条件 |
| 3 | `parseConfig` 清理循环潜在 TypeError | **确认存在（当前 schema 下不可达）**。load.ts 清理循环对 `cleaned[field]` 直接 `.filter`；同一 section 校验若同时产出元素级 issue（path 含 index）与字段级 issue，字段被 `delete` 后循环对 `undefined` 调 `.filter` → `parseConfig` 抛出 → 插件加载失败，违背其文档承诺 "parseConfig itself never throws"。现有 schema（`vision.tools` 无数组级约束）不可达，但任何数组字段加 `.min()/.max()/superRefine` 即引爆 |
| 4 | `sanitizeSystemReminder` 只匹配规范闭合标签 | **确认存在**。`</system-reminder >`、`</ system-reminder>`、`</system-reminder\t>` 等空白变体直接穿透；闭合标签的消费方是父会话**模型**而非解析器，模糊变体同样会被当作块结束 |
| 5 | `deliverSteering` 双投窗口 | **不需修复**（维持原判）：注释已声明 "worst case delivered twice — never silently lost"，且验证了迟到 rejection 被 `Promise.race` 内部 handler 消费、不会成为 unhandled rejection |
| 6 | `completeTask` reserve 注释失实 | **确认存在**（仅注释）。reserve 的实际机制是让**其他 source 的 gate 注入**等待（注入顺序串行化），原注释描述的"并发检查会看到已结算"并不存在——状态判定从不读 reservation |

## 改动

| 文件 | 改动 |
|---|---|
| `core/background/manager.ts` | ① `tryRetry` 入口重入锁存：`task.status !== "running"` 时返回 `true`（语义 = "任务归属他人，勿 finalize"）——放在 retryable 判定**之前**，否则后到的不可重试信号会把正在重试的任务 finalize 掉；返回 `true` 而非 `false` 是关键，false 会让调用方走 `finalizeTask(error)` 杀掉赢家即将重启的任务。② `resume` 入口 `resumingTaskIds.has()` 防重入（集合同步建立于首个 await 之前，第二调用必然观察到）。③ `completeTask` reserve 注释改为对注入顺序串行化的准确描述 |
| `config/load.ts` | 清理循环 `Array.isArray` 防御（顺带消除 `as unknown[]` 强转），守住 never-throws 契约 |
| `shared/sanitize.ts` | 闭合标签逃逸正则放宽为 `<\/\s*system-reminder\s*>`，全部空白变体归一化为规范转义形（sanitize 恒在宽度计算之前，列宽不受影响） |

## 验证

```
bun test            # 440 pass / 0 fail（基线 437 + 本轮 3 个新回归测试）
bun run typecheck   # 0 错误
bun run build       # index.js 183.72 KB
```

新增回归测试：
- `background-manager.test.ts`「a second failure signal while a retry is in flight stands down without finalizing」：复现赢家已置 pending 的窗口，断言输家返回 `true`、不产生第二个子会话、不消耗预算、不落 error（无锁存时该用例会双重入队）。
- `background-manager.test.ts`「a second concurrent resume on the same terminal task is rejected」：终态任务并发双 `resume`，断言第二次以「恢复等待」拒绝、首次正常续跑。
- `sanitize.test.ts`「escapes whitespace-fuzzed close tags」：`</system-reminder >`、`</ system-reminder>`、制表符变体全部归一化转义，`</system-reminderS>`（非标签）不受影响。

## 已知边界（如实记录）

1. **#3 无直接单测**：该路径在现有 schema 下不可达，直接测试需为 `parseConfig` 注入合成 schema（重构成本大于收益）。防御以"构造上排除崩溃"达成，注释写明触发条件。
2. **#1/#2 的并发窗口本身**无法被单测或沙箱确定性复现（竞态注入需要劫持 abort/accept 时序）——测试通过白盒复现交错后的状态断言锁存语义；正常单信号流程的行为由既有 437 项测试（含 retry/resume 生命周期用例）确认未变（守卫在正常路径恒通过）。
3. 沙箱端到端：正常单次 retry / 单次 resume 路径与上一批沙箱 QA（2026-08-30-review-fixes-qa.md）走的是同一段代码 + 恒通过的入口检查，无新行为面；本批改动不涉及注入模板与 hook 触发时序，未重复沙箱流程。
