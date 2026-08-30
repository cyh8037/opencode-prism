# QA 记录: 2026-08-30 安全与健壮性加固（取消竞争守卫 / dispose 超时熔断 / 图片魔数校验）

## 背景

按《prism-codebase-security-and-robustness-fix-plan.md》（桌面审查方案）落地三项修复。实施前逐项核对了当前代码库，发现方案系针对旧版本代码编写，三项的实际落地状态不同：

| 方案 | 方案要求 | 核对结果 |
|---|---|---|
| 一：取消状态防抖与事件竞争守卫 | 终态任务（cancelled/failed）忽略迟到完成事件 | **守卫已存在**：`finalizeTask` 入口集中终态检查（`TERMINAL_STATUSES` 短路）+ 各完成切入点（`handleEvent`/`pollRunningTasks`/`settleIdleTask`/`completeTask`）的 `running` 状态门。本次补齐可观测性与一个同族漏洞 |
| 二：dispose 优雅退出超时熔断 | `shutdown` 并行 abort + 3000ms 硬超时 | **缺失，已实现**：原实现 `await Promise.allSettled(aborts)` 无总上限，单个 abort 由 `ABORT_TIMEOUT_MS=10s` 兜底——最坏退出卡顿 10 秒 |
| 三：本地图片魔数校验 | 读文件后校验文件头签名，非法跳过 | **已存在**：`sniffImageMime`（PNG/JPEG/GIF/WEBP 四签名）已在本地文件/data URL/远程下载三处入口全覆盖。本次补方案点名的布尔形式导出与专项测试 |

## 改动范围

| 文件 | 改动 |
|---|---|
| `config/constants.ts` | 新增 `SHUTDOWN_TIMEOUT_MS = 3_000`（dispose 整批 abort 的总等待上限，单个 abort 仍由 `ABORT_TIMEOUT_MS` 约束） |
| `core/background/manager.ts` | ① `shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS)`：并行 abort `Promise.allSettled` 与硬超时 `Promise.race`，超时仅放弃**等待**（迟到 abort 自行记录日志，`allSettled` 杜绝 unhandled rejection），清理流程无条件继续；② `finalizeTask` 终态短路分支增加丢弃日志（taskId/currentStatus/requestedStatus），竞争从静默变为可诊断；③ `validateSessionHasOutput` 的权威 resultText 回写加迟写守卫（仅当 `status === "running" && task.sessionId === sessionID`）——取消/出错落在 messages 调用在途时，迟到的助手文本不再写进已终结任务（否则会泄漏进批量看板的结果预览） |
| `core/vision/image-utils.ts` | 新增导出 `isValidImageMagicNumber(bytes)`（`sniffImageMime` 的布尔形式，单一实现源，满足方案点名的 API） |
| `index.ts` | dispose 增加入口/完成两条日志（`appendFileSync` 同步落盘）：成功路径此前零日志，干净 dispose 与"dispose 根本没跑"无法区分（本次沙箱验证正是靠它取得正面证据） |
| `tests/image-magic-number.test.ts`（新增） | 四签名接受；文本伪装/损坏 GIF 尾字节/RIFF-WAVE 非 WEBP/截断 RIFF 拒绝；短 buffer 拒绝；端到端：假扩展名文本文件经 `normalizeImageUrl` 被跳过、同批真实 PNG/JPEG/GIF/WEBP 正常通过 |
| `tests/background-manager.test.ts`（+4 用例） | ① 迟到 `session.idle` 不复活已取消任务（状态保持 + 注入计数不增）；② 迟到 `session.idle` 不复活已出错任务（error 路径保留 sessionId，验证状态门）；③ 输出校验在途时取消，迟到助手文本不写回 resultText；④ abort 全挂起时 `shutdown(50)` 按硬超时返回且状态硬清理（`getTask` 为空、后续 launch 拒绝） |

## 验证步骤与结果

### 1. 类型检查 / 单元测试 / 构建

```
bun run typecheck   # 0 错误
bun test            # 456 pass / 0 fail / 1108 expect，28 文件（含新增 9 个用例）
bun run build       # index.js 181.24 KB
```

### 2. 沙箱真实验证（1.18.25，隔离 XDG 沙箱，真实 deepseek 模型调用）

| 验证项 | 实际输出 | 结论 |
|---|---|---|
| dispose 基线（无后台任务） | `opencode run` 退出时 prism.log：`dispose: shutting down` → `dispose completed`（间隔 <1ms） | ✅ 一次性运行退出路径确实调用插件 dispose，且新日志可观测 |
| dispose 带运行中子会话 | 模型经 `bg_spawn` 启动真实子会话（`launching background task bg_3d7ec71b91a0`）后主回合立即结束：`dispose: shutting down` → `dispose completed`（<1ms），宿主 7.2s 正常退出 | ✅ 并行 abort + 熔断在真实生命周期中不阻塞退出 |
| `opencode serve` + SIGINT（运行中子会话） | `/bg` 原生启动子任务 → SIGINT → serve 0.14s 退出，prism.log **无任何 dispose 入口日志** | ⚠️ 1.18.25 的 serve SIGINT 属硬退出，**不触发插件 dispose**（宿主行为）——退出不被拖住与 Prism 无关，超时熔断守护的是宿主确实调用 dispose 的路径（TUI/一次性运行/插件重载） |
| 挂起 abort 的熔断路径 | 真实本地 server 无法构造挂起端点，由单测覆盖（mock abort 永不 resolve，`shutdown(50)` 按超时返回并完成清理） | ✅ 单测锁定 |

### 3. 已知边界（如实记录）

1. **serve + SIGINT 不触发 dispose**：宿主 1.18.25 的 serve 进程对 SIGINT 直接退出，不经过插件 dispose 生命周期。此场景下 Prism 的清理（含本方案的 abort）不会执行，但整个进程连同其子会话一并终止，无孤儿泄漏；若未来宿主版本在退出路径接入 dispose，本方案的 3s 熔断即生效。
2. **通知重试与 dispose 的竞态（既有，非本次引入）**：沙箱观测到 dispose 完成后一条 `background-notification` 的 gate 重试仍在退避（`gate: dispatch failed, retrying with backoff`）。重试定时器随进程退出消亡，无实际泄漏；属完成通知与 dispose 的既有竞争窗口，如需根治需在 shutdown 时取消在途 dispatch，不在本方案范围。
3. `finalizeTask` 的丢弃日志在重复取消等良性竞争下也会触发（设计如此：竞争可诊断优先于日志量）。

## 文档同步

- 本次改动均为内部健壮性（无配置/命令/工具/用户可见行为变化），README 无需同步。
- QA 历史记录为存档证据，不回写。
