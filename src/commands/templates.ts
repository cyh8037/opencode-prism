export interface PrismCommandDefinition {
  description: string
  template: string
  argumentHint: string
}

// Command templates are passed verbatim to the LLM (opencode only replaces
// $ARGUMENTS / $1..$9 and @file references), so they are written as plain
// markdown — no fake XML blocks.
//
// Built at registration (not module constants): the read-image guidance
// references vision_look, which is unregistered when vision.enabled is
// false — a child told to call it would hit "tool not found".
export function createBgCommand(visionEnabled: boolean): PrismCommandDefinition {
  return {
    description: "Prism 后台任务: 并行启动独立子任务并跟踪进度",
    argumentHint: "<任务描述> | status | output <task_id> | cancel <task_id> | resume|send <task_id> <追问/补充指令>",
    template: [
      "你在处理 Prism 的 /bg 命令。",
      "",
      "- 参数是任务描述时：用 bg_spawn 工具启动后台任务。",
      "- 参数带 --parallel N 时：把任务拆成 N 个相互独立的子任务，在同一个回合内并行调用 N 次 bg_spawn（绝不串行等待）。",
      ...(visionEnabled
        ? [
            "- 涉及图片的任务：图片无法作为附件传给后台子会话（斜杠命令不接受附件）。把图片的本地路径/URL 写进任务描述，并让子任务使用 vision_look 工具读取该图片进行解读。",
          ]
        : []),
      "- 参数是 status / output <task_id> / cancel <task_id> / resume|send <task_id> <追问或补充指令> 时：这些子命令由插件原生执行，结果会注入到对话中。直接把注入的结果转达给用户，不要调用任何工具。",
      "- resume|send 用于给任务补充指令：任务已结束时在其子会话里继续追问（保留上下文）；任务运行中时消息会排队，在其当前回合结束的边界投递，不打断执行。",
      "- 任何时候用户想在后台任务运行期间补充指示、纠正方向，或想在总结前等待并行任务完成：用 bg_send / bg_wait 工具，不要反复轮询 bg_output。",
      "- 后台任务结束后父会话会自动收到汇总通知，不需要你主动轮询。",
      "",
      "任务参数：",
      "$ARGUMENTS",
    ].join("\n"),
  }
}

export function createSplitCommand(visionEnabled: boolean): PrismCommandDefinition {
  return {
    description: "Prism 任务拆分: 复杂任务拆成多个子任务并发执行",
    argumentHint: "<任务描述> [--dry-run] [--sequential] [--max <n>] | status | output <task_id> | cancel <task_id>",
    template: [
      "你在处理 Prism 的 /split 命令。",
      "",
      "- 任务描述形式：调用 split_task 工具执行，参数 task = 任务描述，旗标对应传参（--dry-run → dry_run: true，--sequential → sequential: true，--max N → max: N）。规划与调度由插件原生完成，把工具返回的结果转达给用户，不要改写、截断或自行补充计划。",
      ...(visionEnabled
        ? [
            "- 涉及图片的任务：图片无法作为附件传给子任务，把图片的本地路径/URL 写进 task 描述，并让对应子任务使用 vision_look 工具读图。",
          ]
        : []),
      "- 工具返回的是拆分计划（dry-run）：把计划原样展示给用户，等用户确认后再让用户去掉 --dry-run 重新执行。",
      "- 工具返回的是\"拆分计划已启动\"：告诉用户子任务正在后台并行执行，完成后会自动收到汇总通知，不需要轮询。",
      "- 工具返回的是失败信息：把原因原样转达，不要自行猜测或改写。",
      "- status / output <task_id> / cancel <task_id> 由插件原生执行（结果会注入），直接转达，不要调用任何工具。",
      "",
      "任务参数：",
      "$ARGUMENTS",
    ].join("\n"),
  }
}
