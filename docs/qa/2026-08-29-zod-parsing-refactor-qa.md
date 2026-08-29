# QA 记录: 2026-08-29 手写校验逻辑 zod 化（零行为变更重构）

## 背景

仓库允许的运行时依赖中已有 `zod`（`^4.4.3`），且已在 `config/schema.ts`、`split/plan-schema.ts`、`split/intent.ts` 三处正确使用；但外部数据边界（SDK 返回值、事件 payload、消息历史）仍有约 6 处手写 `isRecord`/`typeof`/`as` 强转校验，其中多处是**同一 shape 的重复实现**。本次把这些解析统一收敛到宽容语义的 zod schema，消除重复与 `as` 强转。**原则：除显式列出的三处加固外，逐用例保持与原实现等价**（宽容跳过、绝不整体拒绝）。

## 改动范围

| 文件 | 改动 |
|---|---|
| `shared/session-data.ts`（**新增**） | 跨模块共享的 OpenCode 数据 shape：`parseSessionMessages`（消息信封 `{ info.role, parts }`，坏条目丢弃）、`eventSessionID`（事件 properties 直取/嵌套 `info.sessionID`）、`modelFromRecord`（`providerID` + `id ?? modelID`）、`sessionStatusMapSchema`（`session.status()` 返回表） |
| `core/vision/detector.ts` | `extractImageAttachments` / `extractImageParts` 的手写循环换成 `imageAttachmentSchema` / `imageFilePartSchema`（mime 小写化 transform + 白名单 refine + `filename` 非字符串降级），删除本地 `isRecord` |
| `shared/api-result.ts` | 对象分支抽出 `errorInfoFromObject`（zod schema：`name`/`message`/`statusCode`/`data.message` 全部 `.catch(undefined)` 降级，`data.message` 优先）；`errorInfoFromResult` 的 `Error` 实例分支与信封解析保持手写（zod 无增益） |
| `core/background/manager.ts` | ① 删除与 `hooks/event.ts` 重复的 `resolveEventSessionID`，改用共享 `eventSessionID`；② `classifyError` 对象分支复用 `errorInfoFromObject`；③ `validateSessionHasOutput` 的消息/part 手写扫描换成 `parseSessionMessages` + `outputSignalPartSchema`（union：`tool` 或非空 `text`/`reasoning`）；④ `pollRunningTasks` 与 `confirmStillIdle` 对 `session.status()` 返回值从 `typeof === "object"` 弱检查改走 `sessionStatusMapSchema` 校验；⑤ 消息 part 进度解析（`message.part.updated`）保持手写（热路径、逻辑带状态机副作用，schema 化无收益） |
| `core/assistant-text.ts` | 两个函数的 `as` 强转扫描换成 `parseSessionMessages` + `textPartSchema`（`state` nullish 降级）；截断预算逻辑逐行保持 |
| `tools/bg.ts` | `collectLatestUserImages` 换用 `parseSessionMessages`（仅信封层，part 层仍由 `extractImageParts` 校验） |
| `core/vision/pipeline.ts` | `lookLatest` 的 messages 倒序扫描换用 `parseSessionMessages` |
| `hooks/event.ts` | 删除本地 `eventSessionID`，改用共享实现 |
| `index.ts` | 删除本地 `modelFromRecord`，改用共享实现（模型继承三级回退链的逻辑本身零改动） |

**有意保留手写的部分**：`config/load.ts` 的 `deepMerge`（深合并不是 schema 职责，且按字段回退本身已基于 zod issues 实现，属 3.4 不变量）；`vision-look.ts` 参数归一化（JSON 字符串数组兼容是业务逻辑）；`manager.ts` 的 part 进度状态机。

## 行为差异（三处，均为加固方向）

1. **状态表校验 fail-closed**：`session.status()` 返回值此前只要是个对象就强转使用，坏条目的 `type` 会变成 `undefined` 被当作 idle（有误完成任务并中止仍在运行子会话的风险）。现在校验失败 = 本轮 sweep 跳过/完成确认推迟，与该文件"无法确认时绝不完成"的既有哲学一致。已用真实响应 `{"ses_...":{"type":"busy"}}` 确认 schema 兼容。
2. **`collectAssistantText` 对非数组 `parts` 不再抛 TypeError**：原实现 `for (const part of record.parts ?? [])` 在 `parts` 为非数组对象时会抛（被 hook guard 吞掉但丢功能）；现在该消息被信封 schema 丢弃，等同"无 parts"。
3. **`classifyError`（thrown 非 Error 对象）纳入 `data.message` 优先**：与 `errorInfoFromResult` 的对象分支对齐；真实 thrown 错误是 `Error` 实例（无 `data` 字段），路径无实际差异。

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误（基线亦 0）
bun test            # 407 pass / 0 fail / 913 expect，27 个文件（基线 381 → 407，+26）
bun run build       # index.js 175.76 KB（44 modules）
```

新增/更新测试：
- **`tests/session-data.test.ts`（新增）**：信封解析（坏条目丢弃、`info.model` 经 looseObject 保留、`parts` nullish）、`eventSessionID`（直取优先/非字符串直取回退嵌套/垃圾输入，含与原 typeof 链的逐条对齐用例）、`modelFromRecord`（`id` 优先、非字符串 `id` 整体拒绝——保持"id 胜出后失败不回退 modelID"的原语义）、状态表 schema（合法通过；数组/null/坏条目拒绝）。
- **`tests/api-result.test.ts`（新增）**：成功形状返回 undefined、`data.message` 优先于信封 `message`、Error 实例透传（含非枚举属性读取）、字符串/数字 error、垃圾对象不抛；`errorInfoFromObject` 的降级矩阵（`data` 为字符串/null/数字）。
- **`tests/vision.test.ts`**：detector 块新增 4 个用例——垃圾条目跳过但保留有效兄弟条目、非字符串 `filename` 丢弃但附件保留（对应 `.catch(undefined)`）、非数组 attachments/parts 返回空。
- **`tests/assistant-text.test.ts`**：新增畸形条目/畸形 part 容错用例、纯空白 text part 跳过用例。

### 2. 沙箱真实验证（`scripts/qa/sandbox-run.sh` + 常驻 serve）

- **基线会话**：沙箱加载本地插件跑 `opencode run "say hi"`，会话正常完成，`prism.log` 仅一行正常启动日志（`vision.model empty...`），无 hook 异常。
- **后台全链路**（`opencode serve` 常驻 + `/session/:id/message` 驱动，避免 CLI 模式进程退出杀死子会话）：
  1. 提示模型调用 `bg_spawn` → `prism.log`：`background task queued` → `launching background task`；
  2. 子会话执行完成（不使用工具直接回复「后台链路验证成功」）→ 子会话消息历史出现 completed text part，opencode 日志记录 loop 退出与 `cancel`（即 `completeTask` 的 `abortSession`）——**成功路径按设计静默**；
  3. 第二个任务（glob 统计）因 opencode 自身 glob 工具执行挂起而持续 busy（**与本次改动无关**，prism 不执行工具；同版本基线行为一致），改用 `bg_cancel` 取消 → `isFailure` 触发批次收尾 → gate 派发通知；
  4. **父会话收到回注**：`<system-reminder>[PRISM BACKGROUND TASKS] 全部后台任务已结束 (2 个)` 看板，模型后续回复正确报出 `bg_faf9196d — COMPLETED，结果：「后台链路验证成功」`——该文本正是 `collectAssistantText`（zod 化后）从子会话真实消息历史捕获的结果，证明 消息信封解析 → 结果捕获 → 状态表校验（`confirmStillIdle`）→ 通知回注 全链路在真实数据上工作正常。
- 真实 `session.status()` 响应形状（`{"ses_x":{"type":"busy"}}`）经 `sessionStatusMapSchema` 校验通过，fail-closed 加固无误伤。

### 3. 回归确认

- 基线 381 个用例全部原样通过（未修改任何既有断言），重构后的解析函数与原实现对既有输入逐用例等价。
- 3.1 视觉三重门控、3.2 递归防护、PromptGate 注入入口均未触碰；`manager.ts` 的消息 part 进度状态机保持手写原样。
