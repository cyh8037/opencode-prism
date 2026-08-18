import { MAX_IMAGES_PER_BATCH, VISION_SNAPSHOT_WAIT_MS } from "../../config/constants"
import type { PrismConfig } from "../../config/schema"
import type { ResolvedModel } from "../../models"
import { log } from "../../shared/log"
import type { BackgroundManager } from "../background/manager"
import type { PrismClient } from "../client-types"
import type { PromptGate } from "../prompt-gate"
import type { ImageAttachment } from "./detector"
import { runVisionInterpretation, VISION_INSTRUCTION, VISION_SYSTEM_PROMPT } from "./interpreter"

// The model a vision interpretation should use for a session: the explicit
// vision.model, or the session's current model when it is image-capable.
// Returns undefined when vision is unavailable (invalid config, or the
// session model cannot see images) — triggers skip in that case.
export type GetVisionModelFn = (sessionID: string) => ResolvedModel | undefined

export interface VisionPipelineDeps {
  client: PrismClient
  directory: string
  config: PrismConfig
  gate: PromptGate
  background: BackgroundManager
  getVisionModel: GetVisionModelFn
  /** Like getVisionModel, but waits up to timeoutMs for the session's first
   *  capability snapshot (chat.message fires before chat.params). */
  waitForVisionModel: (sessionID: string, timeoutMs: number) => Promise<ResolvedModel | undefined>
  logger?: typeof log
}

export class VisionPipeline {
  private logger: typeof log

  constructor(private deps: VisionPipelineDeps) {
    this.logger = deps.logger ?? log
  }

  // Single configured model with one same-model retry on failure. No provider
  // switching: the model reference is explicit and unavailability degrades
  // gracefully (images stay in the main context).
  private async interpretWithFallback(
    parentSessionID: string,
    images: ImageAttachment[],
    modelOverride?: ResolvedModel,
  ): Promise<string | null> {
    const model = modelOverride ?? this.deps.getVisionModel(parentSessionID)
    if (!model) {
      this.logger("[prism] vision: no vision model available (invalid config or session model not image-capable), skipping", {
        parentSessionID,
      })
      return null
    }

    for (let attempt = 0; attempt <= 1; attempt++) {
      let text: string | null = null
      try {
        text = await runVisionInterpretation({
          client: this.deps.client,
          directory: this.deps.directory,
          parentSessionID,
          images,
          model,
        })
      } catch (error) {
        this.logger("[prism] vision: interpretation threw", { model, error })
      }
      if (text !== null) return text

      this.logger("[prism] vision: interpretation failed, retrying with the same model", {
        model,
        attempt: attempt + 1,
      })
    }
    return null
  }

  // Queue an interpretation for a parent session. Each call runs its own
  // interpretation: merging into an in-flight batch is unsound — the batch is
  // already sent to the model by the time a second caller arrives, so merged
  // images would be silently dropped while the second caller still received
  // the first batch's text. The batch is capped with a note instead.
  private enqueue(parentSessionID: string, images: ImageAttachment[]): Promise<string | null> {
    const batch = images.slice(0, MAX_IMAGES_PER_BATCH)
    if (batch.length < images.length) {
      this.logger("[prism] vision: image batch exceeds MAX_IMAGES_PER_BATCH, dropping extras", {
        images: images.length,
        sent: batch.length,
      })
    }
    return this.interpretWithFallback(parentSessionID, batch)
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
      // Tool outputs always follow an LLM call, so the capability snapshot
      // already exists — the sync gate is enough.
      const model = this.deps.getVisionModel(input.sessionID)
      if (model) this.launchBackgroundTask(input.sessionID, images, `tool output from ${input.tool}`, model)
      return
    }

    const text = await this.enqueue(input.sessionID, images)
    if (text === null) {
      log("[prism] vision: interpretation unavailable, leaving image in main context")
      return
    }
    output.output += `\n\n[prism vision] 图片解读（${input.tool}）:\n${text}`
  }

  // Trigger B: user attached images in chat. chat.message fires BEFORE the
  // session's first chat.params, so a fresh session (e.g. an image recalled
  // from another session's history) may not have a capability snapshot yet —
  // wait briefly for it before deciding.
  async onChatImages(sessionID: string, images: ImageAttachment[]): Promise<void> {
    if (images.length === 0) return
    const mode = this.deps.config.vision.mode

    if (mode === "background") {
      const model = await this.deps.waitForVisionModel(sessionID, VISION_SNAPSHOT_WAIT_MS)
      if (model) this.launchBackgroundTask(sessionID, images, "chat images", model)
      return
    }

    const model = await this.deps.waitForVisionModel(sessionID, VISION_SNAPSHOT_WAIT_MS)
    if (!model) {
      log("[prism] vision: no usable vision model after waiting for the session snapshot")
      return
    }
    const text = await this.interpretWithFallback(sessionID, images, model)
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

  // Callers gate BEFORE this: without a usable model the task would run
  // text-only (opencode silently drops image parts on non-vision models).
  private launchBackgroundTask(
    sessionID: string,
    images: ImageAttachment[],
    source: string,
    model: ResolvedModel,
  ): void {
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
        // Pin the gate-checked model: the child must use exactly the model
        // we verified can see images, not a freshly re-resolved one.
        model,
      })
      .catch((error) => {
        this.logger("[prism] vision: background task launch failed", { error })
      })
  }
}
