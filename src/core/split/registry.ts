// SplitRun 登记处:/split status 看板的数据源。
//
// runSplit 的 tasksByPlanID / skippedPlanIDs 只活在 service.ts 的局部变量
// 里,command hook 无法触达——SplitService 在 runSplit 返回后登记到这里,
// 看板通过 getRunsByParentSession 读取。任务对象与 Map 都是实时引用
// (不复制),状态在查询时推导,registry 本身零状态。
//
// 生命周期(R1):未 settled(运行中)的条目永不清理——running 任务超 TTL
// 只警告不杀(manager.ts),长任务运行期间 /split status 必须始终可见;
// settled 后保留 TERMINAL_TASK_RETENTION_MS。条目寿命 ⊇ 任务寿命(任务以
// completedAt 为锚清理),因此任务被 prune 后仍能查到 plan -> ARCHIVED。
import { TERMINAL_TASK_RETENTION_MS } from "../../config/constants"
import type { BgTask } from "../background/types"
import type { SubTaskPlan } from "./plan-schema"

export interface SplitRunEntry {
  /** run 标识(sp_ 前缀),/split cancel sp_xxx 按整个 run 取消。 */
  id: string
  sessionID: string
  /** runSplit slice 后的 plans(与执行实际一致)。 */
  plans: SubTaskPlan[]
  /** 实时引用:plan id -> 后台任务(随启动填充,不复制)。 */
  tasksByPlanID: Map<string, BgTask>
  /** 实时引用:plan id -> 失败的上游 plan id(或 LAUNCH_FAILED)。 */
  skippedPlanIDs: Map<string, string>
  sequential: boolean
  settled: boolean
  createdAt: Date
  /** 置 settled 的时刻(TTL 锚点,见文件头注释)。 */
  settledAt?: Date
}

export class SplitRunRegistry {
  private entries: SplitRunEntry[] = []

  constructor(private retentionMs: number = TERMINAL_TASK_RETENTION_MS) {}

  /** 登记一个 run,自动分配 sp_ id,返回条目引用(service 在 run.done 后置
   *  settled/settledAt)。 */
  register(entry: Omit<SplitRunEntry, "id"> & { id?: string }): SplitRunEntry {
    this.prune()
    // id 放在 spread 之后:调用方显式传 undefined 时不会被 ...entry 覆盖回
    // undefined(此前 `{ id: gen, ...entry }` 的顺序会把生成值盖掉)。
    const full: SplitRunEntry = { ...entry, id: entry.id ?? `sp_${crypto.randomUUID().slice(0, 8)}` }
    this.entries.push(full)
    return full
  }

  /** 按 run id 查询(跨会话;归属检查由调用方按 sessionID 做)。 */
  getRun(id: string): SplitRunEntry | undefined {
    this.prune()
    return this.entries.find((entry) => entry.id === id)
  }

  /** 某父会话的全部 run,按启动时间倒序(最新在前)。 */
  getRunsByParentSession(sessionID: string): SplitRunEntry[] {
    this.prune()
    return this.entries
      .filter((entry) => entry.sessionID === sessionID)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  }

  // 惰性清理:register 与查询时触发,过期的 settled 条目直接摘除。
  private prune(): void {
    const now = Date.now()
    this.entries = this.entries.filter((entry) => {
      if (!entry.settled || !entry.settledAt) return true
      return now - entry.settledAt.getTime() <= this.retentionMs
    })
  }
}
