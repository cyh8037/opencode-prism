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
export const BG_WAIT_DEFAULT_MS = 120_000
export const BG_WAIT_MAX_MS = 600_000
// resume (bg_send on a terminal task) waits for the model group's concurrency
// slot. Running tasks past the TTL are only warned, never killed, so a
// saturated group could park the wait forever — and a terminal task cannot be
// cancelled out of the wait. Bounded here, the bg_send call returns an error
// instead of hanging the tool round.
export const RESUME_ACQUIRE_TIMEOUT_MS = 15_000

// split
export const MAX_SUBTASKS = 12
export const PLANNER_SYNC_TIMEOUT_MS = 120_000

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
