// Minimal JSONC support in a single pass: strips // and /* */ comments and
// trailing commas (only outside strings) while preserving string contents.
// String-awareness is what makes trailing-comma stripping safe: a blind
// regex over the text would corrupt values like "bracket, ]".

export function stripJsonc(source: string): string {
  let output = ""
  let inString = false
  let inEscape = false
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
      // Escape-state machine: a backslash escapes the NEXT character
      // whatever it is (a quote, another backslash, a plain letter). The
      // parity of the backslash run decides whether the following quote
      // closes the string — explicit state makes "C:\\path\\" (even run)
      // close at its final quote while "\\\"" stays an escaped quote.
      if (inEscape) {
        inEscape = false
      } else if (char === "\\") {
        inEscape = true
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
      output += char
      continue
    }
    if (char === ",") {
      // Trailing comma: look ahead past whitespace and comments; drop the
      // comma only if the next significant character closes the container.
      let j = i + 1
      let significant = ""
      while (j < source.length) {
        const c = source[j]
        if (c === undefined) break
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          j++
          continue
        }
        if (c === "/" && source[j + 1] === "/") {
          while (j < source.length && source[j] !== "\n") j++
          continue
        }
        if (c === "/" && source[j + 1] === "*") {
          j += 2
          while (j < source.length && !(source[j] === "*" && source[j + 1] === "/")) j++
          j += 2
          continue
        }
        significant = c
        break
      }
      if (significant === "}" || significant === "]") continue
    }
    output += char
  }

  return output
}

export function parseJsonc(source: string): unknown {
  // Windows editors (Notepad, PowerShell 5's UTF8 encoding) commonly save a
  // UTF-8 BOM; JSON.parse rejects the leading \uFEFF outright, which would
  // silently void the entire config file.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  return JSON.parse(stripJsonc(text))
}
