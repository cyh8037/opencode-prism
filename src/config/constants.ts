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

export const VARIANT_VALUES = ["off", "low", "medium", "high", "xhigh", "max"] as const

// vision
export const MAX_IMAGES_PER_BATCH = 4
export const DEDUPE_WINDOW_MS = 3000
export const VISION_SYNC_TIMEOUT_MS = 120_000
export const VISION_IMAGE_MAX_BYTES = 8 * 1024 * 1024
export const VISION_CATEGORY = "vision"
export const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

// background
export const DEFAULT_CONCURRENCY = 5
export const MAX_RETRIES = 1
export const TASK_TTL_MS = 30 * 60 * 1000
export const POLLING_INTERVAL_MS = 3000
export const ABORT_TIMEOUT_MS = 10_000
export const SESSION_GONE_MIN_POLLS = 3
export const MAX_TOOL_CALLS = 4000
export const CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = 20

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
