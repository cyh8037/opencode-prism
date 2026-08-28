import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { VISION_IMAGE_BATCH_MAX_BYTES, VISION_IMAGE_MAX_BYTES } from "../../config/constants"
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
// are normalized FIRST — exactly like isLocalPath — so a Windows-typed
// "~\shot.png" hits the home branch instead of resolving to
// <baseDir>/~/shot.png, and ".\shot.png" resolves on a POSIX host too.
export function expandLocalPath(url: string, baseDir: string, home: string = homedir()): string {
  const normalized = url.replace(/\\/g, "/")
  if (normalized.startsWith("~/")) return resolve(home, normalized.slice(2))
  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return url
  return resolve(baseDir, normalized)
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
      log(`[prism] vision: image exceeds ${VISION_IMAGE_MAX_BYTES / 1_048_576}MB, skipping`, { url: image.url, bytes })
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

// data: URLs carry their bytes inline, so the same size cap and magic-byte
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
    log(`[prism] vision: data URL exceeds ${VISION_IMAGE_MAX_BYTES / 1_048_576}MB, skipping`, { url: image.url.slice(0, 64) })
    return null
  }
  try {
    const bytes = new Uint8Array(Buffer.from(payload, "base64"))
    if (bytes.byteLength > VISION_IMAGE_MAX_BYTES) {
      log(`[prism] vision: data URL exceeds ${VISION_IMAGE_MAX_BYTES / 1_048_576}MB, skipping`, { url: image.url.slice(0, 64) })
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
    // Reject on the declared size before buffering the body — a huge (or
    // maliciously slow) response would otherwise be downloaded in full
    // before the post-read check rejects it. Absent/chunked Content-Length
    // falls through to the streaming check below.
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > VISION_IMAGE_MAX_BYTES) {
      log(`[prism] vision: image exceeds ${VISION_IMAGE_MAX_BYTES / 1_048_576}MB (Content-Length), skipping`, {
        url: image.url,
        bytes: declaredLength,
      })
      return null
    }
    const bytes = await readBodyBounded(response, image.url)
    if (bytes === null) return null
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

// Stream the response body with a hard byte cap. response.arrayBuffer()
// buffers the ENTIRE body first — a chunked response without a Content-Length
// header (or one lying about it) would pull an arbitrarily large file into
// memory before any size check could reject it. Reading chunk by chunk stops
// the download the moment the cap is crossed: reader.cancel() aborts the
// transfer, nothing beyond VISION_IMAGE_MAX_BYTES is ever allocated.
async function readBodyBounded(response: Response, url: string): Promise<Uint8Array | null> {
  const reader = response.body?.getReader()
  if (!reader) {
    log(`[prism] vision: response has no readable body, skipping`, { url })
    return null
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > VISION_IMAGE_MAX_BYTES) {
        log(`[prism] vision: image exceeds ${VISION_IMAGE_MAX_BYTES / 1_048_576}MB, aborting download`, {
          url,
          bytes: total,
        })
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch (error) {
    log(`[prism] vision: image download interrupted`, { url, error })
    await reader.cancel().catch(() => {})
    return null
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function normalizeImageBatch(images: ImageAttachment[], baseDir?: string): Promise<ImageAttachment[]> {
  const normalized = await Promise.all(images.map((image) => normalizeImageUrl(image, baseDir)))
  // Providers cap the WHOLE inline request (Gemini at 20MB), and base64
  // inflates payloads ~33% — four per-image-maximum images would exceed it.
  // Measure the encoded payload (what actually goes on the wire) and keep
  // the earliest images that fit, dropping the tail like any other invalid
  // image so the batch still proceeds.
  const kept: ImageAttachment[] = []
  let encodedBytes = 0
  for (const image of normalized) {
    if (image === null) continue
    const comma = image.url.indexOf(",")
    const bytes = image.url.length - comma - 1
    if (encodedBytes + bytes > VISION_IMAGE_BATCH_MAX_BYTES) {
      log(`[prism] vision: batch exceeds ${VISION_IMAGE_BATCH_MAX_BYTES / 1_048_576}MB, dropping remaining images`, {
        kept: kept.length,
        encodedBytes,
      })
      break
    }
    kept.push(image)
    encodedBytes += bytes
  }
  return kept
}
