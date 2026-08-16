import { DEDUPE_WINDOW_MS, MAX_IMAGES_PER_BATCH } from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import type { ImageAttachment } from "./detector"
import { runVisionInterpretation, VISION_INSTRUCTION, VISION_SYSTEM_PROMPT } from "./interpreter"

export type ResolveVisionModelFn = () => ResolvedModel | undefined

export interface VisionPipelineDeps {
  client: PrismClient
  directory: string
  config: PrismConfig
  gate: PromptGate
  background: BackgroundManager
  resolveVisionModel: ResolveVisionModelFn
  logger?: typeof log
}

interface BatchEntry {
  images: ImageAttachment[]
  settled: boolean
  resolvers: Array<(text: string | null) => void>
}

export class VisionPipeline {
  private inFlightBatches = new Map<string, BatchEntry>()
  private logger: typeof log

  constructor(private deps: VisionPipelineDeps) {
    this.logger = deps.logger ?? log
  }

  // Dedupe window: background mode merges images arriving within 3s into one
  // interpretation call; sync mode executes immediately (tool results should
  // not be delayed by batching).
  private batchWindowMs(mode: PrismConfig["vision"]["mode"]): number {
    return mode === "background" ? DEDUPE_WINDOW_MS : 0
  }

  // Single configured model with one same-model retry on failure. No provider
  // switching: the model reference is explicit and unavailability degrades
  // gracefully (images stay in the main context).
  private async interpretWithFallback(
    parentSessionID: string,
    images: ImageAttachment[],
  ): Promise<string | null> {
    const model = this.deps.resolveVisionModel()
    if (!model) {
      this.logger("[prism] vision: no vision model configured", { parentSessionID })
      return null
    }

    for (let attempt = 0; attempt <= 1; attempt++) {
      const text = await runVisionInterpretation({
        client: this.deps.client,
        directory: this.deps.directory,
        parentSessionID,
        images,
        model,
      })
      if (text !== null) return text

      this.logger("[prism] vision: interpretation failed, retrying with the same model", {
        model,
        attempt: attempt + 1,
      })
    }
    return null
  }

  // Queue an interpretation for a parent session, merging with an in-flight
  // batch when one exists (cap MAX_IMAGES_PER_BATCH). Every caller gets its
  // own resolver so concurrent merges all settle with the shared result.
  private enqueue(parentSessionID: string, images: ImageAttachment[], mode: PrismConfig["vision"]["mode"]): Promise<string | null> {
    const existing = this.inFlightBatches.get(parentSessionID)
    if (existing && !existing.settled) {
      const remaining = MAX_IMAGES_PER_BATCH - existing.images.length
      if (remaining > 0) {
        existing.images.push(...images.slice(0, remaining))
      }
      return new Promise((resolve) => {
        existing.resolvers.push(resolve)
      })
    }

    return new Promise((resolve) => {
      const entry: BatchEntry = {
        images: [...images.slice(0, MAX_IMAGES_PER_BATCH)],
        settled: false,
        resolvers: [resolve],
      }
      this.inFlightBatches.set(parentSessionID, entry)

      const execute = async (): Promise<void> => {
        const text = await this.interpretWithFallback(parentSessionID, entry.images)
        entry.settled = true
        if (this.inFlightBatches.get(parentSessionID) === entry) {
          this.inFlightBatches.delete(parentSessionID)
        }
        for (const entryResolve of entry.resolvers) {
          entryResolve(text)
        }
      }

      const windowMs = this.batchWindowMs(mode)
      if (windowMs > 0) {
        setTimeout(() => void execute(), windowMs)
      } else {
        void execute()
      }
    })
  }

  // Trigger A: tool output containing image attachments. Sync mode appends the
  // interpretation to the tool output; background mode spawns a vision task.
  async onToolOutput(
    input: { tool: string; sessionID: string },
    output: { title: string; output: string },
    images: ImageAttachment[],
  ): Promise<void> {
    if (images.length === 0) return
    const mode = this.deps.config.vision.mode

    if (mode === "background") {
      this.launchBackgroundTask(input.sessionID, images, `tool output from ${input.tool}`)
      return
    }

    const text = await this.enqueue(input.sessionID, images, mode)
    if (text === null) {
      log("[prism] vision: interpretation unavailable, leaving image in main context")
      return
    }
    output.output += `\n\n[prism vision] 图片解读（${input.tool}）:\n${text}`
  }

  // Trigger B: user attached images in chat.
  async onChatImages(sessionID: string, images: ImageAttachment[]): Promise<void> {
    if (images.length === 0) return
    const mode = this.deps.config.vision.mode

    if (mode === "background") {
      this.launchBackgroundTask(sessionID, images, "chat images")
      return
    }

    const text = await this.enqueue(sessionID, images, mode)
    if (text === null) {
      log("[prism] vision: interpretation unavailable for chat images")
      return
    }

    await this.deps.gate.dispatch({
      sessionID,
      source: "vision-interpretation",
      text: `<system-reminder>\n[PRISM VISION] 对话图片解读:\n${text}\n</system-reminder>`,
    })
  }

  // Manual path used by the vision_look tool: interpret and return text.
  look(sessionID: string, images: ImageAttachment[]): Promise<string | null> {
    return this.interpretWithFallback(sessionID, images)
  }

  private launchBackgroundTask(sessionID: string, images: ImageAttachment[], source: string): void {
    const parts: Array<Record<string, unknown>> = [
      { type: "text", text: VISION_INSTRUCTION, synthetic: true },
      ...images.map((image) => ({ type: "file", mime: image.mime, url: image.url })),
    ]
    void this.deps.background
      .launch({
        description: `视觉解读 (${images.length} 张图片, ${source})`,
        prompt: VISION_INSTRUCTION,
        parts,
        system: VISION_SYSTEM_PROMPT,
        parentSessionId: sessionID,
      })
      .catch((error) => {
        this.logger("[prism] vision: background task launch failed", { error })
      })
  }
}
