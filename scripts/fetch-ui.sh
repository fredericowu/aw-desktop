#!/usr/bin/env bash
# Build the aw-workspace-ui SPA into resources/ui (bundled by electron-builder as
# <resources>/ui and served by the local front server). aw-workspace-ui is a
# PRIVATE repo, so CI needs a read token in AW_UI_REPO_TOKEN.
# Dev shortcut: AW_UI_SRC=/path/to/aw-workspace-ui (already checked out) skips the clone.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/resources/ui"
src="${AW_UI_SRC:-}"
if [ -z "$src" ]; then
  if [ -z "${AW_UI_REPO_TOKEN:-}" ]; then
    echo "fetch-ui: AW_UI_REPO_TOKEN is not set (read access to fredericowu/aw-workspace-ui required), or set AW_UI_SRC" >&2
    exit 1
  fi
  src="$(mktemp -d)/aw-workspace-ui"
  git -c credential.helper= clone --depth 1 \
    "https://x-access-token:${AW_UI_REPO_TOKEN}@github.com/fredericowu/aw-workspace-ui.git" "$src" >/dev/null
fi
(cd "$src" && npm ci --ignore-scripts && npx vite build --outDir "$PWD/dist-desktop" --emptyOutDir)
rm -rf "$out"; mkdir -p "$out"
cp -R "$src/dist-desktop/." "$out/"
[ -f "$out/index.html" ] || { echo "fetch-ui: no index.html in build output" >&2; exit 1; }
rm -rf "$src/dist-desktop"
echo "fetch-ui: bundled UI at $out"
