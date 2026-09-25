#!/bin/bash
# Claude Code on the web のセッション開始時に、Bun を用意して依存を入れる
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# package.json の packageManager に書いた版に揃える
want="$(sed -n 's/.*"packageManager": *"bun@\([^"]*\)".*/\1/p' package.json)"
if ! command -v bun >/dev/null 2>&1 || [ "$(bun --version)" != "$want" ]; then
  curl -fsSL https://bun.sh/install | bash -s "bun-v$want"
  echo 'export PATH="$HOME/.bun/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
  export PATH="$HOME/.bun/bin:$PATH"
fi

bun install
