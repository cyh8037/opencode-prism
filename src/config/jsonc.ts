// Minimal JSONC support: strips // and /* */ comments and trailing commas,
// then parses with JSON.parse. String contents (URLs, regexes) are preserved.
export function stripJsoncComments(source: string): string {
  let output = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const next = source[i + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inString) {
      output += char
      if (char === "\\") {
        output += next ?? ""
        i++
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      i++
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      i++
      continue
    }
    if (char === '"') {
      inString = true
    }
    output += char
  }

  return output
}

export function stripTrailingCommas(source: string): string {
  return source.replace(/,\s*([}\]])/g, "$1")
}

export function parseJsonc(source: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsoncComments(source)))
}
