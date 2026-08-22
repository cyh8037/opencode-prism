export interface PrismCommandDefinition {
  description: string
  template: string
  argumentHint: string
}

// Command templates are passed verbatim to the LLM (opencode only replaces
// $ARGUMENTS / $1..$9 and @file references), so they are written as plain
// markdown — no fake XML blocks.
export const BG_COMMAND: PrismCommandDefinition = {
  description: "Prism 后台任务: 并行启动独立子任务并跟踪进度",
  argumentHint: "<任务描述> | status | output <task_id> | cancel <task_id> | resume <task_id> <追问>",
  template: `你在处理 Prism 的 /bg 命令。

- 参数是任务描述时：用 bg_spawn 工具启动后台任务。
- 参数带 --parallel N 时：把任务拆成 N 个相互独立的子任务，在同一个回合内并行调用 N 次 bg_spawn（绝不串行等待）。
- 涉及图片的任务：图片无法作为附件传给后台子会话（斜杠命令不接受附件）。把图片的本地路径/URL 写进任务描述，并让子任务使用 vision_look 工具读取该图片进行解读。
- 参数是 status / output <task_id> / cancel <task_id> / resume <task_id> <追问> 时：这些子命令由插件原生执行，结果会注入到对话中。直接把注入的结果转达给用户，不要调用任何工具。
- resume 用于在已结束任务的子会话里继续追问（保留其上下文）；用户想深入某个已完成任务的结果时优先用它而不是重新启动任务。
- 后台任务结束后父会话会自动收到汇总通知，不需要你主动轮询。

任务参数：
$ARGUMENTS`,
}

export const SPLIT_COMMAND: PrismCommandDefinition = {
  description: "Prism 任务拆分: 复杂任务拆成多个子任务并发执行",
  argumentHint: "<任务描述> [--dry-run] [--sequential] [--max <n>] | status | output <task_id> | cancel <task_id>",
  template: `你在处理 Prism 的 /split 命令。

- 任务描述形式：由插件原生执行（规划器拆分 + 子任务并发调度），结果会注入到对话中。
- 涉及图片的任务：图片无法作为附件传给子任务，把图片的本地路径/URL 写进任务描述，并让对应子任务使用 vision_look 工具读图。
- 如果返回的是拆分计划（dry-run）：把计划展示给用户，等用户确认后再让用户去掉 --dry-run 重新执行。
- 如果返回的是"拆分计划已启动"：告诉用户子任务正在后台并行执行，完成后会自动收到汇总通知。
- 如果返回的是失败信息：把原因转达给用户。
- status / output <task_id> / cancel <task_id> 同样由插件原生执行，直接转达结果，不要调用任何工具。

任务参数：
$ARGUMENTS`,
}

export const VISION_COMMAND: PrismCommandDefinition = {
  description: "Prism 视觉解读: 用视觉模型解读图片并注入结果",
  argumentHint: "<路径/URL ... | last> [--goal <关注点>]",
  template: `你在处理 Prism 的 /vision 命令。此命令由插件原生执行，解读结果会直接注入到对话中。把注入的结果转达给用户，不要调用任何工具。

任务参数：
$ARGUMENTS`,
}
