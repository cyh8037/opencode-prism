import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { parseJsonc } from "./jsonc"
import { prismConfigSchema, type PrismConfig } from "./schema"
import { log } from "../shared/log"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isRecord(base) || !isRecord(override)) {
    return (override as T) ?? base
  }
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    result[key] = isRecord(base[key]) && isRecord(value) ? deepMerge(base[key], value) : value
  }
  return result as T
}

// Read one config file. Failures (unreadable, malformed, non-object) are
// reported through `warning` instead of throwing; missing files are not a
// warning (that is the normal "no config here" case).
function readConfigFile(path: string): { value: Record<string, unknown> | null; warning: string | null } {
  if (!existsSync(path)) return { value: null, warning: null }
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8"))
    if (!isRecord(parsed)) {
      const warning = `ignoring config file (top level must be an object): ${path}`
      log(warning)
      return { value: null, warning }
    }
    return { value: parsed, warning: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const warning = `failed to parse config file, ignoring: ${path} (${detail})`
    log(warning)
    return { value: null, warning }
  }
}

// Find the nearest .prism/prism.jsonc from startDir up to $HOME (home itself skipped).
function findProjectConfig(startDir: string): string | null {
  let dir = resolve(startDir)
  const home = resolve(homedir())
  while (true) {
    const candidate = join(dir, ".prism", "prism.jsonc")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir || dir === home) return null
    dir = parent
  }
}

// Merge a partial config onto the built-in defaults and validate. Partial
// overrides are allowed at any depth (deep merge, later wins). Sections that
// fail validation fall back to their own defaults instead of discarding the
// whole config: a typo in vision must not reset the user's background
// settings. Human-readable warnings are pushed to the optional collector so
// callers can surface them (e.g. a startup toast); parseConfig itself never
// throws.
export function parseConfig(partial: Record<string, unknown>, warnings: string[] = []): PrismConfig {
  const defaults = prismConfigSchema.parse({})
  const merged = deepMerge(defaults, partial)
  const parsed = prismConfigSchema.safeParse(merged)
  if (parsed.success) return parsed.data

  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n")
  warnings.push(`config validation failed, invalid sections fell back to defaults:\n${issues}`)

  const result: PrismConfig = { ...defaults }
  for (const key of ["vision", "background", "tmux"] as const) {
    const value = merged[key]
    if (value === undefined) continue
    const sectionParsed = prismConfigSchema.shape[key].safeParse(value)
    if (sectionParsed.success) {
      ;(result as Record<typeof key, unknown>)[key] = sectionParsed.data
    }
  }
  return result
}

export interface ConfigLoadResult {
  config: PrismConfig
  /** Human-readable problems (unreadable files, invalid sections), empty when clean. */
  warnings: string[]
}

export function loadConfig(startDir: string, env: Record<string, string | undefined> = process.env): ConfigLoadResult {
  const userPath = env.PRISM_CONFIG ?? join(homedir(), ".prism", "prism.jsonc")
  const projectPath = findProjectConfig(startDir)

  const warnings: string[] = []
  let merged: Record<string, unknown> = {}
  if (userPath !== null) {
    const user = readConfigFile(userPath)
    if (user.warning) warnings.push(user.warning)
    if (user.value) merged = deepMerge(merged, user.value)
  }
  if (projectPath !== null) {
    const project = readConfigFile(projectPath)
    if (project.warning) warnings.push(project.warning)
    if (project.value) merged = deepMerge(merged, project.value)
  }

  return { config: parseConfig(merged, warnings), warnings }
}
