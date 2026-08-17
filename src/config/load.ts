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

function readConfigFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const parsed = parseJsonc(readFileSync(path, "utf8"))
    if (!isRecord(parsed)) {
      log(`ignoring config file (top level must be an object): ${path}`)
      return null
    }
    return parsed
  } catch (error) {
    log(`failed to parse config file, ignoring: ${path}`, {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
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
// overrides are allowed at any depth (deep merge, later wins).
export function parseConfig(partial: Record<string, unknown>): PrismConfig {
  const defaults = prismConfigSchema.parse({})
  const merged = deepMerge(defaults, partial)
  return prismConfigSchema.parse(merged)
}

export function loadConfig(startDir: string, env: Record<string, string | undefined> = process.env): PrismConfig {
  const userPath = env.PRISM_CONFIG ?? join(homedir(), ".prism", "prism.jsonc")
  const projectPath = findProjectConfig(startDir)

  let merged: Record<string, unknown> = prismConfigSchema.parse({})
  if (userPath !== null) {
    const user = readConfigFile(userPath)
    if (user) merged = deepMerge(merged, user)
  }
  if (projectPath !== null) {
    const project = readConfigFile(projectPath)
    if (project) merged = deepMerge(merged, project)
  }

  const result = prismConfigSchema.safeParse(merged)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n")
    log(`config validation failed, falling back to defaults:\n${issues}`)
    return prismConfigSchema.parse({})
  }

  return result.data
}
