import {
  ABORT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  MAX_RETRIES,
  MAX_TOOL_CALLS,
  POLLING_INTERVAL_MS,
  TASK_TTL_MS,
} from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { isAgentNotFoundError, shouldRetryError } from "../../models"
import { log } from "../../shared/log"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import { ConcurrencyManager } from "./concurrency"
import type { BgTask, LaunchInput, QueueItem, SessionStatusMap } from "./types"

// Resolve the model a child session should use. Implementations read the
// parent session's current model; returns undefined when unavailable.
export type ResolveModelFn = (parentSessionID: string) => Promise<ResolvedModel | undefined>

export interface TaskSessionEvent {
  sessionID: string
  parentID: string
  description: string
  directory: string
}

export interface BackgroundManagerDeps {
  client: PrismClient
  directory: string
  config: PrismConfig
  gate: PromptGate
  resolveModel: ResolveModelFn
  onSessionCreated?: (event: TaskSessionEvent) => void
  onSessionDeleted?: (event: { sessionID: string }) => void
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

function buildTaskTable(tasks: BgTask[]): string {
  const rows = tasks
    .map((task) => {
      const error = task.error ? ` - ${task.error.slice(0, 120)}` : ""
      const attempts = task.retries > 0 ? ` (${task.retries + 1} attempts)` : ""
      const result = task.resultText ? `\n   结果: ${task.resultText.slice(0, 200)}` : ""
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
  private logger: typeof log

  constructor(private deps: BackgroundManagerDeps) {
    this.concurrency = new ConcurrencyManager(deps.config.background.concurrency ?? DEFAULT_CONCURRENCY)
    this.logger = deps.logger ?? log
  }

  onTaskTerminal(listener: (task: BgTask) => void): void {
    this.terminalListeners.add(listener)
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

  hasActiveChildTasks(sessionID: string): boolean {
    return this.getTasksByParentSession(sessionID).some(
      (task) => task.status === "running" || task.status === "pending",
    )
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

  private concurrencyKeyFor(model: ResolvedModel | undefined): string {
    return model ? `${model.providerID}/${model.modelID}` : ""
  }

  async launch(input: LaunchInput): Promise<BgTask> {
    const model = await this.deps.resolveModel(input.parentSessionId)
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
      suppressTmux: input.suppressTmux,
    }

    this.addTask(task)

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
      const queue = this.queuesByKey.get(key)
      while (queue && queue.length > 0) {
        const item = queue.shift()
        if (!item) continue

        try {
          await this.concurrency.acquire(key, item.task.id)
        } catch {
          // waiter cancelled
          continue
        }

        if (TERMINAL_STATUSES.has(item.task.status)) {
          this.concurrency.release(key)
          continue
        }

        try {
          await this.startTask(item)
        } catch (error) {
          this.logger("[prism] error starting task", { taskId: item.task.id, error })
          this.finalizeTask(item.task, "error", error instanceof Error ? error.message : String(error))
          if (item.task.concurrencyKey) {
            this.concurrency.release(item.task.concurrencyKey)
            item.task.concurrencyKey = undefined
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

    const createResult = await this.deps.client.session.create({
      body: {
        parentID: input.parentSessionId,
        title: `${input.description} (prism)`,
        model: {
          id: model.modelID,
          providerID: model.providerID,
          ...(model.variant ? { variant: model.variant } : {}),
        },
      },
      query: { directory: parentDirectory },
    })

    if (createResult.error || !createResult.data?.id) {
      throw new Error(`failed to create background session: ${String(createResult.error ?? "no session id")}`)
    }

    const sessionID = createResult.data.id

    if (TERMINAL_STATUSES.has(task.status)) {
      this.concurrency.release(this.concurrencyKeyFor(model))
      await this.abortSession(sessionID, "cancelled pre-start cleanup")
      return
    }

    task.status = "running"
    task.startedAt = new Date()
    task.sessionId = sessionID
    task.progress = { toolCalls: 0, lastUpdate: new Date() }
    task.concurrencyKey = this.concurrencyKeyFor(model)

    if (!task.suppressTmux) {
      this.deps.onSessionCreated?.({
        sessionID,
        parentID: input.parentSessionId,
        description: input.description,
        directory: parentDirectory,
      })
    }

    this.startPolling()

    const promptBody: Record<string, unknown> = {
      model: {
        id: model.modelID,
        providerID: model.providerID,
        ...(model.variant ? { variant: model.variant } : {}),
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

    // Fire-and-forget; failures surface via the catch below.
    this.deps.client.session
      .promptAsync({ path: { id: sessionID }, body: promptBody, query: { directory: parentDirectory } })
      .catch(async (error) => {
        const errorInfo = this.classifyError(error)
        if (isAgentNotFoundError(errorInfo) && input.agent) {
          this.finalizeTask(
            task,
            "error",
            `agent "${input.agent}" not found. Register it in your opencode config or omit the agent parameter.`,
          )
          this.notifyParent(task).catch(() => {})
          return
        }
        if (await this.tryRetry(task, errorInfo)) return
        this.finalizeTask(task, "error", errorInfo.message ?? String(error))
        this.notifyParent(task).catch(() => {})
      })

    await this.deps.client.tui.showToast({
      body: {
        title: "Prism background task",
        message: `Started: ${task.description} (${task.id})`,
        variant: "info",
        duration: 4000,
      },
    }).catch(() => {})
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
      await this.abortSession(previousSessionID, "same-model retry")
      this.deps.onSessionDeleted?.({ sessionID: previousSessionID })
    }

    if (task.concurrencyKey) {
      this.concurrency.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }

    task.retries += 1
    task.sessionId = undefined
    task.status = "pending"
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
        suppressTmux: task.suppressTmux,
      },
      model,
    })
    this.queuesByKey.set(key, queue)
    void this.processKey(key)

    await this.deps.client.tui.showToast({
      body: {
        title: "Prism retry",
        message: `${task.description}: 同模型重试 (${model.providerID}/${model.modelID})`,
        variant: "warning",
        duration: 4000,
      },
    }).catch(() => {})
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
            task.progress.toolCalls += 1
            if (typeof record.tool === "string") task.progress.lastTool = record.tool
            this.checkCircuitBreaker(task)
          }
          if (record.type === "text" && record.role === "assistant") {
            const state = record.state as Record<string, unknown> | undefined
            if (state?.status === "completed" && typeof record.text === "string" && record.text.trim().length > 0) {
              task.resultText = record.text
            }
          }
        }
      }
      return
    }

    if (event.type === "session.idle" && sessionID) {
      const task = this.findBySession(sessionID)
      if (task && task.status === "running") {
        void this.validateAndComplete(task, "session.idle event")
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
        void this.tryRetry(task, errorInfo).then((retried) => {
          if (!retried) {
            this.finalizeTask(task, "error", errorInfo.message ?? "session error")
            this.notifyParent(task).catch(() => {})
          }
        })
      }
      return
    }

    if (event.type === "session.deleted" && sessionID) {
      const task = this.findBySession(sessionID)
      if (task && (task.status === "running" || task.status === "pending")) {
        void this.cancelTask(task.id, { source: "session.deleted" })
      }
      return
    }

    if (event.type === "session.status" && sessionID) {
      const status = properties?.status as { type?: string; message?: string } | undefined
      const task = this.findBySession(sessionID)
      if (task && task.status === "running" && status?.type === "retry") {
        void this.tryRetry(task, { message: status.message }).then((retried) => {
          if (!retried) {
            this.finalizeTask(task, "error", status.message ?? "session retry failed")
            this.notifyParent(task).catch(() => {})
          }
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

  private async validateSessionHasOutput(sessionID: string): Promise<boolean> {
    try {
      const response = await this.deps.client.session.messages({
        path: { id: sessionID },
        query: { directory: this.deps.directory },
      })
      const messages = response.data
      if (!Array.isArray(messages)) return false
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
      return true
    }
  }

  private async validateAndComplete(task: BgTask, source: string): Promise<void> {
    if (task.status !== "running" || !task.sessionId) return
    const hasOutput = await this.validateSessionHasOutput(task.sessionId)
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
    if (task.concurrencyKey) {
      this.concurrency.release(task.concurrencyKey)
      task.concurrencyKey = undefined
    }
    for (const listener of this.terminalListeners) {
      listener(task)
    }
    if (!this.hasRunningTasks()) this.stopPolling()
  }

  private async completeTask(task: BgTask, source: string): Promise<void> {
    // Reserve the parent gate BEFORE flipping status: between the flip and the
    // wake landing, hasActiveChildTasks() would already report false. The
    // reservation only covers the flip-to-notification queue window; the
    // actual gate dispatch happens after release (same two-phase design as
    // oh-my-openagent's notification-preparation reservation).
    this.deps.gate.reserve(task.parentSessionId, `background-completion:${task.id}`)

    try {
      this.finalizeTask(task, "completed")

      if (task.sessionId) {
        await this.abortSession(task.sessionId, `task completion (${source})`)
        this.deps.onSessionDeleted?.({ sessionID: task.sessionId })
      }
    } finally {
      this.deps.gate.release(task.parentSessionId)
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
      await this.abortSession(task.sessionId, `task cancellation (${source})`)
      this.deps.onSessionDeleted?.({ sessionID: task.sessionId })
    }

    this.finalizeTask(task, "cancelled", options?.reason)

    if (options?.skipNotification !== true) {
      await this.notifyParent(task).catch((error) => {
        this.logger("[prism] failed to notify on cancel", { taskId, error })
      })
    }
    return true
  }

  // Cancel a pending task without aborting any session or notifying.
  async cancelPendingTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "pending") return false
    return this.cancelTask(taskId, { source: "cancelPendingTask", skipNotification: true })
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
    task.progress = { toolCalls: task.progress?.toolCalls ?? 0, lastUpdate: new Date() }

    this.startPolling()

    const promptBody: Record<string, unknown> = {
      tools: { bg_spawn: false, bg_cancel: false, question: false },
      parts: [{ type: "text", text: prompt, synthetic: true }],
    }
    if (task.agent) promptBody.agent = task.agent
    if (task.model) {
      promptBody.model = {
        id: task.model.modelID,
        providerID: task.model.providerID,
        ...(task.model.variant ? { variant: task.model.variant } : {}),
      }
    }

    this.deps.client.session
      .promptAsync({ path: { id: task.sessionId }, body: promptBody, query: { directory: this.deps.directory } })
      .catch(async (error) => {
        const errorInfo = this.classifyError(error)
        if (await this.tryRetry(task, errorInfo)) return
        this.finalizeTask(task, "error", errorInfo.message ?? String(error))
        this.notifyParent(task).catch(() => {})
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

      const variant = task.status === "completed" ? "success" : "error"
      await this.deps.client.tui
        .showToast({
          body: {
            title: "Prism background task",
            message: `${task.status.toUpperCase()}: ${task.description} (${task.id})`,
            variant,
            duration: 5000,
          },
        })
        .catch(() => {})

      // Wake the parent only when the whole batch settled or a task failed;
      // otherwise a batch of N tasks would wake the parent N times.
      if (allComplete || isFailure) {
        const siblingTasks = this.getTasksByParentSession(task.parentSessionId)
        const notification = [
          "<system-reminder>",
          "[PRISM BACKGROUND TASKS]",
          allComplete ? `全部后台任务已结束 (${siblingTasks.length} 个):` : "后台任务状态更新:",
          "",
          buildTaskTable(siblingTasks),
          allComplete ? "" : `仍有 ${remaining} 个任务运行中。`,
          "如果需要，可用 bg_output(task_id) 查看完整结果。",
          "</system-reminder>",
        ]
          .filter((line) => line !== "")
          .join("\n")

        await this.deps.gate.dispatch({
          sessionID: task.parentSessionId,
          source: "background-notification",
          text: notification,
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
      try {
        const statusResult = await this.deps.client.session.status()
        if (statusResult.data && typeof statusResult.data === "object") {
          allStatuses = statusResult.data as SessionStatusMap
        }
      } catch {
        // session.status unavailable; fall through to per-task validation
      }

      this.pruneStaleTasks()

      for (const task of this.tasks.values()) {
        if (task.status !== "running" || !task.sessionId) continue

        const sessionStatus = allStatuses?.[task.sessionId]?.type
        if (sessionStatus === "active" || sessionStatus === "running" || sessionStatus === "busy") {
          continue
        }

        const hasOutput = await this.validateSessionHasOutput(task.sessionId)
        if (!hasOutput) continue

        await this.completeTask(task, sessionStatus === "idle" ? "polling (idle)" : "polling")
      }
    } finally {
      this.pollingInFlight = false
    }
  }

  private pruneStaleTasks(): void {
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.status !== "running" && task.status !== "pending") continue
      const anchor = task.startedAt ?? task.queuedAt
      if (anchor && now - anchor.getTime() > TASK_TTL_MS) {
        this.logger("[prism] pruning stale task", { taskId: task.id })
        void this.cancelTask(task.id, {
          source: "stale-prune",
          reason: "task exceeded the 30 minute TTL",
        })
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownTriggered) return
    this.shutdownTriggered = true
    this.logger("[prism] shutting down BackgroundManager")
    this.stopPolling()

    const aborts = Array.from(this.tasks.values())
      .filter((task) => task.status === "running" && task.sessionId)
      .map((task) => this.abortSession(task.sessionId!, "shutdown"))
    await Promise.allSettled(aborts)

    for (const task of this.tasks.values()) {
      if (task.sessionId) {
        this.deps.onSessionDeleted?.({ sessionID: task.sessionId })
      }
    }

    this.concurrency.clear()
    this.tasks.clear()
    this.tasksByParentSession.clear()
    this.queuesByKey.clear()
    this.processingKeys.clear()
    this.pendingByParent.clear()
    this.notificationQueueByParent.clear()
    this.terminalListeners.clear()
    this.logger("[prism] shutdown complete")
  }
}
