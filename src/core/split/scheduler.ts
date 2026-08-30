import { MAX_SUBTASKS } from "../../config/constants"
import { sanitizeCell } from "../background/visualizer"
import type { BgTask, LaunchInput } from "../background/types"
import { TERMINAL_TASK_STATUSES } from "../background/types"
import type { BackgroundManager } from "../background/manager"
import type { SubTaskPlan } from "./plan-schema"

export interface SplitRunOptions {
  plans: SubTaskPlan[]
  parentSessionId: string
  basePromptPrefix?: string
  sequential?: boolean
  /** run id，作为子任务的 notificationGroup 传入 manager：父会话在每个
   *  run 收尾时只被唤醒一次，不被同会话其他独立任务的完成通知吞并。 */
  notificationGroupId: string
}

export interface SplitRunResult {
  /** Live map: plan id -> background task (filled as tasks launch). */
  tasksByPlanID: Map<string, BgTask>
  /** Plans never launched because an upstream dependency failed. plan id -> failed dep id. */
  skippedPlanIDs: Map<string, string>
  /** Resolves when every launched subtask reached a terminal status. */
  done: Promise<void>
}

const TERMINAL = TERMINAL_TASK_STATUSES
// Sentinel value in skippedPlanIDs: the plan itself never launched (manager
// rejected it — unresolvable model, shutdown). Distinct from a plan id so
// the report can say "启动失败" instead of the misleading "上游 <自己> 失败".
export const LAUNCH_FAILED = "launch-failed"

// Topological layering for display (dry-run). Layer N holds every plan whose
// dependencies all live in earlier layers. NOTE: this matches the runtime's
// ORDER, not its trigger semantics — the scheduler launches each task as soon
// as its own dependencies reach terminal status (ASAP), with no whole-wave
// barrier; display text must not claim more than the ordering. Plans are
// schema-validated (acyclic, known ids); any unorderable remainder is
// appended to a final layer rather than dropped, keeping this total.
export function layerPlans(plans: SubTaskPlan[]): SubTaskPlan[][] {
  const placed = new Set<string>()
  const layers: SubTaskPlan[][] = []
  let remaining = plans
  while (remaining.length > 0) {
    const layer = remaining.filter((plan) => plan.dependsOn.every((dep) => placed.has(dep)))
    if (layer.length === 0) {
      layers.push(remaining)
      break
    }
    for (const plan of layer) placed.add(plan.id)
    layers.push(layer)
    remaining = remaining.filter((plan) => !placed.has(plan.id))
  }
  return layers
}

// DAG scheduler: topological layering. Layer 0 launches immediately; a task's
// dependents launch once all their dependencies reached a terminal status.
// Completion events drive the schedule via BackgroundManager.onTaskTerminal.
export function runSplit(manager: BackgroundManager, options: SplitRunOptions): SplitRunResult {
  const plans = options.plans.slice(0, MAX_SUBTASKS)
  const tasksByPlanID = new Map<string, BgTask>()
  const launchedPlanIDs = new Set<string>()
  const terminalPlanIDs = new Set<string>()
  const skippedPlanIDs = new Map<string, string>()

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const planForTask = (task: BgTask): string | undefined => {
    for (const [planID, planTask] of tasksByPlanID.entries()) {
      if (planTask === task) return planID
    }
    return undefined
  }

  const onTaskTerminal = (task: BgTask): void => {
    const planID = planForTask(task)
    if (planID) terminalPlanIDs.add(planID)
    launchReady()
    checkSettled()
  }
  manager.onTaskTerminal(onTaskTerminal)
  // Remove the listener once the run settles: runs happen on the shared
  // manager and the listeners would otherwise accumulate across /split calls.
  const removeListener = (): void => manager.offTaskTerminal(onTaskTerminal)

  const checkSettled = (): void => {
    // Settled only when EVERY plan is terminal: launched-and-finished, or
    // marked terminal by a launch failure. Not-yet-launched plans keep the
    // run open (their dependents may still be scheduled).
    const allTerminal = plans.every((plan) => {
      if (terminalPlanIDs.has(plan.id)) return true
      const task = tasksByPlanID.get(plan.id)
      return task !== undefined && TERMINAL.has(task.status)
    })
    if (allTerminal) {
      removeListener()
      resolveDone()
    }
  }

  // A dependency that ended in error/cancelled (or was itself skipped) means
  // the dependent would build on a missing/empty result — skip it and cascade
  // to everything downstream.
  const failedDependency = (plan: SubTaskPlan): string | undefined => {
    for (const depID of plan.dependsOn) {
      if (skippedPlanIDs.has(depID)) return depID
      const depTask = tasksByPlanID.get(depID)
      if (depTask && (depTask.status === "error" || depTask.status === "cancelled")) return depID
    }
    return undefined
  }

  const launchReady = (): void => {
    if (options.sequential) {
      const anyActive = Array.from(tasksByPlanID.values()).some(
        (task) => task.status === "running" || task.status === "pending",
      )
      if (anyActive) return
    }

    let skippedThisPass = 0
    for (const plan of plans) {
      if (launchedPlanIDs.has(plan.id)) continue

      const failedDep = failedDependency(plan)
      if (failedDep) {
        launchedPlanIDs.add(plan.id)
        skippedPlanIDs.set(plan.id, failedDep)
        terminalPlanIDs.add(plan.id)
        skippedThisPass++
        continue
      }

      const depsTerminal = plan.dependsOn.every((depID) => terminalPlanIDs.has(depID))
      if (!depsTerminal) continue

      launchedPlanIDs.add(plan.id)
      const input: LaunchInput = {
        description: `${plan.id}: ${plan.title}`,
        prompt: [options.basePromptPrefix, plan.description].filter(Boolean).join("\n\n"),
        parentSessionId: options.parentSessionId,
        notificationGroup: options.notificationGroupId,
      }
      void manager
        .launch(input)
        .then((task) => {
          tasksByPlanID.set(plan.id, task)
        })
        .catch(() => {
          // A launch failure IS a failed dependency: proceeding would run the
          // dependents on missing upstream output. Record it in the skip map
          // so failedDependency() cascades, exactly like an errored task.
          skippedPlanIDs.set(plan.id, LAUNCH_FAILED)
          terminalPlanIDs.add(plan.id)
          checkSettled()
          launchReady()
        })

      if (options.sequential) return
    }

    // Skips can cascade (a skipped plan fails its own dependents); re-run
    // until a pass skips nothing new.
    if (skippedThisPass > 0) {
      checkSettled()
      launchReady()
    }
  }

  launchReady()
  if (plans.length === 0) {
    removeListener()
    resolveDone()
  }

  return {
    tasksByPlanID,
    skippedPlanIDs,
    done,
  }
}

export function buildSplitReport(
  tasksByPlanID: Map<string, BgTask>,
  plans: SubTaskPlan[],
  skippedPlanIDs: Map<string, string> = new Map(),
): string {
  const lines = [
    "<system-reminder>",
    "[PRISM SPLIT REPORT]",
    "",
    "拆分子任务已全部执行结束。请把以下拆分任务汇总报告完整清晰地转达给用户，并进行最终整合总结与收尾说明：",
    "",
  ]
  // plan.title comes from the planner LLM and task.error from the provider —
  // untrusted text embedded in the template. Both go through the dashboard
  // cell pipeline (tag escape + ANSI strip + newline flatten + control-char
  // strip): a multi-line result would otherwise break the "- id title" list
  // structure and let a hostile child forge extra report entries, not just
  // escape the reminder tag.
  const esc = sanitizeCell
  for (const plan of plans) {
    const title = esc(plan.title)
    const skippedDep = skippedPlanIDs.get(plan.id)
    if (skippedDep) {
      if (skippedDep === LAUNCH_FAILED) {
        lines.push(`- ${plan.id} ${title}: 启动失败（未能创建后台任务，详见插件日志）`)
      } else {
        lines.push(`- ${plan.id} ${title}: SKIPPED (上游 ${esc(skippedDep)} 失败，未启动)`)
      }
      continue
    }
    const task = tasksByPlanID.get(plan.id)
    if (!task) {
      lines.push(`- ${plan.id} ${title}: 未启动`)
      continue
    }
    const error = task.error ? `: ${esc(task.error.slice(0, 120))}` : ""
    // Untrusted subtask output embedded in the <system-reminder> block —
    // escaped AND newline-flattened so it cannot break out of the template
    // or forge report lines.
    const result = task.resultText ? `\n  结果: ${esc(task.resultText.slice(0, 200))}` : ""
    lines.push(`- ${plan.id} ${title}: ${task.status.toUpperCase()}${error}${result}`)
  }
  lines.push(
    "",
    "请根据上述各子任务的执行状态与结果，向用户汇报拆分执行情况并完成整体任务的验证与总结收尾。",
    "</system-reminder>",
  )
  return lines.join("\n")
}
