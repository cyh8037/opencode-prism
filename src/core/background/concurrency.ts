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

  constructor(private limit: number) {}

  async acquire(key: string, taskId?: string): Promise<void> {
    if (this.limit === Infinity) return

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
}
