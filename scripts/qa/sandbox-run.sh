#!/usr/bin/env bash
# Isolated XDG sandbox: load prism from the local path and run one opencode
# session, printing prism's init logs. Never touches the real opencode state.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SANDBOX="$(mktemp -d /tmp/prism-qa.XXXXXX)"
export XDG_DATA_HOME="$SANDBOX/data"
export XDG_CONFIG_HOME="$SANDBOX/config"
export XDG_STATE_HOME="$SANDBOX/state"
export XDG_CACHE_HOME="$SANDBOX/cache"
export OPENCODE_DISABLE_AUTOUPDATE=1

mkdir -p "$XDG_CONFIG_HOME/opencode"
cat > "$XDG_CONFIG_HOME/opencode/opencode.json" <<EOF
{
  "plugin": ["$PLUGIN_DIR"]
}
EOF

echo "sandbox: $SANDBOX"
opencode run "say hi" --format json 2>&1 | grep --line-buffered -E "\[prism\]" || true
echo "sandbox kept at: $SANDBOX"
