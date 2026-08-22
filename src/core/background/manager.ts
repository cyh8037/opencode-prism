import {
  ABORT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  MAX_NOTIFICATION_RESULT_CHARS,
  MAX_RETRIES,
  MAX_TOOL_CALLS,
  POLLING_INTERVAL_MS,
  TASK_TTL_MS,
  TERMINAL_TASK_RETENTION_MS,
} from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { isAgentNotFoundError, shouldRetryError, type ErrorInfo } from "../../models"
import { errorInfoFromResult } from "../../shared/api-result"
import { log } from "../../shared/log"
import { collectAssistantText } from "../assistant-text"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import { ConcurrencyManager } from "./concurrency"
import type { BgTask, LaunchInput, QueueItem, SessionStatusMap } from "./types"

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
}

interface ForwardedEvent {
  type: string
  properties?: Record<string, unknown>
}

const TERMINAL_STATUSES = new Set<BgTask["status"]>(["completed", "error", "cancelled"])

function resolveEventSessionID(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined
  const direct = properties.sessionID
  if (typeof direct === "string") return direct
  const info = properties.info
  if (typeof info === "object" && info !== null) {
    const infoSessionID = (info as Record<string, unknown>).sessionID
    if (typeof infoSessionID === "string") return infoSessionID
  }
  return undefined
}

function formatDuration(startedAt: Date | undefined, completedAt: Date | undefined): string {
  if (!startedAt || !completedAt) return "-"
  const seconds = Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m${seconds % 60}s`
}

// includeResults=false omits the per-row result preview — used when the full
// result is injected separately so it is not duplicated.
function buildTaskTable(tasks: BgTask[], includeResults = true): string {
  const rows = tasks
    .map((task) => {
      const error = task.error ? ` - ${task.error.slice(0, 120)}` : ""
      const attempts = task.retries > 0 ? ` (${task.retries + 1} attempts)` : ""
      const result = includeResults && task.resultText ? `\n   结果: ${task.resultText.slice(0, 200)}` : ""
      return (
        `- \`${task.id}\` ${task.description}: ${task.status.toUpperCase()} ` +
        `(${formatDuration(task.startedAt, task.completedAt)})${attempts}${error}${result}`
      )
    })
    .join("\n")
  return rows
}

export class BackgroundManager {
  private tasks = new Map<string, BgTask>()
  private tasksByParentSession = new Map<string, Set<string>>()
  private queuesByKey = new Map<string, QueueItem[]>()
  private processingKeys = new Set<string>()
  private pendingByParent = new Map<string, Set<string>>()
  private notificationQueueByParent = new Map<string, Promise<void>>()
  private terminalListeners = new Set<(task: BgTask) => void>()
  private concurrency: ConcurrencyManager
  private pollingInterval?: ReturnType<typeof setInterval>
  private pollingInFlight = false
  private shutdownTriggered = false
  /** Running tasks already warned about exceeding the TTL (warn once). */
  private ttlWarned = new Set<string>()
  private logger: typeof log

  constructor(private deps: BackgroundManagerDeps) {
    this.concurrency = new ConcurrencyManager(deps.config.background.concurrency ?? DEFAULT_CONCURRENCY)
    this.logger = deps.logger ?? log
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

  private concurrencyKeyFor(model: ResolvedModel | undefined): string {
    return model ? `${model.providerID}/${model.modelID}` : ""
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
      id: `bg_${crypto.randomUUID().slice(0, 8)}`,
      parentSessionId: input.parentSessionId,
      description: input.description,
      prompt: input.prompt,
      parts: input.parts,
      system: input.system,
      agent: input.agent,
      model,
      retries: 0,
      status: "pending",
      queuedAt: new Date(),
      concurrencyGroup: this.concurrencyKeyFor(model),
    }

    this.addTask(task)

    // Toast only the first task of a parent session: batches (/split,
    // --parallel) would otherwise flood the TUI with N "Started" toasts.
    if (this.getTasksByParentSession(input.parentSessionId).length === 1) {
      this.showToast("Prism background task", `Started: ${task.description} (${task.id})`, "info", 4000)
    }

    if (input.parentSessionId) {
      const pending = this.pendingByParent.get(input.parentSessionId) ?? new Set<string>()
      pending.add(task.id)
      this.pendingByParent.set(input.parentSessionId, pending)
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
            await this.abortSession(item.task.sessionId, "startTask error cleanup")
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
        title: `${input.description} (prism)`,
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
      await this.abortSession(sessionID, "cancelled pre-start cleanup")
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

    // The prompt API's model reference is { providerID, modelID } — the
    // { id, providerID } shape session.create accepts is rejected here with
    // 400 (Missing key ["model"]["modelID"]).
    const promptBody: Record<string, unknown> = {
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
      tools: {
        bg_spawn: false,
        bg_cancel: false,
        question: false,
      },
      ...(input.system ? { system: input.system } : {}),
      parts: input.parts ?? [{ type: "text", text: input.prompt, synthetic: true }],
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
      this.notifyParent(task).catch(() => {})
      return
    }
    if (await this.tryRetry(task, errorInfo)) return
    this.finalizeTask(task, "error", errorInfo.message ?? JSON.stringify(errorInfo))
    this.notifyParent(task).catch(() => {})
  }

  // Best-effort toast: never block the flow on it and never throw when the
  // TUI is unavailable (missing API or non-TUI mode). The optional call is
  // essential — a missing showToast would otherwise throw a sync TypeError
  // that .catch() cannot catch.
  private showToast(title: string, message: string, variant: string, duration: number): void {
    const toast = this.deps.client.tui.showToast?.({ body: { title, message, variant, duration } })
    if (toast) {
      void toast.catch((error) => {
        this.logger("[prism] toast failed", { error })
      })
    }
  }

  private classifyError(error: unknown): { name?: string; message?: string; statusCode?: number } {
    if (typeof error === "object" && error !== null) {
      const record = error as Record<string, unknown>
      return {
        name: typeof record.name === "string" ? record.name : undefined,
        message: typeof record.message === "string" ? record.message : undefined,
        statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
      }
    }
    return { message: String(error) }
  }

  private async tryRetry(task: BgTask, errorInfo: { name?: string; message?: string; statusCode?: number }): Promise<boolean> {
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
      await this.abortSession(previousSessionID, "same-model retry")
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

  private async abortSession(sessionID: string, reason: string): Promise<void> {
    try {
      await Promise.race([
        this.deps.client.session.abort({ path: { id: sessionID } }),
        new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS)),
      ])
    } catch (error) {
      this.logger(`[prism] session abort failed during ${reason}`, { sessionID, error })
    }
  }

  handleEvent(event: ForwardedEvent): void {
    const properties = event.properties
    const sessionID = resolveEventSessionID(properties)

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
        void this.validateAndComplete(task, "session.idle event").catch((error) => {
          this.logger("[prism] validateAndComplete failed", { taskId: task.id, error })
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
      const status = properties?.status as { type?: string; message?: string } | undefined
      const task = this.findBySession(sessionID)
      if (task && task.status === "running" && status?.type === "retry") {
        void this.tryRetry(task, { message: status.message })
          .then((retried) => {
            if (!retried) {
              this.finalizeTask(task, "error", status.message ?? "session retry failed")
              this.notifyParent(task).catch(() => {})
            }
          })
          .catch((error) => {
            this.logger("[prism] session.status handling failed", { taskId: task.id, error })
          })
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
        query: { directory: this.deps.directory },
      })
      const messages = response.data
      if (!Array.isArray(messages)) return false

      // Authoritative result capture: part-level events carry no role/state
      // (role lives on the message), so the assistant text is read from the
      // message history right before the task completes. ALL completed
      // assistant texts are joined (capped) so multi-turn children keep
      // their intermediate conclusions.
      if (task && !task.resultText) {
        const text = collectAssistantText(messages, MAX_NOTIFICATION_RESULT_CHARS)
        if (text) task.resultText = text
      }

      return messages.some((message) => {
        const info = (message as { info?: { role?: string } }).info
        if (info?.role !== "assistant" && info?.role !== "tool") return false
        const parts = (message as { parts?: unknown[] }).parts ?? []
        return parts.some((part) => {
          const record = part as Record<string, unknown>
          if (record.type === "text" && typeof record.text === "string" && record.text.trim().length > 0) return true
          if (record.type === "reasoning" && typeof record.text === "string" && record.text.trim().length > 0) return true
          return record.type === "tool"
        })
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

  private async validateAndComplete(task: BgTask, source: string): Promise<void> {
    if (task.status !== "running" || !task.sessionId) return
    const hasOutput = await this.validateSessionHasOutput(task.sessionId, task)
    if (!hasOutput) {
      this.logger("[prism] session idle but no output yet, waiting", { taskId: task.id })
      return
    }
    await this.completeTask(task, source)
  }

  private finalizeTask(task: BgTask, status: BgTask["status"], error?: string): void {
    if (TERMINAL_STATUSES.has(task.status)) return
    task.status = status
    task.completedAt = new Date()
    if (error) task.error = error
    // The run is over: parts (image data URLs can be multi-MB) and the tool
    // dedupe set are only needed while the task can still launch or retry.
    task.parts = undefined
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

  private async completeTask(task: BgTask, source: string): Promise<void> {
    // Reserve the parent gate BEFORE flipping status: between the flip and the
    // wake landing, hasActiveChildTasks() would already report false. The
    // reservation only covers the flip-to-notification queue window; the
    // actual gate dispatch happens after release. Release is
    // scoped to this reservation's source: when two completions overlap, an
    // earlier holder's release must not clear the later holder's reservation.
    const reservationSource = `background-completion:${task.id}`
    this.deps.gate.reserve(task.parentSessionId, reservationSource)

    try {
      this.finalizeTask(task, "completed")

      if (task.sessionId) {
        await this.abortSession(task.sessionId, `task completion (${source})`)
      }
    } finally {
      this.deps.gate.release(task.parentSessionId, reservationSource)
    }

    await this.notifyParent(task)
  }

  async cancelTask(taskId: string, options?: { source?: string; reason?: string; skipNotification?: boolean }): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || TERMINAL_STATUSES.has(task.status)) return false

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
      await this.abortSession(sessionID, `task cancellation (${source})`)
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
  // exists to receive one. Already-terminal tasks are no-ops.
  async cancelAllByParentSession(parentSessionID: string, source: string): Promise<void> {
    const taskIDs = this.tasksByParentSession.get(parentSessionID)
    if (!taskIDs) return
    for (const taskID of Array.from(taskIDs)) {
      await this.cancelTask(taskID, { source, skipNotification: true })
    }
  }

  async resume(taskId: string, prompt: string): Promise<BgTask> {
    const task = this.tasks.get(taskId)
    if (!task || !task.sessionId) {
      throw new Error(`task not found or has no session: ${taskId}`)
    }
    if (task.status === "running") {
      throw new Error(`task ${taskId} is currently running and cannot accept a continuation prompt`)
    }

    await this.concurrency.acquire(task.concurrencyGroup, taskId)
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

    const promptBody: Record<string, unknown> = {
      tools: { bg_spawn: false, bg_cancel: false, question: false },
      parts: [{ type: "text", text: prompt, synthetic: true }],
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

  private notifyParent(task: BgTask): Promise<void> {
    return this.enqueueNotificationForParent(task.parentSessionId, async () => {
      const pending = this.pendingByParent.get(task.parentSessionId)
      if (pending) {
        pending.delete(task.id)
        if (pending.size === 0) this.pendingByParent.delete(task.parentSessionId)
      }
      const remaining = this.getTasksByParentSession(task.parentSessionId).filter(
        (t) => t.status === "running" || t.status === "pending",
      ).length
      const allComplete = remaining === 0
      const isFailure = task.status === "error" || task.status === "cancelled"

      // Wake the parent only when the whole batch settled or a task failed;
      // otherwise a batch of N tasks would wake the parent N times. The toast
      // joins the same condition: one terminal toast per task would flood the
      // TUI on batches (/split, --parallel).
      if (allComplete || isFailure) {
        const variant = task.status === "completed" ? "success" : task.status === "cancelled" ? "warning" : "error"
        this.showToast(
          "Prism background task",
          `${task.status.toUpperCase()}: ${task.description} (${task.id})`,
          variant,
          5000,
        )
        const siblingTasks = this.getTasksByParentSession(task.parentSessionId)

        // Single completed task: inject the FULL result into the parent
        // conversation — a truncated preview leaves the model reporting
        // "完整结果没有注入到本次对话中". Batches keep the per-task
        // previews plus the bg_output pointer instead.
        const singleCompleted = allComplete && siblingTasks.length === 1 && task.status === "completed"
        const resultText = (task.resultText ?? "").trim()
        const fullResult = singleCompleted && resultText.length > 0
        // >= : resultText was itself captured with the same cap, so hitting
        // the cap exactly still means the full output is longer.
        const truncated = resultText.length >= MAX_NOTIFICATION_RESULT_CHARS

        const lines = [
          "<system-reminder>",
          "[PRISM BACKGROUND TASKS]",
          allComplete ? `全部后台任务已结束 (${siblingTasks.length} 个):` : "后台任务状态更新:",
          "",
          buildTaskTable(siblingTasks, !fullResult),
        ]
        if (fullResult) {
          lines.push("", "完整结果:", truncated ? resultText.slice(0, MAX_NOTIFICATION_RESULT_CHARS) : resultText)
          if (truncated) {
            lines.push("", `（结果过长已截断，用 bg_output("${task.id}") 查看完整结果）`)
          }
        } else if (allComplete) {
          lines.push("", "如果需要，可用 bg_output(task_id) 查看完整结果。")
        } else {
          lines.push("", `仍有 ${remaining} 个任务运行中。`, "如果需要，可用 bg_output(task_id) 查看完整结果。")
        }
        lines.push("</system-reminder>")

        await this.deps.gate.dispatch({
          sessionID: task.parentSessionId,
          source: "background-notification",
          text: lines.join("\n"),
        })
      }
    })
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
        if (statusResult.data && typeof statusResult.data === "object") {
          allStatuses = statusResult.data as SessionStatusMap
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

          const hasOutput = await this.validateSessionHasOutput(task.sessionId, task)
          if (!hasOutput) continue

          await this.completeTask(task, "polling (idle)")
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
  }

  async shutdown(): Promise<void> {
    if (this.shutdownTriggered) return
    this.shutdownTriggered = true
    this.stopPolling()

    const aborts = Array.from(this.tasks.values())
      .filter((task) => task.status === "running" && task.sessionId)
      .map((task) => this.abortSession(task.sessionId!, "shutdown"))
    await Promise.allSettled(aborts)

    this.concurrency.clear()
    this.tasks.clear()
    this.tasksByParentSession.clear()
    this.queuesByKey.clear()
    this.processingKeys.clear()
    this.pendingByParent.clear()
    this.notificationQueueByParent.clear()
    this.terminalListeners.clear()
  }
}
