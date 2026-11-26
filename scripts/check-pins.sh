#!/usr/bin/env bash
# Release gate: fail when a pin is behind upstream, so a desktop release never ships a stale UI or core.
#   scripts/ui-ref   vs aw-workspace-ui default-branch HEAD
#   scripts/core-ref vs the newest vX.Y.Z tag of aw-workspace
# ALLOW_STALE_PINS=true downgrades the failure to a warning (an upstream that moved minutes ago).
# AW_UI_REMOTE / AW_CORE_REMOTE override the git remotes (tests).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
ui_remote="${AW_UI_REMOTE:-https://github.com/fredericowu/aw-workspace-ui.git}"
core_remote="${AW_CORE_REMOTE:-https://github.com/fredericowu/aw-workspace.git}"
ui_pin="$(tr -d '[:space:]' < "$root/scripts/ui-ref")"
core_pin="$(sed -n 's/^IMAGE=//p' "$root/scripts/core-ref" | tr -d '[:space:]')"
core_pin_tag="${core_pin##*:}"
export GIT_TERMINAL_PROMPT=0
ui_head="$(git -c credential.helper= ls-remote "$ui_remote" HEAD | cut -f1)"
core_latest="$(git -c credential.helper= ls-remote --tags --refs "$core_remote" 'v*' | sed 's#.*refs/tags/##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
[ -n "$ui_head" ] && [ -n "$core_latest" ] || { echo "check-pins: could not read upstream refs" >&2; exit 2; }
stale=0
if [ "$ui_pin" != "$ui_head" ]; then echo "check-pins: scripts/ui-ref $ui_pin is behind aw-workspace-ui HEAD $ui_head" >&2; stale=1; fi
if [ "$core_pin_tag" != "$core_latest" ]; then echo "check-pins: scripts/core-ref $core_pin_tag is behind aw-workspace $core_latest" >&2; stale=1; fi
if [ "$stale" = 1 ]; then
  if [ "${ALLOW_STALE_PINS:-}" = "true" ]; then echo "check-pins: ALLOW_STALE_PINS=true, continuing" >&2; exit 0; fi
  echo "check-pins: run scripts/bump-pins.sh and open a PR, or set ALLOW_STALE_PINS=true" >&2
  exit 1
fi
echo "check-pins: ui $ui_pin and core $core_pin_tag are current"
