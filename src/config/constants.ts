// Hardcoded defaults for everything deliberately kept out of user config.
// See the design doc section "移除项与固定值". Open these only on demand.

// Same-model multi-provider resolution order: direct API > official gateway > relay.
export const DEFAULT_PROVIDER_PRIORITY = [
  "anthropic",
  "openai",
  "deepseek",
  "kimi-for-coding",
  "moonshotai",
  "anthropic-api",
  "quotio-openai",
  "github-copilot",
  "opencode",
  "vercel",
]

// vision
export const MAX_IMAGES_PER_BATCH = 4
export const VISION_SYNC_TIMEOUT_MS = 120_000
// messages.transform blocks the LLM call while an interpretation is pending;
// this caps that wait — longer interpretations are injected as a failure note
// and the first answer proceeds without the image content.
export const VISION_TRANSFORM_WAIT_MS = 15_000
// Sync interpretation polls the child's message history for the result; a
// shorter interval detects the LLM's answer sooner (the chat.message hook
// blocks the message pipeline while waiting), at the cost of more API calls.
export const VISION_INTERPRET_POLL_MS = 250
// Bounded wait for the session's first chat.params snapshot: chat.message
// (trigger B) fires before the session's first LLM call, so a fresh session
// has no capability snapshot yet when an image arrives.
export const VISION_SNAPSHOT_WAIT_MS = 3000
export const VISION_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const VISION_CATEGORY = "vision"
export const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

// background
export const DEFAULT_CONCURRENCY = 5
export const MAX_RETRIES = 1
export const TASK_TTL_MS = 30 * 60 * 1000
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

// split
export const MAX_SUBTASKS = 12
export const PLANNER_CATEGORY = "deep"
export const PLANNER_SYNC_TIMEOUT_MS = 120_000

// tmux
export const TMUX_MAIN_PANE_SIZE = 60
export const TMUX_MAIN_PANE_MIN_WIDTH = 120
export const TMUX_AGENT_PANE_MIN_WIDTH = 40
export const TMUX_MAX_AGENT_PANES = 6
export const DEFAULT_SERVER_PORT = 4096
export const SESSION_READY_POLL_MS = 500
export const SESSION_READY_TIMEOUT_MS = 30_000

// parent wake
export const PARENT_WAKE_DEBOUNCE_MS = 100
export const PARENT_WAKE_HOLD_MS = 300
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
