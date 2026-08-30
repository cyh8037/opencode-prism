# QA 记录: 2026-08-30 拆分进行中插入的独立 `/bg` 任务完成通知被吞

## 背景（真实会话事故取证）

用户报告：`/split` 执行期间插入独立 `/bg` 任务，拆分汇总不返回、独立任务也没有单独响应。证据取自 `opencode.db`（会话 `ses_faefca561ffedihFIjYkXdtYOt`，"oh-my-openagent 项目调研"，2026-08-30 12:52 起）与 `prism.log`：

| 时间（本地） | 事件 |
|---|---|
| 12:53:09 | `/split` run `sp_cda9ca9ef042` 启动（9 子任务 5 波），s1 首先启动 |
| 12:55:35 / 12:55:37 | 拆分进行中，用户插入两个独立 `/bg` 图片任务（`bg_73cd1b80c417`、`bg_55fb0794f74a`） |
| 12:55:46 / 12:55:53 | 两个独立任务完成（子会话更新时间；看板 12:56:00 已折叠进"+ 6 已结束"） |
| 12:55:46 → 13:04+ | 主会话**无任何** `[PRISM BACKGROUND TASKS]` 完成通知注入（逐条核对 part 时间线） |
| 13:06:33 | s7 完成（12m55s），s8 依赖满足即启动（ASAP 正常，见排查记录） |
| 13:18:40 | s8 仍在真实运行（71 → 253 次工具调用），拆分汇总按设计等 s8/s9 结束 |

排查中排除的假象：s8 的"迟到"启动与 s7 的完成时间吻合（12:53:38 + 12m55s = 13:06:33），子会话 `time_updated` 只是最后一条消息的落库时间，不是会话结束时间——调度器无异常；异常只在通知层。

## 根因

`manager.notifyParent` 的唤醒门控以**父会话名下全部任务**为单位：

```ts
const remaining = this.getTasksByParentSession(task.parentSessionId)
  .filter((t) => t.status === "running" || t.status === "pending").length
if (allComplete || isFailure) { /* 注入 */ }
```

该门控早于 split 功能（初始实现即有），针对的是同会话多个独立任务的防刷屏；split 上线后其子任务与独立任务共用 `parentSessionId`，被并成**同一个批次**：

- 独立任务完成时拆分子任务仍在跑 → `remaining > 0` 且非失败 → 通知静默不发，要等整个拆分（含长尾的 s8/s9）结束才随"全量看板"一次性带出；
- 拆分子任务挂起（TTL 只警告不杀）时独立任务的通知**永久丢失**；
- `BgTask` 无任何批次字段（`LaunchInput`/调度器裸 `launch`），manager 无法区分两类批次。

## 修复

批次语义按来源划分：

| 文件 | 改动 |
|---|---|
| `core/background/types.ts` | `BgTask` / `LaunchInput` 新增 `notificationGroup`：同组（同父会话）任务组内全部终态才通知一次；缺省 = 独立任务 |
| `core/background/manager.ts` | `notifyParent` 三路分流：① 失败/取消 → 即时逐条上报（父会话级剩余计数保留在"仍有 N 个任务运行中"行）；② 有组 → 组内全部终态才注入（组内计数）；③ 独立任务 → 按父会话合并窗口（`STANDALONE_FLUSH_DELAY_MS` 8s，deps 可注入）刷出，**窗口是合并手段不是门控**——窗口到达即注入已终态任务，不等任何仍在跑的批次。注入标题在父会话仍有进行中任务时用"后台任务已完成 (N 个)"，不再误称"全部后台任务已结束"。toast 收尾汇总沿用旧语义（父会话全部终态时汇总计数） |
| `core/split/registry.ts` | `generateRunId()` 单一来源（id 先于启动生成，调度器与登记共用） |
| `core/split/scheduler.ts` | `SplitRunOptions.notificationGroupId`（必填），launch 时传入 `notificationGroup` |
| `core/split/service.ts` | 启动前生成 run id，同传 `runSplit` 与 `registry.register` |
| `README.md` / `CHANGELOG.md` | 通知批次语义说明与修复条目 |

## 验证步骤与结果

```
bun run typecheck   # 0 错误
bun test            # 445 pass / 0 fail / 1059 expect，27 文件（基线 441 → 445，+4）
bun run build       # index.js 186.40 KB
```

新增回归测试（`tests/background-manager.test.ts`，`spyOnDispatches` 捕获 gate 注入文本）：

1. **事故回归**：组内子任务保持 running 时，独立任务完成 → 合并窗口到达即注入且只含该任务，标题为"后台任务已完成 (1 个)"（不称"全部"）。
2. **组门控**：组内首个任务完成不注入；全组终态后一次注入覆盖全组（拆分 run 不逐个唤醒）。
3. **合并窗口**：窗口内先后完成的两个独立任务合并为一条"全部后台任务已结束 (2 个)"。
4. **失败即时**：合并窗口拉到 60s，独立任务 `session.error` 仍在断言时间内注入"后台任务状态更新"（失败不进窗口）。

既有批次 toast 语义测试（收尾计数摘要、失败合并、取消合并）全部原样通过——toast 语义未变，只有注入批次化。

## 沙箱说明

本次改动涉及完成通知注入路径，但注入行为已由 gate 层 spy 断言（文本、次数、时序）确定性覆盖；`session.idle` 事件 → settle → notifyParent 的生命周期链路沿用既有测试基架（mock client + 真实 PromptGate），事故本身即生产环境真实复现。组合场景（拆分 + 独立任务并存）如需端到端复核，可在沙箱以 `opencode serve` + HTTP API 驱动 `/split` 后插入 `/bg` 验证注入时序（本次以单测覆盖为准）。
