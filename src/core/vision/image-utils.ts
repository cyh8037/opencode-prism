import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { VISION_IMAGE_MAX_BYTES } from "../../config/constants"
import { log } from "../../shared/log"
import type { ImageAttachment } from "./detector"

const FETCH_TIMEOUT_MS = 10_000

// Detect bare local filesystem paths (as opposed to URLs): absolute POSIX,
// relative, dotfiles, home-relative, Windows drive paths, UNC, and bare
// relative filenames with a supported image extension ("shot.png",
// "assets/shot.PNG"). Backslashes are normalized to "/" first so Windows-style
// relative paths (".\shot.png") are recognized too. file:// URLs are not
// matched here: only http(s) URLs may go through fetch.
function isLocalPath(url: string): boolean {
  const normalized = url.replace(/\\/g, "/")
  return (
    normalized.startsWith("/") ||
    normalized.startsWith("./") ||
    normalized.startsWith("../") ||
    normalized.startsWith("~/") ||
    normalized.startsWith("//") || // Windows UNC after normalization
    /^\.[^/]/.test(normalized) || // dotfiles like .screenshot.png
    /^[A-Za-z]:\//.test(normalized) ||
    // Fallback: bare filenames and unprefixed relative paths ending in a
    // supported image extension. The ":" ban keeps scheme-bearing URLs
    // (https://, file://) out; drive paths carry ":" but match above.
    /^[^:]+\.(png|jpe?g|gif|webp)$/i.test(normalized)
  )
}

// Relative paths resolve against the opencode project directory. Backslashes
// are normalized in the relative case so ".\shot.png" typed on Windows also
// resolves on the POSIX host running the server.
function expandLocalPath(url: string, baseDir: string): string {
  if (url.startsWith("~/")) return resolve(homedir(), url.slice(2))
  if (isAbsolute(url) || url.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(url)) return url
  return resolve(baseDir, url.replace(/\\/g, "/"))
}

// Magic-byte sniff for the four supported image formats. Real files always
// carry a signature, so a file that fails the sniff is not a supported image
// regardless of what mime the caller claimed.
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png"
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif"
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp"
  }
  return null
}

// Read a local image file into a data URL so every vision provider can
// consume it. Missing, oversized, and non-image files are dropped with a
// note so the batch still proceeds. The mime comes from the file itself
// (magic bytes), never from the caller's guess.
function normalizeLocalImage(image: ImageAttachment, baseDir: string): ImageAttachment | null {
  const file = expandLocalPath(image.url, baseDir)
  try {
    if (!existsSync(file)) {
      log(`[prism] vision: local image not found, skipping`, { url: image.url })
      return null
    }
    const bytes = statSync(file).size
    if (bytes > VISION_IMAGE_MAX_BYTES) {
      log(`[prism] vision: image exceeds 8MB, skipping`, { url: image.url, bytes })
      return null
    }
    const buffer = readFileSync(file)
    const mime = sniffImageMime(buffer)
    if (!mime) {
      log(`[prism] vision: file is not a supported image, skipping`, { url: image.url })
      return null
    }
    return { ...image, mime, url: `data:${mime};base64,${buffer.toString("base64")}` }
  } catch (error) {
    log(`[prism] vision: local image read failed`, { url: image.url, error })
    return null
  }
}

// data: URLs carry their bytes inline, so the same 8MB cap and magic-byte
// sniff as file/remote sources apply — a claimed mime is never trusted.
function normalizeDataUrl(image: ImageAttachment): ImageAttachment | null {
  const match = image.url.match(/^data:([^;,]*)(;[^,]*)?,(.*)$/s)
  if (!match) {
    log(`[prism] vision: malformed data URL, skipping`, { url: image.url.slice(0, 64) })
    return null
  }
  const payload = match[3] ?? ""
  // Pre-check on the base64 length (4 chars per 3 bytes) so an oversized
  // payload is rejected before the decode allocates.
  if (payload.length > Math.ceil((VISION_IMAGE_MAX_BYTES / 3) * 4)) {
    log(`[prism] vision: data URL exceeds 8MB, skipping`, { url: image.url.slice(0, 64) })
    return null
  }
  try {
    const bytes = new Uint8Array(Buffer.from(payload, "base64"))
    if (bytes.byteLength > VISION_IMAGE_MAX_BYTES) {
      log(`[prism] vision: data URL exceeds 8MB, skipping`, { url: image.url.slice(0, 64) })
      return null
    }
    const mime = sniffImageMime(bytes)
    if (!mime) {
      log(`[prism] vision: data URL is not a supported image, skipping`, { url: image.url.slice(0, 64) })
      return null
    }
    return { ...image, mime }
  } catch (error) {
    log(`[prism] vision: data URL decode failed`, { url: image.url.slice(0, 64), error })
    return null
  }
}

// Convert remote image URLs to data URLs so every vision provider can consume
// them. Local data: URLs are validated (size + magic bytes), bare filesystem
// paths are read from disk. Only http(s) URLs are fetched: other protocols
// (file:, ftp:, ...) are rejected — fetch on Bun would happily read local
// files via file://, which is an arbitrary-local-file-read hole when the URL
// comes from tool output.
export async function normalizeImageUrl(
  image: ImageAttachment,
  baseDir = process.cwd(),
): Promise<ImageAttachment | null> {
  if (image.url.startsWith("data:")) return normalizeDataUrl(image)
  if (isLocalPath(image.url)) return normalizeLocalImage(image, baseDir)

  let parsed: URL
  try {
    parsed = new URL(image.url)
  } catch {
    log(`[prism] vision: invalid image URL, skipping`, { url: image.url })
    return null
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    log(`[prism] vision: unsupported image URL protocol, skipping`, { url: image.url, protocol: parsed.protocol })
    return null
  }

  try {
    const response = await fetch(image.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!response.ok) {
      log(`[prism] vision: failed to fetch image (${response.status})`, { url: image.url })
      return null
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > VISION_IMAGE_MAX_BYTES) {
      log(`[prism] vision: image exceeds 8MB, skipping`, { url: image.url, bytes: bytes.byteLength })
      return null
    }
    const mime = sniffImageMime(bytes)
    if (!mime) {
      log(`[prism] vision: remote response is not a supported image, skipping`, { url: image.url, bytes: bytes.byteLength })
      return null
    }
    return { ...image, mime, url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` }
  } catch (error) {
    log(`[prism] vision: image fetch failed`, { url: image.url, error })
    return null
  }
}

export async function normalizeImageBatch(images: ImageAttachment[], baseDir?: string): Promise<ImageAttachment[]> {
  const normalized = await Promise.all(images.map((image) => normalizeImageUrl(image, baseDir)))
  return normalized.filter((image): image is ImageAttachment => image !== null)
}
