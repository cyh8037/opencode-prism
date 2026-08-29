import { MAX_IMAGES_PER_BATCH } from "../../config/constants"
import { errorInfoFromResult } from "../../shared/api-result"
import { log } from "../../shared/log"
import { parseSessionMessages } from "../../shared/session-data"
import type { PrismClient } from "../client-types"
import { extractImageParts, type ImageAttachment } from "../vision/detector"

// 从会话消息历史提取"最后一条用户消息"的图片附件(纯函数,可单测)。
// 场景:/bg 分析这张图片——用户消息带 file 图片 part(斜杠命令的附件
// 就是普通消息 part),bg_spawn 的子会话 prompt 需要带上这些图片才能让
// 子任务 vision_look 读图。
//
// 严格只看最后一条用户消息、无图即止:更早消息的图片是旧上下文,跟随
// 它们会把无关附件注入不相干的子任务(autoTrigger 下模型可随时自主
// bg_spawn,误注入面更大)。基于早前消息的图片开新后台任务,由调用方
// 引导把图片路径显式写进 prompt。
export function collectLatestUserImages(messages: unknown, max: number): ImageAttachment[] {
  const parsed = parseSessionMessages(messages)
  for (let i = parsed.length - 1; i >= 0; i--) {
    const message = parsed[i]
    if (!message || message.info.role !== "user") continue
    return extractImageParts(message.parts).slice(0, max)
  }
  return []
}

// 图片跟随的异步封装:bg_spawn 工具与 /bg 命令原生执行两条启动路径共用。
// 查询失败/无图时返回 undefined 并留日志(普通任务不受影响,静默跳过)。
export async function collectImageFollowParts(args: {
  client: PrismClient
  directory: string | undefined
  sessionID: string
}): Promise<Array<{ type: "file"; mime: string; url: string }> | undefined> {
  try {
    // 不变量 #7:4xx/5xx 解析为 { error } 而不是 reject,必须用
    // errorInfoFromResult 判错;降级(跳过传图)必须留日志。
    const response = await args.client.session.messages({
      path: { id: args.sessionID },
      query: args.directory ? { directory: args.directory } : undefined,
    })
    const failure = errorInfoFromResult(response)
    if (failure) {
      log("[prism] image follow skipped (messages query failed)", {
        sessionID: args.sessionID,
        error: failure.message,
      })
      return undefined
    }
    const images = collectLatestUserImages(response.data, MAX_IMAGES_PER_BATCH)
    if (images.length === 0) return undefined
    return images.map((image) => ({ type: "file" as const, mime: image.mime, url: image.url }))
  } catch (error) {
    log("[prism] image follow failed (skipped)", { sessionID: args.sessionID, error })
    return undefined
  }
}
