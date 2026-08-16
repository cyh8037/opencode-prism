export interface PrismCommandDefinition {
  description: string
  template: string
  argumentHint: string
}

export const BG_COMMAND: PrismCommandDefinition = {
  description: "Prism 后台任务: 并行启动独立子任务并跟踪进度",
  argumentHint: "<任务描述> | status | output <task_id> | cancel <task_id>",
  template: `<command-instruction>
你在处理 Prism 的 /bg 命令。

- 参数是任务描述时：用 bg_spawn 工具启动后台任务。
- 参数带 --parallel N 时：把任务拆成 N 个相互独立的子任务，在同一个回合内并行调用 N 次 bg_spawn（绝不串行等待）。
- 参数是 status / output <task_id> / cancel <task_id> 时：这些子命令由插件原生执行，结果会注入到对话中。直接把注入的结果转达给用户，不要调用任何工具。
- 后台任务结束后父会话会自动收到汇总通知，不需要你主动轮询。
</command-instruction>

<user-task>
$ARGUMENTS
</user-task>`,
}

export const SPLIT_COMMAND: PrismCommandDefinition = {
  description: "Prism 任务拆分: 复杂任务拆成多个子任务并发执行",
  argumentHint: "<任务描述> [--dry-run] [--sequential] [--max <n>] | status | output <task_id> | cancel <task_id>",
  template: `<command-instruction>
你在处理 Prism 的 /split 命令。

- 任务描述形式：由插件原生执行（规划器拆分 + 子任务并发调度），结果会注入到对话中。
- 如果返回的是拆分计划（dry-run）：把计划展示给用户，等用户确认后再让用户去掉 --dry-run 重新执行。
- 如果返回的是"拆分计划已启动"：告诉用户子任务正在后台并行执行，完成后会自动收到汇总通知。
- 如果返回的是失败信息：把原因转达给用户。
- status / output <task_id> / cancel <task_id> 同样由插件原生执行，直接转达结果，不要调用任何工具。
</command-instruction>

<user-task>
$ARGUMENTS
</user-task>`,
}
