// Pane shell commands. Ported from oh-my-openagent's tmux-core pane-command.

const TMUX_COMMAND_SHELL = "/bin/sh"

function shellQuoteForNestedCommand(value: string): string {
  const singleQuoted = `'${value.replaceAll("'", "'\\''")}'`
  return singleQuoted
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`")
    .replace(/"/g, '\\"')
}

// The command that runs inside an agent pane: attaches the OpenCode CLI to
// the child session so its live TUI renders in the pane.
export function buildTmuxAttachCommand(serverUrl: string, sessionID: string, directory: string): string {
  const escapedUrl = shellQuoteForNestedCommand(serverUrl)
  const escapedSessionID = shellQuoteForNestedCommand(sessionID)
  const escapedDirectory = shellQuoteForNestedCommand(directory)
  return `${TMUX_COMMAND_SHELL} -c "opencode attach ${escapedUrl} --session ${escapedSessionID} --dir ${escapedDirectory}"`
}

// Placeholder shown while waiting for the session to become attachable;
// prevents an empty blinking pane.
export function buildTmuxPlaceholderCommand(description: string): string {
  const escapedDescription = description.replaceAll('"', '\\"')
  return `${TMUX_COMMAND_SHELL} -c "printf '%s\\n%s\\n' \\"prism subagent pane ready: ${escapedDescription}\\" \\"Waiting for session...\\"; while :; do sleep 86400; done"`
}

// Auth env prefix for the attach command when the OpenCode server requires
// a password.
export function buildAuthEnvPrefix(env: Record<string, string | undefined> = process.env): string {
  const password = env.OPENCODE_SERVER_PASSWORD
  if (!password) return ""
  const username = env.OPENCODE_SERVER_USERNAME
  const parts = [`OPENCODE_SERVER_PASSWORD='${password.replaceAll("'", "'\\''")}'`]
  if (username !== undefined) {
    parts.push(`OPENCODE_SERVER_USERNAME='${username.replaceAll("'", "'\\''")}'`)
  }
  return `${parts.join(" ")} `
}
