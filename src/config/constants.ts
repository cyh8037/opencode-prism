// Hardcoded defaults for everything deliberately kept out of user config.
// See the design doc section "移除项与固定值". Open these only on demand.

// vision
export const MAX_IMAGES_PER_BATCH = 4
// Sync interpretation timeout. Interpretations are supplementary context —
// after this long the caller proceeds without the result; a timed-out
// interpretation is NOT retried (the retry is reserved for fast failures).
export const VISION_SYNC_TIMEOUT_MS = 60_000
// Sync interpretation polls the child's message history for the result; a
// shorter interval detects the LLM's answer sooner, at the cost of more API calls.
export const VISION_INTERPRET_POLL_MS = 250
// Size caps aligned with the strictest provider limits, not with context
// usage — providers tokenize images by resolution (a 4K screenshot lands at
// ~3k tokens after server-side downscaling), so bytes never blow the context
// window. What bytes DO break is upload limits: Anthropic rejects single
// images above 5MB, and Gemini caps the whole inline request at 20MB (base64
// inflates payloads ~33%). 4MB per image + 16MB of base64 payload per batch
// keeps every request inside those bounds.
export const VISION_IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const VISION_IMAGE_BATCH_MAX_BYTES = 16 * 1024 * 1024
export const VISION_COMPRESS_DEFAULT_MAX_BYTES = 100 * 1024
export const VISION_RAW_IMAGE_MAX_BYTES = 20 * 1024 * 1024
export const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

// background
export const DEFAULT_CONCURRENCY = 5
export const MAX_RETRIES = 1
export const TASK_TTL_MS = 30 * 60 * 1000
// Inactivity watchdog: a RUNNING task with no message-part activity for this
// long is treated as hung (stuck model call, dead tool) and cancelled — the
// tool-call circuit breaker only catches ACTIVE runaways, and the TTL warn
// deliberately never kills, so a silent hang would otherwise hold its
// concurrency slot forever and stall a /split run's aggregation. Any part
// update refreshes the anchor; steering and resume reset it too. A
// legitimately long silent tool call (long build) can still trip this — the
// cancel reason names the cause.
export const TASK_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000
// Terminal tasks are kept this long after completion (bg_output and the batch
// report need them), then pruned so a long-lived TUI session does not
// accumulate unbounded task state (resultText, concurrency bookkeeping).
export const TERMINAL_TASK_RETENTION_MS = 60 * 60 * 1000
export const POLLING_INTERVAL_MS = 3000
export const ABORT_TIMEOUT_MS = 10_000
// dispose（宿主退出/插件重载）并行 abort 所有运行中的子会话；单个 abort 由
// ABORT_TIMEOUT_MS 兜底，此上限约束整批 abort 的总等待——退出路径绝不能被
// 挂起的服务端拖住（超时后放弃等待，迟到的 abort 结果自行记录日志）。
export const SHUTDOWN_TIMEOUT_MS = 3_000
export const MAX_TOOL_CALLS = 4000
// Cap for a single task's result injected into the parent notification.
// Vision interpretations and normal task outputs fit comfortably; the cap
// only guards against pathological output blowing up the injected message.
export const MAX_NOTIFICATION_RESULT_CHARS = 20_000
// Steering delivery awaits prompt acceptance inside the idle-settle mutex —
// a hung call would stall the polling sweep, so it is raced against this.
export const STEERING_ACCEPT_TIMEOUT_MS = 10_000
// A steering round whose delivery keeps failing is re-queued and retried at
// the next idle boundary; past this many consecutive failures the messages
// are dropped so a dead child cannot loop the sweep forever.
export const STEERING_MAX_DELIVERY_ATTEMPTS = 3
// After a steering round is ACCEPTED, completion is deferred for this window:
// the server marks the session busy slightly after acceptance, and the
// polling sweep may still be iterating a status snapshot taken BEFORE the
// delivery (earlier settles can stall it for seconds). Must exceed
// POLLING_INTERVAL_MS plus one slow settle.
export const STEERING_SETTLE_GRACE_MS = 8_000
// Per-task steering queue bounds: the queue lives on the task object for its
// whole lifecycle, so unbounded growth from frequent bg_send calls would
// balloon memory — and the queued text is later injected into the child
// prompt, so a single oversized message can overflow the context window.
export const MAX_STEERING_QUEUE_LEN = 10
export const MAX_STEERING_MSG_BYTES = 32 * 1024
// bg_wait: default block time and hard cap for one tool call.
export const BG_WAIT_DEFAULT_MS = 30_000
export const BG_WAIT_MAX_MS = 120_000
// resume (bg_send on a terminal task) waits for the model group's concurrency
// slot. Running tasks past the TTL are only warned, never killed, so a
// saturated group could park the wait forever — and a terminal task cannot be
// cancelled out of the wait. Bounded here, the bg_send call returns an error
// instead of hanging the tool round.
export const RESUME_ACQUIRE_TIMEOUT_MS = 15_000
// 独立任务（无 notificationGroup）完成通知的合并窗口：窗口内终态的独立任务
// 合并为一条通知（/bg --parallel N 几乎同时结束时不再逐条唤醒父会话）。
// 窗口只是合并手段，绝不是门控——窗口到达时先刷出已终态的任务，绝不因
// 同会话仍有其他批次在跑而推迟（2026-08-30 事故的教训）。
export const STANDALONE_FLUSH_DELAY_MS = 8_000

// split
export const MAX_SUBTASKS = 12
// 同一会话同时处于"未结算"状态的拆分 run 上限：模型 autoTrigger 连续
// split_task（或用户连按 /split）时防失控叠 run。best-effort 上限。
export const MAX_ACTIVE_SPLIT_RUNS = 2
export const PLANNER_SYNC_TIMEOUT_MS = 120_000
// 意图识别（一次性分类子会话）的超时。比规划器短：分类任务轻，超时即
// fail-open 视为可拆分，不重试（重试只是把 /split 的等待加倍）。
export const INTENT_CHECK_TIMEOUT_MS = 30_000
// intent 的 reason 字段是子会话 LLM 输出（不可信文本），进入返回消息/
// 主会话前按此上限截断（配合 sanitizeTruncate 的控制字符清洗）。
export const MAX_INTENT_REASON_CHARS = 500
// 子会话标题中 description 部分的截断上限（[bg_xxxxxxxx] 前缀与 " (prism)"
// 后缀另计）。TUI 子会话导航视图约按 50 列显示标题，前缀放头部才可见。
export const MAX_SESSION_TITLE_CHARS = 100
// bg_spawn 返回文本、/bg 与 /split 命令模板、/bg status 看板共用的子会话
// 实时查看指引。键位为 TUI 默认值（用户可用 keybinds 覆盖）；文案直接写
// 死 Ctrl+X——"leader 键"属 Neovim 极客术语，普通用户无法对应到具体按键
// （2026-08-30 文案统一改造，权衡后选定具体按键而非键位名）。
// 版本行为依赖：session_child_first(<leader>down)/
// session_child_cycle(right,left)/session_parent(up) 及 parentID 子会话
// 分组行为，经 opencode 1.15.0 与 1.18.25 二进制（strings）验证一致。
export const BG_SESSION_NAV_HINT =
  "In TUI, press Ctrl+X then ↓ to view child session output live (←/→ to cycle, ↑ to return to parent session)"

// attach hint (/bg output --full) server port
export const DEFAULT_SERVER_PORT = 4096

// parent wake
export const PARENT_WAKE_DEDUPE_MS = 5000
export const SESSION_IDLE_SETTLE_MS = 3000

// gate dispatch hardening: a racing reservation is waited out (its window is
// the reserve holder's status flip + child abort, bounded by ABORT_TIMEOUT_MS)
// and a server-confirmed rejected prompt dispatch is retried a few times
// before being dropped (thrown errors are not retried — they may have landed).
export const GATE_RESERVATION_WAIT_MS = 15_000
export const GATE_RESERVATION_POLL_MS = 100
export const GATE_DISPATCH_ATTEMPTS = 3
export const GATE_DISPATCH_RETRY_DELAY_MS = 1_000
// dispatchWithRetry 的外层退避阶梯（gate 内层 3×1s 之外）：注入文本往往承载
// 唯一一份完成报告/汇总（调用方不会重新入队），主会话一段长回合的 busy
// 窗口可达 30+ 秒，外层阶梯覆盖它。后台完成通知与 split 聚合共用。
export const GATE_DISPATCH_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000]
