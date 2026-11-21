#!/usr/bin/env bash
# Build the aw-workspace-ui SPA into resources/ui (bundled by electron-builder as
# <resources>/ui and served by the local front server). aw-workspace-ui is PUBLIC,
# so no credential is needed. AW_UI_REPO_TOKEN is optional (only for a private fork).
# Dev shortcut: AW_UI_SRC=/path/to/aw-workspace-ui (already checked out) skips the clone.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/resources/ui"
src="${AW_UI_SRC:-}"
if [ -z "$src" ]; then
  src="$(mktemp -d)/aw-workspace-ui"
  url="https://github.com/fredericowu/aw-workspace-ui.git"
  if [ -n "${AW_UI_REPO_TOKEN:-}" ]; then
    url="https://x-access-token:${AW_UI_REPO_TOKEN}@github.com/fredericowu/aw-workspace-ui.git"
  fi
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= clone --depth 1 "$url" "$src" >/dev/null
fi
(cd "$src" && npm ci --ignore-scripts && npx vite build --outDir "$PWD/dist-desktop" --emptyOutDir)
rm -rf "$out"; mkdir -p "$out"
cp -R "$src/dist-desktop/." "$out/"
[ -f "$out/index.html" ] || { echo "fetch-ui: no index.html in build output" >&2; exit 1; }
rm -rf "$src/dist-desktop"
echo "fetch-ui: bundled UI at $out"
