import { BG_SESSION_NAV_HINT } from "../config/constants"

export interface PrismCommandDefinition {
  description: string
  template: string
  argumentHint: string
}

// Command templates are passed verbatim to the LLM (opencode only replaces
// $ARGUMENTS / $1..$9 and @file references), so they are written as plain
// markdown — no fake XML blocks.
//
// 命令原生执行（0.5.0）：任务描述与确定性子命令都在 command.execute.before
// 里由插件完成，模板只剩"转达注入结果"一种职责——刻意不放 $ARGUMENTS，
// 模型看不到任务描述就不会越权自行执行（模板回合曾实测出现模型拿到描述
// 后不调工具自己开干）。唯一的模型决策分支是 --parallel：任务语义拆分
// 需要 LLM，由 hook 注入【并行启动】指令 part 交给模型。
//
// Built at registration (not module constants): the read-image guidance
// references vision_look, which is unregistered when vision.enabled is
// false — a child told to call it would hit "tool not found".
export function createBgCommand(visionEnabled: boolean, tuiNavigation = true): PrismCommandDefinition {
  // 并行分支的图片规则只在模型驱动的 --parallel 路径需要：原生路径的
  // 图片跟随由插件自动完成，不依赖模型纪律。
  const parallelVisionRules = visionEnabled
    ? [
        "- 涉及图片的子任务：插件会自动传给对应子会话，直接用 vision_look 读图；图片是本地文件时把文件路径写进该子任务的 prompt。图片任务必须走 bg_spawn 后台执行。",
      ]
    : []
  return {
    description: "Prism 后台任务: 并行启动独立子任务并跟踪进度",
    argumentHint:
      "<任务描述> | status [--all] | status <task_id> | output <task_id> | cancel <task_id> | resume|send <task_id> <追问/补充指令>",
    template: [
      "你在处理 Prism 的 /bg 命令。",
      "",
      // 看板是 markdown 管道表格(方案 a):模型转达时必须保留 | 列分隔结构,
      // web 端才能渲染为表格;改写为列表/去掉 | 分隔都会破坏双端渲染。
      // "完整转达"防裁剪走样(2026-08-29 沙箱实测:模型只转达回执第一行,
      // 裁剪掉操作指引行与导航行——指引丢失用户就不知道如何查看/取消)。
      "- 默认情况（注入的是执行回执或状态看板）：把注入的内容完整转达给用户（含操作指引行，不要省略、压缩或重排），不要调用任何工具（包括 bg_spawn），不要重复执行任务，不要改写为列表、不要添加 emoji 或任何符号；注入内容是表格时保留表格的 | 列分隔结构。",
      "- 仅当注入内容带有【并行启动 N=x】标记时：把标记中的任务拆成 N 个相互独立的子任务，在同一个回合内并行调用 N 次 bg_spawn（绝不串行等待），启动后告知用户每个子任务的 id 与用途。",
      ...parallelVisionRules.map((line) => `  ${line}`),
      "- 查看执行过程："
        + (tuiNavigation
          ? BG_SESSION_NAV_HINT + "（[bg_ 任务 id] 开头，可用 ←/→ 切换）。不要通过反复调用 bg_output 轮询过程。"
          : "可通过 /bg status 或 bg_output 工具查看。不要主动轮询。"),
      "- 后台任务结束后父会话会自动收到汇总通知，不需要你主动轮询。",
    ].join("\n"),
  }
}

export function createSplitCommand(visionEnabled: boolean, tuiNavigation = true): PrismCommandDefinition {
  const visionLine = visionEnabled
    ? [
        "- 涉及图片的拆分任务：子任务用 vision_look 读图。",
      ]
    : []
  return {
    description: "Prism 任务拆分: 复杂任务拆成多个子任务并发执行",
    argumentHint:
      "<任务描述> [--dry-run] [--sequential] [--max <n>] | status [--all] | status <run_id> | output <task_id> | cancel <sp_run_id> | cancel <task_id>",
    template: [
      "你在处理 Prism 的 /split 命令。",
      "",
      // 看板是 markdown 管道表格(方案 a):保留 | 列分隔结构,web 端才能渲染为表格。
      // "完整转达"防裁剪走样(同 /bg 侧 2026-08-29 实测)。
      "- 默认情况（注入的是执行结果）：把注入的内容完整转达给用户（含操作指引与提示行，不要省略、压缩或重排），不要调用任何工具（包括 split_task），不要改写为列表、不要添加 emoji、保留分层结构与依赖标注、不要自行合并行；注入内容是表格时保留表格的 | 列分隔结构。",
      "- 注入的是\"意图识别：无需拆分\"：把原因原样转达给用户，提示可补充细节或设置 split.intentCheck=false。",
      "- 拆分子任务的执行过程查看方式："
        + (tuiNavigation
          ? BG_SESSION_NAV_HINT + "（[bg_ 任务 id] 开头）"
          : "通过 /split status 或 bg_output 查看"),
      ...visionLine,
      "- 拆分子任务在后台并行执行，全部结束后自动回注汇总通知，不需要主动轮询。",
    ].join("\n"),
  }
}
