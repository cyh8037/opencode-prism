// Per-key semaphore with FIFO wait queue.
interface QueueEntry {
  taskId?: string
  resolve: () => void
  rawReject: (error: Error) => void
  settled: boolean
}

export class ConcurrencyManager {
  private counts = new Map<string, number>()
  private queues = new Map<string, QueueEntry[]>()
  private limit: number

  // 不变式在边界声明:limit 必须是有限正整数。生产路径的传入值来自 schema
  // 校验后的配置(z.number().int().min(1),zod 默认拒绝非有限数),所以
  // Infinity/NaN 只有直接构造(测试、未来调用者)才可能到达——那是调用者
  // bug,fail fast 而不是在 acquire 里防御一个不可达状态。
  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`concurrency limit must be a finite positive number, got: ${limit}`)
    }
    this.limit = limit
  }

  async acquire(key: string, taskId?: string): Promise<void> {
    const current = this.counts.get(key) ?? 0
    if (current < this.limit) {
      this.counts.set(key, current + 1)
      return
    }

    await new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(key) ?? []
      const entry: QueueEntry = {
        taskId,
        resolve: () => {
          if (entry.settled) return
          entry.settled = true
          resolve()
        },
        rawReject: reject,
        settled: false,
      }
      queue.push(entry)
      this.queues.set(key, queue)
    })
  }

  release(key: string): void {
    const queue = this.queues.get(key)

    // Hand the slot directly to the next waiter (count stays the same).
    while (queue && queue.length > 0) {
      const next = queue.shift()
      if (!next) continue
      if (!next.settled) {
        next.resolve()
        return
      }
    }

    const current = this.counts.get(key) ?? 0
    if (current > 0) {
      this.counts.set(key, current - 1)
    }
  }

  cancelWaiter(key: string, taskId: string): boolean {
    const queue = this.queues.get(key)
    if (!queue) return false

    const index = queue.findIndex((entry) => entry.taskId === taskId && !entry.settled)
    if (index === -1) return false

    const entry = queue[index]
    if (!entry) return false
    entry.settled = true
    entry.rawReject(new Error(`concurrency queue cancelled for task: ${taskId}`))
    queue.splice(index, 1)
    if (queue.length === 0) {
      this.queues.delete(key)
    }
    return true
  }

  clear(): void {
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (!entry.settled) {
          entry.settled = true
          entry.rawReject(new Error("concurrency queue cancelled during shutdown"))
        }
      }
    }
    this.queues.clear()
    this.counts.clear()
  }

  /** 只读占用快照(看板 header 的并发池指示):仅列出有实际占用或排队的
   *  模型组(active > 0)。release 到 0 的键不显示——看板 header 承诺
   *  "仅显示有任务的模型组"。limit 恒为有限正整数(构造断言)。 */
  snapshot(): Array<{ key: string; active: number; limit: number }> {
    const keys = new Set<string>([...this.counts.keys(), ...this.queues.keys()])
    const rows: Array<{ key: string; active: number; limit: number }> = []
    for (const key of keys) {
      const active = this.counts.get(key) ?? 0
      if (active === 0) continue
      rows.push({ key, active, limit: this.limit })
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key))
  }
}
