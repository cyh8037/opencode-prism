# QA 记录: 2026-08-28 全面缺陷修复与健壮性加固

## 改动范围

计划 `abstract-rolling-plum` 的 11 个修复模块,全部实现并提交前验证(未提交):

| 模块 | 文件 | 核心改动 |
|---|---|---|
| 1. 视觉递归防护 | `vision/pipeline.ts`, `background/manager.ts`, `background/types.ts` | `BgTask.taskType: "default" \| "vision"`;`isInterpretationSession` 只认解读子会话(同步 + taskType="vision"),普通子任务恢复调用 `vision_look`;`interpretWithFallback` 清理移入外层 `finally`;`tryRetry` 保留 taskType |
| 2. 日志轮转 | `shared/log.ts` | 周期 size 检查(每写 ~512KB 一次),超 10MB 自动轮转 `.1`,不再只检查启动首次 |
| 3. 图片流式截断 | `vision/image-utils.ts` | `readBodyBounded`:chunked 无 Content-Length 响应按块读取,超 4MB 立即 `reader.cancel()` 中断 |
| 4. Steering 上限 | `background/manager.ts`, `config/constants.ts` | `MAX_STEERING_QUEUE_LEN=10`(满则拒绝)、`MAX_STEERING_MSG_BYTES=32KB`(按字符安全截断,不切 UTF-8) |
| 5. Prompt Injection | `shared/sanitize.ts`(新), `manager.ts`, `split/scheduler.ts` | `sanitizeSystemReminder` 转义 `</system-reminder>`(大小写不敏感),应用于通知与汇总报告中的不可信子任务输出 |
| 6. PromptGate | `core/prompt-gate.ts` | `SessionState.abortController`;`clear()` 中止在途 waitForIdle/waitForReservation/重试链;移除未使用的 `mode`/`parts` 参数与 sync 分支 |
| 7. Manager 竞态 | `background/manager.ts` | settle 固定 sessionID,每步 await 后复查;`completeTask` 拒绝非 running/无 sessionId(防同模型重试误结算);`confirmStillIdle` 参数化 |
| 8. SplitService | `split/service.ts`, `split/plan-schema.ts`, `split/scheduler.ts` | `run.done.then(...).catch` 兜底;Kahn 对重复依赖去重(防 `["a","a"]` 误报环);报告注入前 sanitize |
| 9. JSONC 转义 | `config/jsonc.ts` | 显式转义状态机(反斜杠奇偶语义),测试锁定 |
| 10. 模型解析 | `index.ts` | 先查 `CurrentModelTracker` 内存快照,miss 才走 session.get/messages 网络路径(主任务与 split 规划器共用) |
| 11. 清理与测试 | `background/concurrency.ts`, 测试 | 移除未使用的 `getLimit`;新增 25 个单测(222 → 247) |

## 验证步骤与结果

### 1. 类型检查

```
bun run typecheck        # tsc --noEmit → 0 错误
```

### 2. 单元测试

```
bun test                 # 247 pass / 0 fail / 561 expect calls,17 个文件
```

新增/更新的测试与修复的对应关系:

- `vision.test.ts`: 普通后台子任务调用 `vision_look` 解读成功(而非被拒)— 核心回归测试;taskType="vision" 子会话仍拒绝嵌套解读
- `background-manager.test.ts`: steering 队列满拒绝、超长截断、UTF-8 多字节不切分、taskType 跨同模型重试保持
- `prompt-gate.test.ts`: `clear()` 中止在途 waitForIdle——不再轮询、不再发起 promptAsync
- `image-utils.test.ts`: 无限 chunked 流超 4MB 中断下载(source cancel 回调触发);cap 内 chunked 流正常读取
- `jsonc.test.ts`: 偶数反斜杠串闭合引号、转义引号不闭合、奇偶跨引号保持、字符串外反斜杠不影响注释剥离
- `log.test.ts`: 写超 10MB 后自动轮转 `.1`(600 次 ~20KB 调用)
- `split.test.ts`: 重复依赖不误报环;自依赖仍报环
- `sanitize.test.ts`(新): 关闭标签转义、大小写不敏感、开标签与普通文本不受影响
- `server-url.test.ts`(新): serverUrl 透传、port 0 回退、OPENCODE_PORT 校验

### 3. 构建

```
bun run build            # dist/index.js 141.78 KB,37 modules
```

### 4. 真实环境验证(部分)

沙箱(`scripts/qa/sandbox-run.sh` 模式,独立 XDG 目录 + 本地插件路径)中:

- **已通过**: 插件在真实 opencode 1.18.23 中加载,新代码启动路径正常(`prism.log` 输出 `[prism] vision: vision.model empty, inheriting the session model when image-capable`,多次加载无异常);一次完整会话(含模型往返)成功。
- **已跳过**: 完整的 LLM 驱动 E2E(后台子任务 → `vision_look` 读图 → 回注)。**原因**: 模型 provider 连接间歇性挂起(同一沙箱下连纯 `opencode run "hi"` 都零输出挂起,5/5 次探测失败;期间曾两次瞬时恢复并成功跑通,随后再次挂起;`opencode models` 正常返回、显式指定 `opencode/mimo-v2.5-free` 可通,但完整视觉链路需要视觉模型,验证按用户指示跳过)。

### 5. 静态不变量审查

- Invariant #1(hook 不抛错): 所有 hook 仍经 `guardHook`;split 聚合链新增 `.catch`;`bg_send` 工具层 catch 新抛的"队列已满"错误并转为工具文本
- Invariant #2(注入走 PromptGate): 未新增注入面;sanitize 只转义既有 gate dispatch 内容
- Invariant #3(递归防护): 三处守卫仍在(`vision-look` 工具、`pipeline.onToolOutput`、`chat-message`),语义按计划精确化——解读上下文(同步解读子会话 + taskType="vision")拒绝嵌套,普通子任务放行
- Invariant #7(client 4xx/5xx 契约): 未新增 client 调用;`readBodyBounded` 走 fetch reader
- Invariant #8(三重门控): `tool-execute-after` / `getVisionModel` / `pipeline.onToolOutput` 三处 `vision.enabled` 检查未动
- Invariant #10(chat-message part 字段契约): `chat-message.ts` 未改
- Invariant #11(config hook 原地修改): 未改
- 无 `console.*` 输出(src 全量 grep 通过)

## 独立审查(2026-08-28,新会话 subagent)

独立上下文审查(等效新会话,无实现路径依赖)结论:**有条件通过,无 BLOCKER**。11 条不变量逐条确认;递归防护语义精确化经路径推演无新递归路径;typecheck + 247 单测复核一致。

审查提出的 3 项已全部处理:

- **W1(已修复)**: `completeTask` 残余 TOCTOU——settle 的 sessionID 固定检查在 `confirmStillIdle` **之前**执行,若同模型重试在确认调用期间完成(状态翻回 running + 新会话),旧确认会误结算刚重拉起的子会话。修复:`completeTask(task, source, expectedSessionID)` 增加最终身份比对(`task.sessionId !== expectedSessionID` 时退出),并新增回归测试「a retry relaunching a fresh session during the confirmation is not settled」(248 测试通过)。
- **W2(已接受并注释)**: tracker-first 解析在 `/models` 切换后、下一次主会话 LLM 调用前存在陈旧窗口(子任务用切换前模型)。接受为快照快速路径的代价(自愈于下一次 chat.params),`index.ts` 注释改为如实描述该窗口。
- **N1(已修复)**: 通知与汇总模板内的 `task.description` / `task.error` / `plan.title`(均来自父会话或 provider 的不可信文本)补上 `sanitizeSystemReminder` 转义,与 `resultText` 对齐。

修复后复核:`bun run typecheck` 0 错误、`bun test` **248 pass / 0 fail**、`bun run build` 通过。

## 与计划的偏差

1. **JSONC 反斜杠**: 计划声称的 bug 实测当前实现已正确处理(偶数反斜杠配对正确,`"C:\\path\\"` 解析正常);仍按计划意图重写为显式转义状态机(语义更清晰、EOF 孤立反斜杠行为更忠实),并用测试锁定。
2. **Manager TOCTOU**: `settlingTaskIds` 全 settle 互斥与 steering 重激活检查在计划之前已存在;实测补充了真正的缺口——settle 期间同模型重试(`task.status → pending`、`sessionId` 清空)会让 `completeTask` 误结算,新增 `completeTask` 状态守卫与 sessionID 固定复查。

## 遗留与建议

- E2E(子任务 `vision_look`、steering 投递)待 provider 连接稳定后补跑:沙箱命令为
  `PRISM_CONFIG=<带 vision.model 的配置> bash scripts/qa/sandbox-run.sh` 或按 README 手动流程。
- 按仓库契约,本改动需**新开会话审查**通过后才允许提交。
