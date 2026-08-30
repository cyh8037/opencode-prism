import { z } from "zod"
import {
  ABORT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  MAX_NOTIFICATION_RESULT_CHARS,
  MAX_RETRIES,
  MAX_STEERING_MSG_BYTES,
  MAX_STEERING_QUEUE_LEN,
  MAX_TOOL_CALLS,
  POLLING_INTERVAL_MS,
  RESUME_ACQUIRE_TIMEOUT_MS,
  STEERING_ACCEPT_TIMEOUT_MS,
  STEERING_MAX_DELIVERY_ATTEMPTS,
  STEERING_SETTLE_GRACE_MS,
  STANDALONE_FLUSH_DELAY_MS,
  TASK_INACTIVITY_TIMEOUT_MS,
  TASK_TTL_MS,
  TERMINAL_TASK_RETENTION_MS,
} from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { isAgentNotFoundError, shouldRetryError, type ErrorInfo } from "../../models"
import { errorInfoFromObject, errorInfoFromResult } from "../../shared/api-result"
import { log } from "../../shared/log"
import { sanitizeSystemReminder } from "../../shared/sanitize"
import { eventSessionID, parseSessionMessages, sessionStatusMapSchema } from "../../shared/session-data"
import { collectAssistantText } from "../assistant-text"
import type { PrismClient, ToastVariant } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import { ConcurrencyManager } from "./concurrency"
import { buildChildSessionTitle, renderCompactDashboard, sanitizeTruncate } from "./visualizer"
import type { BgTask, LaunchInput, QueueItem, SessionStatusMap } from "./types"
import { TERMINAL_TASK_STATUSES } from "./types"

// Resolve the model a child session should use. Implementations read the
// parent session's current model; returns undefined when unavailable.
export type ResolveModelFn = (parentSessionID: string) => Promise<ResolvedModel | undefined>

export interface BackgroundManagerDeps {
  client: PrismClient
  directory: string
  config: PrismConfig
  gate: PromptGate
  resolveModel: ResolveModelFn
  logger?: typeof log
  pollingIntervalMs?: number
  resumeAcquireTimeoutMs?: number
  standaloneFlushDelayMs?: number
}

interface ForwardedEvent {
  type: string
  properties?: Record<string, unknown>
}

// 终态集合收敛到 types.ts 的 TERMINAL_TASK_STATUSES（manager/visualizer/
// scheduler 共用单一定义）。
const TERMINAL_STATUSES = TERMINAL_TASK_STATUSES

// Mid-batch failure toasts inside this window per parent session are
// suppressed (a cascade — provider outage, mass failure — must not flood the
// TUI); the settle summary toast and the injected table still report them.
const FAILURE_TOAST_COALESCE_MS = 8_000

// A child session "has output" when any assistant/tool message carries a tool
// part or a non-empty text/reasoning part (per-part tolerance: malformed
// parts just do not count as output).
const outputSignalPartSchema = z.union([
  z.object({ type: z.literal("tool") }),
  z.object({
    type: z.enum(["text", "reasoning"]),
    text: z.string().refine((text) => text.trim().length > 0),
  }),
])

// Byte-safe truncation for steering messages: slicing at a character count
// can cut mid-UTF-8 (a lone continuation byte breaks the provider request),
// so the message is trimmed to fit MAX_STEERING_MSG_BYTES whole characters.
function truncateSteeringMessage(message: string): string {
  const maxBytes = MAX_STEERING_MSG_BYTES
  if (Buffer.byteLength(message, "utf8") <= maxBytes) return message
  let length = 0
  let bytes = 0
  for (const char of message) {
    const charBytes = Buffer.byteLength(char, "utf8")
    if (bytes + charBytes > maxBytes) break
    bytes += charBytes
    length += char.length
  }
  return message.slice(0, length)
}

// 任务表格已看板化(visualizer.ts):字段级 sanitize/换行压平/控制字符剥离
// 由渲染器统一承担,这里只做结果预览的 includeResults 语义转发。
function buildTaskTable(tasks: BgTask[], includeResults = true): string {
  return renderCompactDashboard(tasks, { includeResults })
}

export class BackgroundManager {
  private tasks = new Map<string, BgTask>()
  private tasksByParentSession = new Map<string, Set<string>>()
  private queuesByKey = new Map<string, QueueItem[]>()
  private processingKeys = new Set<string>()
  private notificationQueueByParent = new Map<string, Promise<void>>()
  /** Terminal tasks parked in resume()'s concurrency wait, cancellable by id. */
  private resumingTaskIds = new Set<string>()
  /** Tasks with an idle-settle in flight: the event path and the polling
   *  sweep can observe the same idle transition, and a concurrent second
   *  settle would complete a task whose steering round just launched. */
  private settlingTaskIds = new Set<string>()
  private terminalListeners = new Set<(task: BgTask) => void>()
  /** In-flight waitForTasks waiters, woken on shutdown. */
  private waitFinishers = new Set<() => void>()
  private concurrency: ConcurrencyManager
  private pollingInterval?: ReturnType<typeof setInterval>
  private pollingInFlight = false
  private resumeAcquireTimeoutMs: number
  private shutdownTriggered = false
  /** Running tasks already warned about exceeding the TTL (warn once). */
  private ttlWarned = new Set<string>()
  /** Per parent session: timestamp of the last mid-batch failure toast
   *  (failure toasts inside FAILURE_TOAST_COALESCE_MS are suppressed). */
  private lastFailureToastAtByParent = new Map<string, number>()
  private logger: typeof log

  constructor(private deps: BackgroundManagerDeps) {
    this.concurrency = new ConcurrencyManager(deps.config.background.concurrency ?? DEFAULT_CONCURRENCY)
    this.logger = deps.logger ?? log
    this.resumeAcquireTimeoutMs = deps.resumeAcquireTimeoutMs ?? RESUME_ACQUIRE_TIMEOUT_MS
  }

  onTaskTerminal(listener: (task: BgTask) => void): void {
    this.terminalListeners.add(listener)
  }

  offTaskTerminal(listener: (task: BgTask) => void): void {
    this.terminalListeners.delete(listener)
  }

  getTask(id: string): BgTask | undefined {
    return this.tasks.get(id)
  }

  getTasksByParentSession(sessionID: string): BgTask[] {
    const taskIDs = this.tasksByParentSession.get(sessionID)
    if (!taskIDs) return []
    const tasks: BgTask[] = []
    for (const taskID of taskIDs) {
      const task = this.tasks.get(taskID)
      if (task) tasks.push(task)
    }
    return tasks
  }

  /** 并发池占用快照(/bg status 看板 header 用)。 */
  getConcurrencySnapshot(): Array<{ key: string; active: number; limit: number }> {
    return this.concurrency.snapshot()
  }

  private addTask(task: BgTask): void {
    this.tasks.set(task.id, task)
    const taskIDs = this.tasksByParentSession.get(task.parentSessionId) ?? new Set<string>()
    taskIDs.add(task.id)
    this.tasksByParentSession.set(task.parentSessionId, taskIDs)
  }

  private findBySession(sessionID: string): BgTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionID) return task
    }
    return undefined
  }

  /** Whether this session is a prism-managed child (bg task / vision
   *  interpretation): auto-triggers must not fire for them — their own
   *  injected prompts carry images that would otherwise recurse. */
  isChildSession(sessionID: string): boolean {
    return this.findBySession(sessionID) !== undefined
  }

  /** The task owning a child session, or undefined when the session is not a
   *  bg-task child. Lets the vision pipeline tell an async vision task apart
   *  from an ordinary subtask (see BgTask.taskType). */
  getTaskBySession(sessionID: string): BgTask | undefined {
    return this.findBySession(sessionID)
  }

  private concurrencyKeyFor(model: ResolvedModel | undefined): string {
    return model ? `${model.providerID}/${model.modelID}` : ""
  }

  // Tool filters for child prompts. The nested bg_* tools and question are
  // always disabled (they would recurse or block on a non-interactive
  // child); split_task too — with split.autoTrigger its description carries
  // proactive-trigger guidance, and a nested run would register under the
  // child session (invisible to the parent's /split status), dispatch its
  // report into a soon-aborted session and bypass this task's circuit
  // breaker. Same face the vision sync child closes via
  // VISION_CHILD_TOOL_FILTERS. vision_look is removed too when the vision
  // feature is disabled entirely, so bg_spawn's read-image guidance never
  // points at a dead tool.
  private childToolFilters(): Record<string, boolean> {
    return {
      bg_spawn: false,
      bg_cancel: false,
      bg_send: false,
      bg_wait: false,
      split_task: false,
      question: false,
      ...(this.deps.config.vision.enabled ? {} : { vision_look: false }),
    }
  }

  async launch(input: LaunchInput): Promise<BgTask> {
    // Shutdown clears the queues but an in-flight processKey loop still holds
    // its array reference; refusing new work here keeps dispose a hard stop.
    if (this.shutdownTriggered) {
      throw new Error("background manager is shutting down, cannot launch tasks")
    }

    // A pinned model (vision interpretation) skips resolution entirely so the
    // child uses exactly the model the gate checked; everything else resolves
    // the parent session's current model at launch time.
    const model = input.model ?? (await this.deps.resolveModel(input.parentSessionId))
    // resolveModel is a network call: shutdown may have landed while we
    // waited, and it clears the maps — the task must not be added afterwards.
    if (this.shutdownTriggered) {
      throw new Error("background manager is shutting down, cannot launch tasks")
    }
    if (!model) {
      throw new Error("无法确定主会话的当前模型，无法启动后台任务")
    }

    const task: BgTask = {
      // 48-bit 随机段（12 hex）：8 位只有 32 位熵，长期驻留的 server 进程
      // 累计任务量下存在生日碰撞窗口，碰撞会静默覆盖 tasks 表里的旧任务。
      id: `bg_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      parentSessionId: input.parentSessionId,
      description: input.description,
      prompt: input.prompt,
      parts: input.parts,
      system: input.system,
      agent: input.agent,
      taskType: input.taskType ?? "default",
      model,
      retries: 0,
      status: "pending",
      queuedAt: new Date(),
      concurrencyGroup: this.concurrencyKeyFor(model),
      notificationGroup: input.notificationGroup,
    }

    this.addTask(task)

    // Toast only the first task of a parent session: batches (/split,
    // --parallel) would otherwise flood the TUI with N "Started" toasts.
    if (this.getTasksByParentSession(input.parentSessionId).length === 1) {
      this.showToast("Prism background task", `Started: ${task.description} (${task.id})`, "info", 4000)
    }

    const key = this.concurrencyKeyFor(model)
    const queue = this.queuesByKey.get(key) ?? []
    queue.push({ task, input, model })
    this.queuesByKey.set(key, queue)

    this.logger("[prism] background task queued", { taskId: task.id, key, queueLength: queue.length })

    void this.processKey(key)
    return task
  }

  private async processKey(key: string): Promise<void> {
    if (this.processingKeys.has(key)) return
    this.processingKeys.add(key)

    try {
      while (!this.shutdownTriggered) {
        // Re-read the queue on every iteration: cancelTask deletes the map
        // entry once its array drains, and a concurrent retry/launch then
        // creates a FRESH array for the same key. A reference captured once
        // outside the loop would go stale and starve the new items until an
        // unrelated launch happened to re-trigger this key.
        const queue = this.queuesByKey.get(key)
        if (!queue || queue.length === 0) break
        const item = queue.shift()
        if (!item) continue

        try {
          await this.concurrency.acquire(key, item.task.id)
        } catch {
          // waiter cancelled
          continue
        }

        if (this.shutdownTriggered || TERMINAL_STATUSES.has(item.task.status)) {
          this.concurrency.release(key)
          continue
        }

        try {
          await this.startTask(item)
        } catch (error) {
          this.logger("[prism] error starting task", { taskId: item.task.id, error })
          // startTask can only throw BEFORE it claims the slot
          // (task.concurrencyKey): once claimed, no awaited call remains that
          // could throw. When it threw unclaimed, the slot acquired above is
          // still ours to release — finalizeTask only releases claimed ones,
          // so skipping this leaked a slot permanently (shrinking the
          // effective concurrency limit until the key stalled entirely).
          const slotClaimed = item.task.concurrencyKey !== undefined
          this.finalizeTask(item.task, "error", error instanceof Error ? error.message : String(error))
          if (!slotClaimed) {
            this.concurrency.release(key)
          }
          if (item.task.sessionId) {
            await this.abortSession(item.task.sessionId, "startTask error cleanup", item.task.directory)
          }
          this.notifyParent(item.task).catch((notifyError) => {
            this.logger("[prism] failed to notify on startTask error", { taskId: item.task.id, error: notifyError })
          })
        }
      }
    } finally {
      this.processingKeys.delete(key)
    }
  }

  private async startTask(item: QueueItem): Promise<void> {
    const { task, input, model } = item

    const parentSession = await this.deps.client.session
      .get({ path: { id: input.parentSessionId }, query: { directory: this.deps.directory } })
      .catch(() => null)
    const parentDirectory = parentSession?.data?.directory ?? this.deps.directory
    task.directory = parentDirectory

    const createResult = await this.deps.client.session.create({
      body: {
        parentID: input.parentSessionId,
        title: buildChildSessionTitle(task.id, input.description, task.retries),
        model: {
          id: model.modelID,
          providerID: model.providerID,
        },
      },
      query: { directory: parentDirectory },
    })

    if (createResult.error || !createResult.data?.id) {
      throw new Error(`failed to create background session: ${String(createResult.error ?? "no session id")}`)
    }

    const sessionID = createResult.data.id

    // shutdown can land while session.create is in flight: its abort snapshot
    // missed this session, so retiring it here is the only chance to avoid an
    // orphaned child running with no manager oversight.
    if (this.shutdownTriggered || TERMINAL_STATUSES.has(task.status)) {
      this.concurrency.release(this.concurrencyKeyFor(model))
      await this.abortSession(sessionID, "cancelled pre-start cleanup", task.directory)
      if (this.shutdownTriggered) {
        this.finalizeTask(task, "cancelled", "background manager shut down during session creation")
      }
      return
    }

    task.status = "running"
    task.startedAt = new Date()
    task.sessionId = sessionID
    task.progress = { toolCalls: 0, lastUpdate: new Date() }
    task.concurrencyKey = this.concurrencyKeyFor(model)

    this.startPolling()

    // Steering queued while the task was still pending joins the LAUNCH
    // round — a corrective message must not wait out the entire first round.
    // Written back onto task.parts so the same-model retry path replays it.
    const launchParts: Array<Record<string, unknown>> = [
      ...(input.parts ?? [{ type: "text", text: input.prompt, synthetic: true }]),
    ]
    const pendingSteering = task.steeringQueue?.splice(0, task.steeringQueue.length) ?? []
    if (pendingSteering.length > 0) {
      launchParts.push(...pendingSteering.map((text) => ({ type: "text", text, synthetic: true })))
      task.parts = launchParts
      this.logger("[prism] merging queued steering into the launch round", {
        taskId: task.id,
        count: pendingSteering.length,
      })
    }

    // The prompt API's model reference is { providerID, modelID } — the
    // { id, providerID } shape session.create accepts is rejected here with
    // 400 (Missing key ["model"]["modelID"]).
    const promptBody: Record<string, unknown> = {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      tools: this.childToolFilters(),
      ...(input.system ? { system: input.system } : {}),
      parts: launchParts,
    }
    if (input.agent) {
      promptBody.agent = input.agent
    }

    this.logger("[prism] launching background task", { taskId: task.id, sessionID, model })

    // Fire-and-forget; the client resolves 4xx/5xx with { error } instead of
    // rejecting, so both the resolved error field and rejections are checked.
    this.deps.client.session
      .promptAsync({ path: { id: sessionID }, body: promptBody, query: { directory: parentDirectory } })
      .then((result) => {
        void this.handlePromptFailure(task, errorInfoFromResult(result))
      })
      .catch((error) => {
        void this.handlePromptFailure(task, this.classifyError(error))
      })

  }

  // Shared failure path for a child prompt: agent-not-found short-circuits,
  // retryable errors relaunch, everything else finalizes the task. undefined
  // errorInfo means the call succeeded.
  private async handlePromptFailure(task: BgTask, errorInfo: ErrorInfo | undefined): Promise<void> {
    if (!errorInfo) return
    if (isAgentNotFoundError(errorInfo) && task.agent) {
      this.finalizeTask(
        task,
        "error",
        `agent "${task.agent}" not found. Register it in your opencode config or omit the agent parameter.`,
      )
      await this.abortOrphanSession(task)
      this.notifyParent(task).catch(() => {})
      return
    }
    if (await this.tryRetry(task, errorInfo)) return
    this.finalizeTask(task, "error", errorInfo.message ?? JSON.stringify(errorInfo))
    // The prompt was rejected (or the launch gave up): the created child
    // session would otherwise linger as an empty orphan in the TUI child
    // navigation forever. The retry path aborts its own previous session;
    // only the terminal-error path needs this cleanup.
    await this.abortOrphanSession(task)
    this.notifyParent(task).catch(() => {})
  }

  // Abort the task's child session after a terminal failure, if it still
  // exists. Best-effort: abortSession never throws.
  private async abortOrphanSession(task: BgTask): Promise<void> {
    if (!task.sessionId) return
    await this.abortSession(task.sessionId, "terminal prompt failure cleanup", task.directory)
  }

  // Best-effort toast: never block the flow on it and never throw when the
  // TUI is unavailable (missing API or non-TUI mode). The optional call is
  // essential — a missing showToast would otherwise throw a sync TypeError
  // that .catch() cannot catch.
  private showToast(title: string, message: string, variant: ToastVariant, duration: number): void {
    const toast = this.deps.client.tui.showToast?.({ body: { title, message, variant, duration } })
    if (toast) {
      void toast.catch((error) => {
        this.logger("[prism] toast failed", { error })
      })
    }
  }

  private classifyError(error: unknown): { name?: string; message?: string; statusCode?: number } {
    if (typeof error === "object" && error !== null) {
      return errorInfoFromObject(error)
    }
    return { message: String(error) }
  }

  private async tryRetry(task: BgTask, errorInfo: { name?: string; message?: string; statusCode?: number }): Promise<boolean> {
    // Shutdown clears the queues; re-queueing here would strand the task as a
    // forever-pending object nothing will ever start.
    if (this.shutdownTriggered) return false
    // Reentrancy latch: two failure signals for the same task can overlap (a
    // prompt rejection racing the same run's session.error event, or two
    // prompts after a racing double-resume). The first caller flips the task
    // to "pending" below — synchronously, before its abort await — so a
    // concurrent second caller observes a non-running status here. It must
    // NOT report "not retried": a false would send its caller into
    // finalizeTask(error) and kill a task the winner is about to relaunch.
    // true = "the task's fate is owned elsewhere (a retry in flight, or
    // already terminal) — do not finalize".
    if (task.status !== "running") return true
    const retryable = shouldRetryError(errorInfo)
    if (!retryable) return false
    if (task.retries >= MAX_RETRIES) {
      this.logger("[prism] retry budget exhausted", {
        taskId: task.id,
        retries: task.retries,
        error: errorInfo.message?.slice(0, 100),
      })
      return false
    }
    const model = task.model
    if (!model) return false

    this.logger("[prism] retryable error, retrying with the same model", {
      taskId: task.id,
      model: model,
      error: errorInfo.message?.slice(0, 100),
      retries: task.retries + 1,
    })

    const previousSessionID = task.sessionId
    if (previousSessionID) {
      // Clear the session link BEFORE aborting: the abort may emit
      // session.deleted, which would otherwise re-enter cancellation for a
      // task the manager itself is retiring.
      task.sessionId = undefined
      task.status = "pending"
      await this.abortSession(previousSessionID, "same-model retry", task.directory)
    }

    // The task may have been cancelled while the abort was in flight; let the
    // cancellation stand instead of relaunching it.
    if (TERMINAL_STATUSES.has(task.status)) return true

    if (task.concurrencyKey) {
      this.concurrency.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    task.retries += 1
    task.queuedAt = new Date()
    // stale-prune anchors pending tasks on startedAt ?? queuedAt — a first
    // start 30 minutes ago would otherwise get the retry cancelled as a
    // "queued task exceeded the TTL" the moment it re-queues.
    task.startedAt = undefined

    const key = this.concurrencyKeyFor(model)
    const queue = this.queuesByKey.get(key) ?? []
    queue.push({
      task,
      input: {
        description: task.description,
        prompt: task.prompt,
        parts: task.parts,
        system: task.system,
        parentSessionId: task.parentSessionId,
        agent: task.agent,
        // A vision task stays a vision task across the retry: the relaunched
        // child carries the same injected image, and the recursion guard
        // must keep treating it as an interpretation session.
        taskType: task.taskType,
      },
      model,
    })
    this.queuesByKey.set(key, queue)
    void this.processKey(key)

    this.showToast(
      "Prism retry",
      `${task.description}: 同模型重试 (${model.providerID}/${model.modelID})`,
      "warning",
      4000,
    )
    return true
  }

  private async abortSession(sessionID: string, reason: string, directory?: string): Promise<void> {
    // The race only bounds the WAIT. Converting the abort's own rejection
    // into a log here means a failure landing after the timeout is still
    // recorded (and never surfaces as an unhandled rejection) — Promise.race
    // would otherwise swallow it without a trace. directory scopes the
    // request to the session's own project (task.directory) — the same
    // parameter every other session route in this manager passes; without it
    // an abort for a cross-directory child may not resolve.
    const abort = this.deps.client.session
      .abort({ path: { id: sessionID }, ...(directory ? { query: { directory } } : {}) })
      .then(
        () => undefined,
        (error) => {
          this.logger(`[prism] session abort failed during ${reason}`, { sessionID, error })
        },
      )
    await Promise.race([abort, new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS))])
  }

  handleEvent(event: ForwardedEvent): void {
    const properties = event.properties
    const sessionID = eventSessionID(properties)

    if (event.type === "message.part.updated" && sessionID) {
      const task = this.findBySession(sessionID)
      if (task && task.status === "running") {
        const part = properties?.part
        if (typeof part === "object" && part !== null) {
          const record = part as Record<string, unknown>
          task.progress = task.progress ?? { toolCalls: 0, lastUpdate: new Date() }
          task.progress.lastUpdate = new Date()
          if (record.type === "tool" || record.tool) {
            // Count each tool part once: part.updated fires repeatedly per
            // part (state transitions), and counting every update would
            // inflate the circuit-breaker budget.
            const partID =
              typeof record.id === "string" ? record.id : typeof record.callID === "string" ? record.callID : undefined
            if (partID) {
              task.progress.toolPartIds = task.progress.toolPartIds ?? new Set<string>()
              if (task.progress.toolPartIds.has(partID)) {
                if (typeof record.tool === "string") task.progress.lastTool = record.tool
                return
              }
              task.progress.toolPartIds.add(partID)
            }
            task.progress.toolCalls += 1
            if (typeof record.tool === "string") task.progress.lastTool = record.tool
            this.checkCircuitBreaker(task)
          }
          // Text parts carry no role/state fields (role lives on the message),
          // so assistant text is identified by exclusion: plugin-sent prompts
          // are marked synthetic, everything else text in a task session is
          // the model's reply. Best-effort only — the authoritative capture
          // happens via the messages API in validateSessionHasOutput.
          if (
            record.type === "text" &&
            record.synthetic !== true &&
            typeof record.text === "string" &&
            record.text.trim().length > 0
          ) {
            task.resultText = record.text
          }
        }
      }
      return
    }

    if (event.type === "session.idle" && sessionID) {
      const task = this.findBySession(sessionID)
      if (task && task.status === "running") {
        void this.settleIdleTask(task, "session.idle event").catch((error) => {
          this.logger("[prism] settleIdleTask failed", { taskId: task.id, error })
        })
      }
      return
    }

    if (event.type === "session.error" && sessionID) {
      const task = this.findBySession(sessionID)
      if (task && task.status === "running") {
        const error = properties?.error as { name?: string; message?: string } | undefined
        const errorInfo = {
          name: error?.name,
          message: error?.message ?? (typeof properties?.error === "string" ? properties.error : undefined),
        }
        void this.tryRetry(task, errorInfo)
          .then((retried) => {
            if (!retried) {
              this.finalizeTask(task, "error", errorInfo.message ?? "session error")
              this.notifyParent(task).catch(() => {})
            }
          })
          .catch((error) => {
            this.logger("[prism] session.error handling failed", { taskId: task.id, error })
          })
      }
      return
    }

    if (event.type === "session.deleted" && sessionID) {
      const task = this.findBySession(sessionID)
      if (task && (task.status === "running" || task.status === "pending")) {
        void this.cancelTask(task.id, { source: "session.deleted" }).catch((error) => {
          this.logger("[prism] session.deleted handling failed", { taskId: task.id, error })
        })
      }
      return
    }

    if (event.type === "session.status" && sessionID) {
      // session.status 的 "retry" 是宿主 provider 退避的**瞬态**（两次尝试
      // 之间的等待，1.18 实测；见 prompt-gate.isBusyStatus 与轮询路径对
      // busy/retry 的同款处理）——绝不能当失败终止任务：退避中的子会话
      // 随后可能成功，这里 abort+重建会丢上下文、与宿主重试叠加并烧掉
      // MAX_RETRIES 预算。终态失败以 session.error 事件为准。此处仅把
      // 状态翻转当作活跃信号刷新看门狗锚点（退避期间没有 part.updated
      // 事件，长退避 otherwise 会被 inactivity watchdog 误杀）。
      const task = this.findBySession(sessionID)
      if (task && task.status === "running" && task.progress) {
        task.progress.lastUpdate = new Date()
      }
      return
    }
  }

  private checkCircuitBreaker(task: BgTask): void {
    const progress = task.progress
    if (!progress) return
    if (progress.toolCalls >= MAX_TOOL_CALLS) {
      this.logger("[prism] circuit breaker: tool call limit reached", { taskId: task.id })
      void this.cancelTask(task.id, {
        source: "circuit-breaker",
        reason: `subagent exceeded maximum tool call limit, likely an infinite loop`,
      })
    }
  }

  private async validateSessionHasOutput(sessionID: string, task?: BgTask): Promise<boolean> {
    try {
      const response = await this.deps.client.session.messages({
        path: { id: sessionID },
        // The child may live in the PARENT's project directory (startTask
        // creates it under parentDirectory), which can differ from the
        // plugin's own directory — query with the task's directory like
        // deliverSteering/resume do, or the read fails and the task can
        // never be verified (fail-closed would then park it until the
        // watchdog kills it 30 minutes later).
        query: { directory: task?.directory ?? this.deps.directory },
      })
      const messages = parseSessionMessages(response.data)

      // Authoritative result capture: part-level events carry no role/state
      // (role lives on the message), so the assistant text is read from the
      // message history right before the task completes. ALL completed
      // assistant texts are joined (capped) so multi-turn children keep
      // their intermediate conclusions. This capture ALWAYS overwrites the
      // event-path value — including clearing it when the history holds no
      // completed assistant text (e.g. a tool-only ending): the event path
      // records any non-synthetic text part, which since TUI child-session
      // navigation includes the user's own typed input in the child, and
      // that must never be reported as the task's result.
      if (task) {
        task.resultText = collectAssistantText(messages, MAX_NOTIFICATION_RESULT_CHARS) ?? undefined
      }

      return messages.some((message) => {
        if (message.info.role !== "assistant" && message.info.role !== "tool") return false
        return (message.parts ?? []).some((part) => outputSignalPartSchema.safeParse(part).success)
      })
    } catch (error) {
      this.logger("[prism] failed to validate session output", { sessionID, error })
      // Cannot verify — fail CLOSED: never complete (and abort) a task we
      // could not check; its child session may still be running server-side.
      // The sweep retries on the next interval; worst case the TTL backstop
      // cancels the task instead of falsely completing it.
      return false
    }
  }

  // Idle-boundary settlement: the single gate through which a running task
  // either (a) is still waiting for output, (b) starts a queued steering
  // round, or (c) completes. Guarded per task: the event path and the sweep
  // both land here for the same idle transition, and racing settles would
  // complete a task whose steering round just launched.
  private async settleIdleTask(task: BgTask, source: string): Promise<void> {
    if (task.status !== "running" || !task.sessionId) return
    if (this.settlingTaskIds.has(task.id)) return
    this.settlingTaskIds.add(task.id)
    // Pin the session for this whole settle: every awaited step below can
    // observe a same-model retry (which clears task.sessionId and re-queues
    // the task as pending). Completing after that would race the relaunch —
    // the task would flip to "completed" while the retry queue still holds a
    // launch item for it.
    const sessionID = task.sessionId
    try {
      const hasOutput = await this.validateSessionHasOutput(sessionID, task)
      if (!hasOutput) {
        this.logger("[prism] session idle but no output yet, waiting", { taskId: task.id })
        return
      }
      if (await this.deliverSteering(task)) return
      if (task.status !== "running" || task.sessionId !== sessionID) return // settled while we awaited
      if (!(await this.confirmStillIdle(sessionID, task))) return
      // A message may have queued while the confirmation call was in flight —
      // send() only checks status === "running", which still held. Completing
      // now would silently drop it (finalize clears the queue) after the
      // caller was already told "已排队"; hand it to the next idle boundary.
      if (task.steeringQueue && task.steeringQueue.length > 0) return
      await this.completeTask(task, source, sessionID)
    } finally {
      this.settlingTaskIds.delete(task.id)
    }
  }

  // Fresh, per-session completion confirmation. The caller's idle signal can
  // be stale by the time we get here: the sweep iterates a status snapshot
  // taken seconds earlier (earlier settles stall on aborts and gate
  // dispatches), and an idle snapshot from BEFORE a steering round was
  // accepted must never complete the task. Completion therefore re-reads the
  // status at decision time and only proceeds on a confirmed idle session.
  // sessionID is the session pinned by the caller's settle — NOT a live read
  // of task.sessionId, which a concurrent same-model retry may have cleared.
  private async confirmStillIdle(sessionID: string, task: BgTask): Promise<boolean> {
    // The status map itself can lag acceptance (the server marks busy
    // slightly after promptAsync resolves): the grace window bridges that
    // regardless of what a fresh read says.
    if (task.lastSteeringDeliveredAt) {
      const sinceMs = Date.now() - task.lastSteeringDeliveredAt.getTime()
      if (sinceMs < STEERING_SETTLE_GRACE_MS) {
        this.logger("[prism] steering round recently accepted, deferring completion", {
          taskId: task.id,
          sinceMs,
        })
        return false
      }
    }
    try {
      const response = await this.deps.client.session.status()
      const parsedMap = sessionStatusMapSchema.safeParse(response.data)
      if (!parsedMap.success) return false
      const type = parsedMap.data[sessionID]?.type
      // Absent entries ARE the idle state (the map only lists non-idle
      // sessions); anything else is left to the next sweep.
      if (type === undefined || type === "idle") return true
      this.logger("[prism] session not idle on fresh check, deferring completion", {
        taskId: task.id,
        type,
      })
      return false
    } catch (error) {
      // Fail closed: completing (and aborting) on unverifiable state is the
      // exact bug this check exists to prevent.
      this.logger("[prism] fresh status check failed, deferring completion", { taskId: task.id, error })
      return false
    }
  }

  // Deliver queued steering messages as ONE continuation round, at the idle
  // boundary and before completion is declared — the "message queued for
  // delivery at its next tool round" semantic, bounded to round boundaries
  // (the finest granularity a plugin can observe). Acceptance is AWAITED
  // (unlike launch): only after the server accepted the prompt is the mutex
  // released, so the next sweep cannot re-enter settle and complete the task
  // before the round starts. Returns true when a round was launched (or a
  // failed delivery was re-queued) — the caller must NOT complete the task.
  private async deliverSteering(task: BgTask): Promise<boolean> {
    const queue = task.steeringQueue
    if (!queue || queue.length === 0 || !task.sessionId) return false

    const sessionID = task.sessionId
    const messages = queue.splice(0, queue.length)
    task.steeringAttempts = (task.steeringAttempts ?? 0) + 1

    const promptBody: Record<string, unknown> = {
      tools: this.childToolFilters(),
      parts: messages.map((text) => ({ type: "text", text, synthetic: true })),
    }
    if (task.agent) promptBody.agent = task.agent
    if (task.model) {
      promptBody.model = {
        providerID: task.model.providerID,
        modelID: task.model.modelID,
      }
    }

    this.logger("[prism] delivering steering messages", { taskId: task.id, count: messages.length })

    let accepted = false
    let failureReason: string | undefined
    let acceptanceTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const acceptance = await Promise.race([
        this.deps.client.session
          .promptAsync({
            path: { id: sessionID },
            body: promptBody,
            query: { directory: task.directory ?? this.deps.directory },
          })
          .then((result) => ({ ok: true as const, result })),
        // A hung call would stall the sweep inside the settle mutex; racing
        // it treats a late landing as a delivery failure (the message is
        // re-queued, worst case delivered twice — never silently lost).
        new Promise<{ ok: false }>((resolve) => {
          acceptanceTimer = setTimeout(() => resolve({ ok: false }), STEERING_ACCEPT_TIMEOUT_MS)
        }),
      ]).finally(() => {
        if (acceptanceTimer) clearTimeout(acceptanceTimer)
      })
      if (acceptance.ok) {
        const errorInfo = errorInfoFromResult(acceptance.result)
        if (errorInfo) failureReason = errorInfo.message ?? JSON.stringify(errorInfo)
        else accepted = true
      } else {
        failureReason = `prompt acceptance timed out after ${STEERING_ACCEPT_TIMEOUT_MS}ms`
      }
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error)
    }

    // The task may have settled (cancelled, or errored into a retry) while we
    // awaited acceptance — the message went to a session that no longer
    // belongs to this round. Terminal tasks discard silently: no success
    // toast, no anchor resets, and the failure path must not resurrect the
    // queue. Anything non-terminal (a retry still pending, or already
    // relaunched on a fresh session) instead re-queues the batch: the
    // acceptance was for a session the manager itself is retiring, and a
    // pending relaunch merges queued steering into its first round while a
    // relaunched task delivers it at its next idle boundary — dropping it
    // here would lose a message the caller saw "已排队" for.
    if (task.status !== "running" || task.sessionId !== sessionID) {
      this.logger("[prism] task settled while steering delivery was in flight", {
        taskId: task.id,
        status: task.status,
      })
      if (!TERMINAL_STATUSES.has(task.status)) {
        task.steeringQueue = [...messages, ...(task.steeringQueue ?? [])]
      }
      return true
    }

    if (!accepted) {
      this.handleSteeringDeliveryFailure(task, messages, failureReason ?? "unknown delivery failure")
      return true
    }

    // The round was accepted: refresh the lifecycle anchors and restart the
    // tool budget — steering is user-driven continuation, not a runaway
    // loop, so the circuit-breaker budget counts per round.
    task.steeringAttempts = 0
    task.lastSteeringDeliveredAt = new Date()
    task.startedAt = new Date()
    this.ttlWarned.delete(task.id)
    task.progress = {
      toolCalls: 0,
      // Keep the part-id set: late part.updated events from the previous
      // round would otherwise count against the fresh budget.
      toolPartIds: task.progress?.toolPartIds,
      lastUpdate: new Date(),
      lastTool: task.progress?.lastTool,
    }
    this.showToast("Prism background task", `补充指令已投递: ${task.description} (${task.id})`, "info", 4000)
    return true
  }

  // A failed delivery re-queues the messages for the next idle boundary —
  // deliberately NOT the launch retry path, which aborts the child and
  // discards its accumulated context. Past the attempt cap the batch is
  // dropped and the task settles normally on the next idle check; messages
  // queued AFTER this delivery started have never been tried and survive.
  // A dead child surfaces through the status map (session.deleted / error).
  private handleSteeringDeliveryFailure(task: BgTask, messages: string[], reason: string): void {
    this.logger("[prism] steering delivery failed", {
      taskId: task.id,
      reason,
      attempts: task.steeringAttempts,
    })
    if ((task.steeringAttempts ?? 0) >= STEERING_MAX_DELIVERY_ATTEMPTS) {
      task.steeringAttempts = 0
      this.showToast(
        "Prism background task",
        `补充指令投递失败已放弃（${reason.slice(0, 80)}）: ${task.description} (${task.id})`,
        "error",
        6000,
      )
      return
    }
    task.steeringQueue = [...messages, ...(task.steeringQueue ?? [])]
    this.showToast("Prism background task", `补充指令投递失败，将重试: ${task.description} (${task.id})`, "warning", 4000)
  }

  private finalizeTask(task: BgTask, status: BgTask["status"], error?: string): void {
    if (TERMINAL_STATUSES.has(task.status)) return
    task.status = status
    task.completedAt = new Date()
    if (error) task.error = error
    // The run is over: parts (image data URLs can be multi-MB) and the tool
    // dedupe set are only needed while the task can still launch or retry.
    task.parts = undefined
    // Cancel/error supersede any queued steering (settle delivers before
    // completing, so a terminal task has nothing deliverable left anyway).
    task.steeringQueue = undefined
    task.steeringAttempts = 0
    if (task.progress) task.progress.toolPartIds = undefined
    if (task.concurrencyKey) {
      this.concurrency.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }
    for (const listener of this.terminalListeners) {
      // A throwing listener must not abort the remaining listeners nor
      // propagate into the status-flip path.
      try {
        listener(task)
      } catch (error) {
        this.logger("[prism] terminal listener failed (swallowed)", { taskId: task.id, error })
      }
    }
    if (!this.hasRunningTasks()) this.stopPolling()
  }

  private async completeTask(task: BgTask, source: string, expectedSessionID: string): Promise<void> {
    // The task may have settled (e.g. cancelled) while confirmStillIdle's
    // status call was in flight — notifyParent would then duplicate the
    // cancellation notice.
    if (TERMINAL_STATUSES.has(task.status)) return
    // A same-model retry re-queues the task (status -> pending, sessionId
    // cleared) while a settle is in flight. status "pending" passes the
    // terminal check above, so completing here would flip a task the retry
    // queue is about to relaunch — with the retry's child then aborted
    // mid-run by this completion's abortSession. Exit instead and let the
    // retry own the task.
    if (task.status !== "running" || !task.sessionId) return
    // Identity check against the session the settle pinned: the retry may
    // have already relaunched the task on a FRESH child (status "running"
    // again, sessionId = the new child) by the time we get here. The idle
    // confirmation was for the OLD session — completing now would mark the
    // task done and abort its just-relaunched child mid-run. Only complete
    // when the task still owns the session this settle confirmed idle.
    if (task.sessionId !== expectedSessionID) return
    // Reserve the parent gate BEFORE flipping status: the reservation makes
    // any OTHER source's injection queued during this window (e.g. a split
    // aggregation report) wait inside the gate, so the completion notice is
    // dispatched before whatever a sibling settle enqueues — this serializes
    // injection ORDER, not settle visibility (status checks never consult
    // the reservation). The actual gate dispatch happens after release.
    // Release is scoped to this reservation's source: when two completions
    // overlap, an earlier holder's release must not clear the later holder's
    // reservation.
    const reservationSource = `background-completion:${task.id}`
    this.deps.gate.reserve(task.parentSessionId, reservationSource)

    try {
      this.finalizeTask(task, "completed")

      if (task.sessionId) {
        await this.abortSession(task.sessionId, `task completion (${source})`, task.directory)
      }
    } finally {
      this.deps.gate.release(task.parentSessionId, reservationSource)
    }

    await this.notifyParent(task)
  }

  async cancelTask(taskId: string, options?: { source?: string; reason?: string; skipNotification?: boolean }): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task) return false
    if (TERMINAL_STATUSES.has(task.status)) {
      // A terminal task parked in resume()'s concurrency wait cannot be
      // cancelled (it already finished) — but its stuck bg_send call can and
      // must be unblocked.
      if (this.resumingTaskIds.delete(taskId)) {
        this.concurrency.cancelWaiter(task.concurrencyGroup, taskId)
      }
      return false
    }

    const source = options?.source ?? "cancel"

    if (task.status === "pending") {
      const key = task.concurrencyKey ?? task.concurrencyGroup
      const queue = this.queuesByKey.get(key)
      if (queue) {
        const index = queue.findIndex((item) => item.task.id === taskId)
        if (index !== -1) {
          queue.splice(index, 1)
          if (queue.length === 0) this.queuesByKey.delete(key)
        }
      }
      this.concurrency.cancelWaiter(key, taskId)
      this.logger("[prism] cancelled pending task", { taskId, key })
    }

    if (task.status === "running" && task.sessionId) {
      const sessionID = task.sessionId
      // Clear the link before aborting so a session.deleted event cannot
      // re-enter cancellation for the same task.
      task.sessionId = undefined
      await this.abortSession(sessionID, `task cancellation (${source})`, task.directory)
    }

    this.finalizeTask(task, "cancelled", options?.reason)

    if (options?.skipNotification !== true) {
      await this.notifyParent(task).catch((error) => {
        this.logger("[prism] failed to notify on cancel", { taskId, error })
      })
    }
    return true
  }

  // Retire every task owned by a parent session (e.g. the parent was deleted):
  // children are aborted and no wake is dispatched — the parent no longer
  // exists to receive one. Already-terminal tasks are no-ops. Aborts run in
  // parallel: each is bounded by ABORT_TIMEOUT_MS, and a serial loop would
  // multiply that by the task count on the /bg cancel command path.
  async cancelAllByParentSession(parentSessionID: string, source: string): Promise<void> {
    const taskIDs = this.tasksByParentSession.get(parentSessionID)
    if (!taskIDs) return
    await Promise.all(
      Array.from(taskIDs).map((taskID) => this.cancelTask(taskID, { source, skipNotification: true })),
    )
  }

  /** Send a follow-up to a task. Running/pending: the message is queued and
   *  delivered as one round at the child's next idle boundary — mid-run
   *  steering that never interrupts the child and keeps its context.
   *  Terminal: identical to resume (continue the finished child session). */
  async send(taskId: string, message: string): Promise<{ task: BgTask; queued: boolean; queueLength: number }> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (this.shutdownTriggered) throw new Error("background manager is shutting down, cannot send messages")
    if (task.status === "running" || task.status === "pending") {
      // The queue lives on the task for its whole lifecycle, so an unbounded
      // stream of bg_send calls would balloon memory; the cap rejects new
      // sends while the current backlog is still undelivered.
      const queueLength = task.steeringQueue?.length ?? 0
      if (queueLength >= MAX_STEERING_QUEUE_LEN) {
        throw new Error(
          `任务 ${taskId} 的补充指令队列已满（${MAX_STEERING_QUEUE_LEN} 条未投递），请等待下一轮投递后再发送`,
        )
      }
      // The queued text is injected into the child's prompt verbatim — a
      // multi-MB message would overflow the context window. Truncate with a
      // log instead of rejecting: the caller already saw the send succeed.
      const effective = truncateSteeringMessage(message)
      if (effective !== message) {
        this.logger("[prism] steering message truncated to MAX_STEERING_MSG_BYTES", {
          taskId: task.id,
          originalBytes: Buffer.byteLength(message, "utf8"),
        })
      }
      task.steeringQueue = [...(task.steeringQueue ?? []), effective]
      this.logger("[prism] steering message queued", {
        taskId: task.id,
        queueLength: task.steeringQueue.length,
      })
      return { task, queued: true, queueLength: task.steeringQueue.length }
    }
    const resumed = await this.resume(taskId, truncateSteeringMessage(message))
    return { task: resumed, queued: false, queueLength: 0 }
  }

  /** Resolve when every given task reaches a terminal state, or when the
   *  timeout lapses. Pruned/unknown ids resolve immediately (nothing to wait
   *  for); the caller decides how to report them. */
  async waitForTasks(taskIds: string[], timeoutMs: number): Promise<{ tasks: BgTask[]; timedOut: boolean }> {
    const ids = new Set(taskIds)
    const settled = () => {
      for (const id of ids) {
        const task = this.tasks.get(id)
        // Absent = pruned or unknown; terminal tasks are only pruned long
        // after settling, so absence never hides unfinished work here.
        if (task && !TERMINAL_STATUSES.has(task.status)) return false
      }
      return true
    }

    if (settled()) return { tasks: this.snapshotTasks(ids), timedOut: false }

    return new Promise((resolve) => {
      const finish = (timedOut: boolean) => {
        this.terminalListeners.delete(listener)
        this.waitFinishers.delete(wake)
        clearTimeout(timer)
        resolve({ tasks: this.snapshotTasks(ids), timedOut })
      }
      const listener = () => {
        if (settled()) finish(false)
      }
      // shutdown() wakes in-flight waiters instead of leaving them hung on
      // their own timeout (bounded, but up to BG_WAIT_MAX_MS).
      const wake = () => finish(true)
      const timer = setTimeout(() => finish(true), Math.max(0, timeoutMs))
      this.terminalListeners.add(listener)
      this.waitFinishers.add(wake)
    })
  }

  private snapshotTasks(ids: Set<string>): BgTask[] {
    const tasks: BgTask[] = []
    for (const id of ids) {
      const task = this.tasks.get(id)
      if (task) tasks.push(task)
    }
    return tasks
  }

  async resume(taskId: string, prompt: string): Promise<BgTask> {
    const task = this.tasks.get(taskId)
    if (!task || !task.sessionId) {
      throw new Error(`task not found or has no session: ${taskId}`)
    }
    if (task.status === "running") {
      throw new Error(`task ${taskId} is currently running and cannot accept a continuation prompt`)
    }
    // Reentrancy guard: two concurrent bg_send calls on the same terminal
    // task would both pass the checks above, both acquire a slot and both
    // prompt the SAME child session — the second rejected busy (a spurious
    // task error mid-continuation) or the continuation doubled. The set
    // membership below is established synchronously before the first await,
    // so a concurrent second call reliably observes it.
    if (this.resumingTaskIds.has(taskId)) {
      throw new Error(`任务 ${taskId} 已有一个进行中的恢复等待，请等待其完成后再发送新指令`)
    }

    const key = task.concurrencyGroup
    // A saturated group would park this wait forever (running tasks past the
    // TTL are only warned, never killed), and a terminal task cannot be
    // cancelled out of the wait the normal way — bound it so bg_send
    // returns an error instead of hanging the tool round.
    this.resumingTaskIds.add(taskId)
    try {
      const outcome = await Promise.race([
        this.concurrency.acquire(key, taskId).then(
          () => "acquired" as const,
          () => "cancelled" as const,
        ),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.resumeAcquireTimeoutMs)),
      ])
      if (outcome === "timeout") {
        // The waiter may have been handed a slot in the same instant the
        // timeout fired; failing to return it would permanently shrink the
        // group's effective limit.
        if (!this.concurrency.cancelWaiter(key, taskId)) {
          this.concurrency.release(key)
        }
        throw new Error(
          `任务 ${taskId} 所在模型组的并发槽已满（等待 ${Math.round(this.resumeAcquireTimeoutMs / 1000)} 秒超时），请稍后重试，或用 /bg status 查看占用中的任务`,
        )
      }
      if (outcome === "cancelled") {
        throw new Error(`任务 ${taskId} 的恢复等待已被取消（任务已取消或插件正在关闭）`)
      }
    } finally {
      this.resumingTaskIds.delete(taskId)
    }
    task.concurrencyKey = task.concurrencyGroup
    task.status = "running"
    task.completedAt = undefined
    task.error = undefined
    task.startedAt = new Date()
    task.progress = {
      toolCalls: task.progress?.toolCalls ?? 0,
      toolPartIds: task.progress?.toolPartIds,
      lastUpdate: new Date(),
    }

    this.startPolling()

    // Residual steering messages (e.g. queued while the task errored out)
    // join the continuation round instead of waiting for another boundary.
    const queued = task.steeringQueue ?? []
    task.steeringQueue = []
    task.steeringAttempts = 0

    const promptBody: Record<string, unknown> = {
      tools: this.childToolFilters(),
      parts: [
        ...queued.map((text) => ({ type: "text", text, synthetic: true })),
        { type: "text", text: prompt, synthetic: true },
      ],
    }
    if (task.agent) promptBody.agent = task.agent
    if (task.model) {
      promptBody.model = {
        providerID: task.model.providerID,
        modelID: task.model.modelID,
      }
    }

    this.deps.client.session
      .promptAsync({
        path: { id: task.sessionId },
        body: promptBody,
        query: { directory: task.directory ?? this.deps.directory },
      })
      .then((result) => {
        void this.handlePromptFailure(task, errorInfoFromResult(result))
      })
      .catch((error) => {
        void this.handlePromptFailure(task, this.classifyError(error))
      })

    return task
  }

  // Terminal toasts, keyed off notifyParent's settle condition. The settle
  // path (allComplete) summarizes the WHOLE parent task set — its message
  // must not borrow the last-settling task's identity: in a mixed batch the
  // old single-task toast read as a green "success" even when siblings had
  // failed. The mid-batch failure path stays per-task (it is the urgent,
  // actionable signal) but coalesces repeats inside a short window so a
  // cascade cannot flood the TUI — the settle summary still reports counts.
  private showTerminalToast(task: BgTask, siblingTasks: BgTask[], allComplete: boolean): void {
    if (allComplete && siblingTasks.length > 1) {
      const ok = siblingTasks.filter((t) => t.status === "completed").length
      const bad = siblingTasks.filter((t) => t.status === "error").length
      const cancelled = siblingTasks.length - ok - bad
      const parts = [`${ok} 成功`, `${bad} 失败`]
      if (cancelled > 0) parts.push(`${cancelled} 取消`)
      this.showToast(
        "Prism background task",
        `全部后台任务已结束: ${parts.join(", ")}`,
        bad > 0 ? "error" : cancelled > 0 ? "warning" : "success",
        5000,
      )
      this.lastFailureToastAtByParent.delete(task.parentSessionId)
      return
    }
    if (!allComplete) {
      const now = Date.now()
      const last = this.lastFailureToastAtByParent.get(task.parentSessionId)
      if (last !== undefined && now - last < FAILURE_TOAST_COALESCE_MS) return
      this.lastFailureToastAtByParent.set(task.parentSessionId, now)
    }
    // task.error carries the provider/API reason for both error and
    // cancelled (finalizeTask writes the reason there) — surface a cleaned
    // excerpt so the toast is actionable without waiting for the injection.
    const reason = (task.error ?? "").trim()
    const suffix = reason ? `: ${sanitizeTruncate(reason, 80)}` : ""
    const variant = task.status === "completed" ? "success" : task.status === "cancelled" ? "warning" : "error"
    this.showToast(
      "Prism background task",
      `${task.status.toUpperCase()}: ${task.description} (${task.id})${suffix}`,
      variant,
      5000,
    )
  }

  // 完成通知的批次语义：同 notificationGroup（拆分 run 传入 run id）的
  // 任务共享一次通知，组内全部终态才唤醒父会话（N 个子任务绝不逐个唤醒）；
  // 不带组号的独立任务（/bg 单发、bg_spawn、--parallel）在自己的终态上
  // 立即进入通知流程——绝不因同会话仍有其他批次在跑而被吞掉（2026-08-30
  // 事故：拆分进行中插入的 /bg 任务完成后，"父会话全量门控"把它的完成
  // 通知静默压到整个拆分结束）。独立任务按父会话做短窗合并（--parallel N
  // 几乎同时结束时合并为一条）；失败/取消仍立即上报（可行动信号，不进
  // 合并窗口）。toast 的收尾汇总语义与旧实现保持一致（父会话全部终态时
  // 汇总，失败即时逐条），只有注入走新批次语义。
  private notifyParent(task: BgTask): Promise<void> {
    return this.enqueueNotificationForParent(task.parentSessionId, async () => {
      const isFailure = task.status === "error" || task.status === "cancelled"
      if (isFailure) {
        const remaining = this.getTasksByParentSession(task.parentSessionId).filter(
          (t) => t.status === "running" || t.status === "pending",
        ).length
        this.showTerminalToast(task, [task], false)
        await this.dispatchBatchNotification(task, [task], { allComplete: false, remaining })
        return
      }
      if (task.notificationGroup) {
        const group = this.getTasksByParentSession(task.parentSessionId).filter(
          (t) => t.notificationGroup === task.notificationGroup,
        )
        const remaining = group.filter((t) => t.status === "running" || t.status === "pending").length
        // 组未收尾保持静默——唤醒由组内最后一个终态任务触发。
        if (remaining > 0) return
        this.showTerminalToast(task, group, true)
        await this.dispatchBatchNotification(task, group, { allComplete: true, remaining: 0 })
        return
      }
      this.scheduleStandaloneFlush(task)
    })
  }

  // 独立任务完成通知的合并窗口状态（按父会话）。timer 只在首个任务入窗时
  // 安排；窗口到达先刷出已终态的任务，不等仍在跑的——窗口是合并手段，
  // 绝不是门控。
  private standaloneFlushStates = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; pendingTaskIds: Set<string> }
  >()

  private scheduleStandaloneFlush(task: BgTask): void {
    const parentSessionID = task.parentSessionId
    const state = this.standaloneFlushStates.get(parentSessionID) ?? { pendingTaskIds: new Set<string>() }
    state.pendingTaskIds.add(task.id)
    if (!state.timer) {
      const delay = this.shutdownTriggered ? 0 : (this.deps.standaloneFlushDelayMs ?? STANDALONE_FLUSH_DELAY_MS)
      state.timer = setTimeout(() => {
        void this.flushStandaloneNotifications(parentSessionID).catch((error) => {
          this.logger("[prism] standalone notification flush failed", { parentSessionID, error })
        })
      }, delay)
    }
    this.standaloneFlushStates.set(parentSessionID, state)
  }

  private async flushStandaloneNotifications(parentSessionID: string): Promise<void> {
    const state = this.standaloneFlushStates.get(parentSessionID)
    if (!state) return
    this.standaloneFlushStates.delete(parentSessionID)
    if (state.timer) clearTimeout(state.timer)
    const tasks = Array.from(state.pendingTaskIds)
      .map((id) => this.tasks.get(id))
      .filter((t): t is BgTask => t !== undefined)
    if (tasks.length === 0) return
    await this.enqueueNotificationForParent(parentSessionID, async () => {
      // 窗口内任务按构造已全部终态（失败走即时路径不进窗）；取注册表里的
      // 最新对象，已清剪的用捕获快照兜底。
      const cohort = tasks.map((t) => this.tasks.get(t.id) ?? t)
      const parentTasks = this.getTasksByParentSession(parentSessionID)
      const parentActive = parentTasks.some((t) => t.status === "running" || t.status === "pending")
      // toast 的收尾汇总沿用旧语义：本窗是父会话最后一批时汇总全部任务，
      // 否则只汇总本窗（transient toast，窗口内合并）。
      this.showTerminalToast(cohort[cohort.length - 1]!, parentActive ? cohort : parentTasks, true)
      await this.dispatchBatchNotification(cohort[cohort.length - 1]!, cohort, { allComplete: true, remaining: 0 })
    })
  }

  // 组装并注入一条完成通知。cohort 是本次通知覆盖的任务集合：组 = 全组，
  // 独立任务合并窗 = 窗口内终态的任务，失败 = 出错的任务本身。toast 由
  // 调用方按批次语义决定（收尾汇总 vs 逐条），这里只负责注入。
  private async dispatchBatchNotification(
    task: BgTask,
    cohort: BgTask[],
    opts: { allComplete: boolean; remaining: number },
  ): Promise<void> {
    const { allComplete, remaining } = opts

    // Single completed task: inject the FULL result into the parent
    // conversation — a truncated preview leaves the model reporting
    // "完整结果没有注入到本次对话中". Batches keep the per-task
    // previews plus the bg_output pointer instead.
    const singleCompleted = allComplete && cohort.length === 1 && task.status === "completed"
    const resultText = (task.resultText ?? "").trim()
    const fullResult = singleCompleted && resultText.length > 0
    // >= : resultText was itself captured with the same cap, so hitting
    // the cap exactly still means the full output is longer.
    const truncated = resultText.length >= MAX_NOTIFICATION_RESULT_CHARS

    // 标题诚实性：父会话还有进行中任务（其他独立任务/拆分 run）时不得
    // 声称"全部后台任务已结束"——本次批次结束 ≠ 全部结束。
    const parentActive = this.getTasksByParentSession(task.parentSessionId).some(
      (t) => t.status === "running" || t.status === "pending",
    )
    const header = allComplete
      ? parentActive
        ? `后台任务已完成 (${cohort.length} 个):`
        : `全部后台任务已结束 (${cohort.length} 个):`
      : "后台任务状态更新:"

    const lines = [
      "<system-reminder>",
      "[PRISM BACKGROUND TASKS]",
      header,
      "",
      // 看板是 markdown 管道表格(方案 a):web 端 GFM 解析器渲染为 HTML
      // 表格,因此**不包代码围栏**(围栏会使 web 端表格降级为代码块、
      // 含中文列错位)。模型转达时保留 | 列分隔即可,两端渲染都正确。
      "请把下方的状态看板表格原样转达给用户（保留表格的 | 列分隔结构，不要改写为列表、不要添加 emoji 或任何符号）：",
      "",
      buildTaskTable(cohort, !fullResult),
    ]
    if (fullResult) {
      // The result is untrusted child output embedded inside the
      // <system-reminder> block — escape the close tag so a hostile or
      // accidental "</system-reminder>" cannot break out of it.
      lines.push(
        "",
        "完整结果:",
        sanitizeSystemReminder(truncated ? resultText.slice(0, MAX_NOTIFICATION_RESULT_CHARS) : resultText),
      )
      if (truncated) {
        lines.push("", `（结果过长已截断，用 bg_output("${task.id}") 查看完整结果）`)
      }
    } else if (allComplete) {
      lines.push("", "如果需要，可用 bg_output(task_id) 查看完整结果。")
    } else {
      lines.push("", `仍有 ${remaining} 个任务运行中。`, "如果需要，可用 bg_output(task_id) 查看完整结果。")
    }
    lines.push("</system-reminder>")

    // The dispatch carries the ONLY copy of the batch report into the
    // parent conversation — a dropped one is lost forever (no caller
    // re-enqueues). The gate's inner retries cover immediate rejections;
    // the outer backoff ladder covers a parent that stays busy longer
    // than the settle window (a long human turn), matching the split
    // aggregation's retry semantics.
    const dispatch = await this.deps.gate.dispatchWithRetry({
      sessionID: task.parentSessionId,
      source: "background-notification",
      text: lines.join("\n"),
    })
    if (dispatch.status === "failed") {
      this.logger("[prism] background completion notification lost (retries exhausted)", {
        taskId: task.id,
        parentSessionID: task.parentSessionId,
        error: dispatch.error,
      })
    }
  }

  private enqueueNotificationForParent(parentSessionID: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.notificationQueueByParent.get(parentSessionID) ?? Promise.resolve()
    const current = previous
      .catch((error) => {
        this.logger("[prism] continuing notification queue after previous failure", {
          parentSessionID,
          error,
        })
      })
      .then(operation)
    this.notificationQueueByParent.set(parentSessionID, current)
    void current.then(
      () => {
        if (this.notificationQueueByParent.get(parentSessionID) === current) {
          this.notificationQueueByParent.delete(parentSessionID)
        }
      },
      () => {
        if (this.notificationQueueByParent.get(parentSessionID) === current) {
          this.notificationQueueByParent.delete(parentSessionID)
        }
      },
    )
    return current
  }

  private hasRunningTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === "running") return true
    }
    return false
  }

  private startPolling(): void {
    if (this.pollingInterval || this.shutdownTriggered) return
    this.pollingInterval = setInterval(() => {
      void this.pollRunningTasks()
    }, this.deps.pollingIntervalMs ?? POLLING_INTERVAL_MS)
  }

  private stopPolling(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = undefined
    }
  }

  private async pollRunningTasks(): Promise<void> {
    if (this.pollingInFlight) return
    this.pollingInFlight = true
    try {
      let allStatuses: SessionStatusMap | undefined
      let statusMapAvailable = false
      try {
        const statusResult = await this.deps.client.session.status()
        const parsedStatuses = sessionStatusMapSchema.safeParse(statusResult.data)
        if (parsedStatuses.success) {
          allStatuses = parsedStatuses.data
          statusMapAvailable = true
        }
      } catch {
        // session.status unavailable (network/restart): treated below as a
        // skip-the-sweep signal, NOT as "everything is idle" — that would
        // falsely complete tasks and abort their still-running children.
      }

      this.pruneStaleTasks()

      // Without the status map there is no way to tell idle from busy or
      // deleted; completing anything now would be guesswork. The sweep
      // retries on the next interval instead.
      if (!statusMapAvailable) return

      for (const task of this.tasks.values()) {
        // Per-task isolation: a rejection escaping one iteration would abort
        // the rest of the sweep and surface as an unhandled rejection in the
        // host process (whose stderr leaks into the TUI).
        try {
          if (task.status !== "running" || !task.sessionId) continue

          // The status map only contains non-idle sessions (idle entries are
          // removed when they settle), so an absent entry IS the idle state.
          const sessionStatus = allStatuses?.[task.sessionId]?.type
          if (sessionStatus === "busy" || sessionStatus === "retry") {
            continue
          }

          // Terminal failure states: never mark a failed session "completed".
          if (sessionStatus === "error") {
            this.logger("[prism] session errored (polled status)", { taskId: task.id, sessionID: task.sessionId })
            this.finalizeTask(task, "error", "child session errored (polled as error status)")
            this.notifyParent(task).catch((notifyError) => {
              this.logger("[prism] failed to notify on polled error", { taskId: task.id, error: notifyError })
            })
            continue
          }
          if (sessionStatus === "deleted") {
            await this.cancelTask(task.id, { source: "polling (session deleted)" })
            continue
          }

          // Idle (or an unavailable status map) is a completion candidate;
          // unknown future statuses are skipped rather than assumed done.
          if (sessionStatus !== undefined && sessionStatus !== "idle") continue

          await this.settleIdleTask(task, "polling (idle)")
        } catch (error) {
          this.logger("[prism] polling iteration failed for task (swallowed)", { taskId: task.id, error })
        }
      }
    } finally {
      this.pollingInFlight = false
    }
  }

  // Drop a terminal task from the maps once its batch report has long been
  // delivered (or the task never got that far) — keeps a long-lived TUI
  // session from accumulating unbounded task state.
  private removeTask(task: BgTask): void {
    this.tasks.delete(task.id)
    const siblings = this.tasksByParentSession.get(task.parentSessionId)
    if (!siblings) return
    siblings.delete(task.id)
    if (siblings.size === 0) this.tasksByParentSession.delete(task.parentSessionId)
  }

  private pruneStaleTasks(): void {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.status === "running" || task.status === "pending") {
        // Inactivity watchdog runs before the TTL logic: a silent hang and a
        // long-running task look identical to the TTL (same anchor age), but
        // only the former has a stale lastUpdate. Cancelling here must skip
        // the TTL branch too — its warn-only toast would claim the task
        // "仍在继续" right after the kill.
        if (task.status === "running") {
          const lastActivity = task.progress?.lastUpdate
          if (lastActivity && now - lastActivity.getTime() > TASK_INACTIVITY_TIMEOUT_MS) {
            this.logger("[prism] inactivity watchdog: cancelling silent task", { taskId: task.id })
            void this.cancelTask(task.id, {
              source: "inactivity-watchdog",
              reason: `子任务无任何输出活动超过 ${Math.round(TASK_INACTIVITY_TIMEOUT_MS / 60_000)} 分钟，已由看门狗取消（疑似挂起）`,
            }).catch((error) => {
              this.logger("[prism] watchdog cancel failed", { taskId: task.id, error })
            })
            continue
          }
        }
        const anchor = task.startedAt ?? task.queuedAt
        if (anchor && now - anchor.getTime() > TASK_TTL_MS) {
          if (task.status === "pending") {
            // A queued task stuck past the TTL is an anomaly (dead queue,
            // leaked slot) — cancelling is safe.
            this.logger("[prism] pruning stale queued task", { taskId: task.id })
            void this.cancelTask(task.id, {
              source: "stale-prune",
              reason: "queued task exceeded the 30 minute TTL",
            })
          } else if (!this.ttlWarned.has(task.id)) {
            // A RUNNING task past the TTL may be legitimate long work —
            // warn once and let it run; a hard cancel killed real tasks.
            this.ttlWarned.add(task.id)
            this.logger("[prism] running task exceeded the TTL (warning only, not cancelled)", {
              taskId: task.id,
            })
            this.showToast(
              "Prism background task",
              `任务 ${task.id} 已运行超过 30 分钟，仍在继续（不会自动取消）`,
              "warning",
              6000,
            )
          }
        }
        continue
      }
      // Terminal tasks: prune once past the retention window. The batch report
      // is dispatched at the last task's completion, and TASK_TTL_MS bounds
      // how long a batch can outlive a sibling, so a 1h window is safe.
      if (task.completedAt && now - task.completedAt.getTime() > TERMINAL_TASK_RETENTION_MS) {
        this.logger("[prism] pruning retained terminal task", { taskId: task.id })
        this.ttlWarned.delete(task.id)
        this.removeTask(task)
      }
    }
    // Failure-toast timestamps for parents with no tasks left (session
    // deleted, everything pruned) have no batch left to coalesce for.
    for (const parent of this.lastFailureToastAtByParent.keys()) {
      if (!this.tasksByParentSession.get(parent)?.size) this.lastFailureToastAtByParent.delete(parent)
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownTriggered) return
    this.shutdownTriggered = true
    this.stopPolling()

    const aborts = Array.from(this.tasks.values())
      .filter((task) => task.status === "running" && task.sessionId)
      .map((task) => this.abortSession(task.sessionId!, "shutdown", task.directory))
    await Promise.allSettled(aborts)

    this.concurrency.clear()
    this.tasks.clear()
    this.tasksByParentSession.clear()
    this.queuesByKey.clear()
    this.processingKeys.clear()
    this.notificationQueueByParent.clear()
    this.settlingTaskIds.clear()
    this.terminalListeners.clear()
    for (const wake of this.waitFinishers) {
      try {
        wake()
      } catch (error) {
        this.logger("[prism] wait finisher failed on shutdown (swallowed)", { error })
      }
    }
    this.waitFinishers.clear()
  }
}
