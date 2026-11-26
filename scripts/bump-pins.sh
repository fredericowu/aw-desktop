#!/usr/bin/env bash
# Move scripts/ui-ref, scripts/core-ref and WORKSPACE_IMAGE in src/main/localRuntime.ts to upstream latest.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ui_remote="${AW_UI_REMOTE:-https://github.com/fredericowu/aw-workspace-ui.git}"
core_remote="${AW_CORE_REMOTE:-https://github.com/fredericowu/aw-workspace.git}"
export GIT_TERMINAL_PROMPT=0
ui_head="$(git -c credential.helper= ls-remote "$ui_remote" HEAD | cut -f1)"
core_latest="$(git -c credential.helper= ls-remote --tags --refs "$core_remote" 'v*' | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
[[ "$ui_head" =~ ^[0-9a-f]{40}$ ]] && [ -n "$core_latest" ] || { echo "bump-pins: could not read upstream refs" >&2; exit 2; }
echo "$ui_head" > "$root/scripts/ui-ref"
sed -i.bak -E "s#^IMAGE=.*#IMAGE=ghcr.io/fredericowu/aw-workspace:$core_latest#" "$root/scripts/core-ref"
sed -i.bak -E "s#(export const WORKSPACE_IMAGE = \"ghcr.io/fredericowu/aw-workspace:)v[0-9.]+\"#\1$core_latest\"#" "$root/src/main/localRuntime.ts"
rm -f "$root/scripts/core-ref.bak" "$root/src/main/localRuntime.ts.bak"
echo "bump-pins: ui $ui_head core $core_latest (confirm the image exists and run the upgrade drive before merging)"
