#!/usr/bin/env bash
# Build the aw-workspace-ui SPA into resources/ui (bundled by electron-builder as
# <resources>/ui and served by the local front server). aw-workspace-ui is PUBLIC,
# so no credential is needed; if AW_UI_REPO_TOKEN is set it is used (covers the repo
# going private again).
# The UI revision is PINNED: scripts/ui-ref holds the full 40-char commit SHA that is
# built, so a tag determines what ships. The script fails if the ref file is missing or
# malformed. Bump the ref with a PR when the desktop needs a newer UI.
# Dev shortcut: AW_UI_SRC=/path/to/aw-workspace-ui (already checked out) skips the clone
# and the pin (build-info then records the checkout's HEAD, or "dev").
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/resources/ui"
src="${AW_UI_SRC:-}"
ui_commit="dev"
if [ -z "$src" ]; then
  ref_file="$root/scripts/ui-ref"
  [ -f "$ref_file" ] || { echo "fetch-ui: missing $ref_file (pinned UI commit SHA)" >&2; exit 1; }
  ui_commit="$(tr -d '[:space:]' < "$ref_file")"
  [[ "$ui_commit" =~ ^[0-9a-f]{40}$ ]] || { echo "fetch-ui: scripts/ui-ref must hold a full 40-char commit SHA" >&2; exit 1; }
  src="$(mktemp -d)/aw-workspace-ui"
  url="https://github.com/fredericowu/aw-workspace-ui.git"
  if [ -n "${AW_UI_REPO_TOKEN:-}" ]; then
    url="https://x-access-token:${AW_UI_REPO_TOKEN}@github.com/fredericowu/aw-workspace-ui.git"
  fi
  mkdir -p "$src"
  git -C "$src" init -q
  GIT_TERMINAL_PROMPT=0 git -C "$src" -c credential.helper= fetch -q --depth 1 "$url" "$ui_commit"
  git -C "$src" checkout -q --detach FETCH_HEAD
  [ "$(git -C "$src" rev-parse HEAD)" = "$ui_commit" ] || { echo "fetch-ui: checked-out commit != pinned $ui_commit" >&2; exit 1; }
else
  ui_commit="$(git -C "$src" rev-parse HEAD 2>/dev/null || echo dev)"
fi
(cd "$src" && npm ci --ignore-scripts && npx vite build --outDir "$PWD/dist-desktop" --emptyOutDir)
rm -rf "$out"; mkdir -p "$out"
cp -R "$src/dist-desktop/." "$out/"
[ -f "$out/index.html" ] || { echo "fetch-ui: no index.html in build output" >&2; exit 1; }
rm -rf "$src/dist-desktop"
# Traceability: which desktop commit / tag / UI commit / workflow run this bundle came from.
# No secrets: only public identifiers.
desk_commit="${GITHUB_SHA:-$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)}"
tag=""; case "${GITHUB_REF:-}" in refs/tags/*) tag="${GITHUB_REF#refs/tags/}";; esac
core_image="$(sed -n 's/^IMAGE=//p' "$root/scripts/core-ref" 2>/dev/null | tr -d '[:space:]')"
printf '{"desktopCommit":"%s","tag":"%s","uiCommit":"%s","coreImage":"%s","workflowRunId":"%s"}\n' \
  "$desk_commit" "$tag" "$ui_commit" "$core_image" "${GITHUB_RUN_ID:-}" > "$root/resources/build-info.json"
echo "fetch-ui: bundled UI at $out"
