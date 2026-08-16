import type { PluginInput } from "@opencode-ai/plugin"
import { loadConfig } from "./config/load"
import { StaticModelCapabilities, parseModelRef } from "./models"
import type { ResolvedModel } from "./models"
import { PromptGate } from "./core/prompt-gate"
import type { PrismClient } from "./core/client-types"
import { BackgroundManager, type ResolveModelFn } from "./core/background/manager"
import { VisionPipeline } from "./core/vision/pipeline"
import { SplitService } from "./core/split/service"
import { TmuxManager } from "./tmux/manager"
import { createToolExecuteAfterHook } from "./hooks/tool-execute-after"
import { createChatMessageHook } from "./hooks/chat-message"
import { createEventHook } from "./hooks/event"
import { createCommandExecuteBeforeHook } from "./hooks/command-execute-before"
import { createBgTools } from "./tools/bg"
import { createVisionLookTool } from "./tools/vision-look"
import { BG_COMMAND, SPLIT_COMMAND } from "./commands/templates"
import { log } from "./shared/log"

function modelFromRecord(value: unknown): ResolvedModel | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const providerID = record.providerID
  const modelID = record.id ?? record.modelID
  if (typeof providerID !== "string" || typeof modelID !== "string") return undefined
  return { providerID, modelID }
}

// Read the parent session's CURRENT model. Tier order: session object (the
// authoritative "what is this session using right now" source), latest
// message info, then the opencode config default captured by the config hook.
async function resolveSessionModel(
  client: PrismClient,
  sessionID: string,
  directory: string,
  opencodeDefault: ResolvedModel | undefined,
): Promise<ResolvedModel | undefined> {
  try {
    const response = await client.session.get({ path: { id: sessionID }, query: { directory } })
    const fromSession = modelFromRecord(response.data?.model)
    if (fromSession) return fromSession
  } catch (error) {
    log("[prism] session.get failed while resolving session model", { sessionID, error })
  }

  try {
    const messagesResponse = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
    })
    const messages = messagesResponse.data
    if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i] as { info?: { model?: unknown } } | undefined
        const fromMessage = modelFromRecord(message?.info?.model)
        if (fromMessage) return fromMessage
      }
    }
  } catch (error) {
    log("[prism] messages fetch failed while resolving session model", { sessionID, error })
  }

  if (opencodeDefault) {
    log("[prism] falling back to opencode default model for session", { sessionID })
  }
  return opencodeDefault
}

export async function Prism(input: PluginInput): Promise<Record<string, unknown>> {
  const directory = input.directory
  const client = input.client as unknown as PrismClient
  const serverUrl = (input as unknown as { serverUrl?: string }).serverUrl

  const config = loadConfig(directory)
  const capabilities = new StaticModelCapabilities()

  // Vision model: single explicit "provider/model" reference from config.
  // Empty string disables the vision feature entirely.
  const visionRef = config.vision.model.trim()
  let visionModel: ResolvedModel | undefined
  if (visionRef === "") {
    log("[prism] vision feature disabled (empty vision.model)")
  } else {
    const parsed = parseModelRef(visionRef)
    if (!parsed) {
      log(`[prism] warning: invalid vision.model reference, vision feature disabled: ${visionRef}`)
    } else {
      visionModel = parsed
      const capable = capabilities.isVisionCapable(parsed.modelID)
      if (capable === false) {
        log(`[prism] warning: configured vision model is marked non-vision in the capability snapshot: ${parsed.modelID}`)
      }
    }
  }

  // opencode's default model, captured from the config hook input as a
  // last-resort fallback for session-model resolution.
  let opencodeDefaultModel: ResolvedModel | undefined

  const gate = new PromptGate(client)

  const tmux = new TmuxManager({ client, directory, config, serverUrl })
  await tmux.init()

  const resolveModel: ResolveModelFn = (parentSessionID) =>
    resolveSessionModel(client, parentSessionID, directory, opencodeDefaultModel)

  const manager = new BackgroundManager({
    client,
    directory,
    config,
    gate,
    resolveModel,
    onSessionCreated: (event) => {
      void tmux.onSessionCreated(event)
    },
    onSessionDeleted: (event) => {
      void tmux.onSessionDeleted(event)
    },
  })

  const vision = new VisionPipeline({
    client,
    directory,
    config,
    gate,
    background: manager,
    resolveVisionModel: () => visionModel,
  })

  const splitService = new SplitService({
    client,
    directory,
    manager,
    gate,
    resolvePlannerModel: (sessionID) =>
      resolveSessionModel(client, sessionID, directory, opencodeDefaultModel),
  })

  return {
    config: async (configInput: unknown) => {
      // Capture opencode's default model for the session-model fallback tier.
      const rawConfig = (configInput as { config?: { model?: unknown } } | undefined)?.config
      opencodeDefaultModel = modelFromRecord(rawConfig?.model) ?? opencodeDefaultModel

      return {
        command: {
          bg: {
            description: BG_COMMAND.description,
            template: BG_COMMAND.template,
            argumentHint: BG_COMMAND.argumentHint,
          },
          split: {
            description: SPLIT_COMMAND.description,
            template: SPLIT_COMMAND.template,
            argumentHint: SPLIT_COMMAND.argumentHint,
          },
        },
      }
    },
    tool: {
      ...createBgTools(manager),
      vision_look: createVisionLookTool(vision),
    },
    "tool.execute.after": createToolExecuteAfterHook({ config, pipeline: vision }),
    "chat.message": createChatMessageHook({ config, pipeline: vision }),
    "command.execute.before": createCommandExecuteBeforeHook({ manager, splitService, client }),
    event: createEventHook(manager),
    dispose: async () => {
      await manager.shutdown()
      await tmux.sweep()
      gate.clearAll()
    },
  }
}

export default Prism
