#!/usr/bin/env bash
# Notarize + staple every signed DMG in dist/, verify it, refresh the DMG
# entry in latest-mac.yml, then publish the mac assets to the GitHub Release.
# electron-builder's afterSign hook only notarizes the .app, never the .dmg
# container, so this runs after `electron-builder --mac --publish never`.
set -euo pipefail

TAG="${1:?usage: finalize-dmg.sh <tag>}"
DIST="${DIST:-dist}"
: "${ASC_KEY_ID:?}" "${ASC_ISSUER_ID:?}" "${ASC_KEY_PATH:?}"

shopt -s nullglob
dmgs=("$DIST"/*.dmg)
[ "${#dmgs[@]}" -gt 0 ] || { echo "no DMG in $DIST" >&2; exit 1; }

for dmg in "${dmgs[@]}"; do
  echo "== $dmg"
  codesign --verify --verbose=2 "$dmg"
  xcrun notarytool submit "$dmg" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" \
    --issuer "$ASC_ISSUER_ID" --wait --timeout 30m | tee "$RUNNER_TEMP/notary.txt"
  grep -q "status: Accepted" "$RUNNER_TEMP/notary.txt"
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  codesign --verify --verbose=2 "$dmg"
  spctl --assess --type open --context context:primary-signature -vv "$dmg"
  # Stapling rewrites the file: refresh its hash/size in latest-mac.yml.
  node build/refresh-yml-dmg.js "$DIST/latest-mac.yml" "$dmg"
  # The pre-staple blockmap no longer matches; the updater uses the zip.
  rm -f "$dmg.blockmap"
done

# Publish: the release may not exist yet (windows job runs after this one).
gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --title "$TAG" --notes "AW Desktop $TAG" --verify-tag
# Stage under the names in latest-mac.yml: files on disk contain a space
# ("AW Desktop-..."), which GitHub would rewrite to "AW.Desktop-...".
stage="$(mktemp -d)"
for f in "$DIST"/*.dmg "$DIST"/*.zip "$DIST"/*.zip.blockmap "$DIST"/latest-mac.yml; do
  [ -e "$f" ] || continue
  b="$(basename "$f")"
  cp "$f" "$stage/${b// /-}"
done
# Never replace live assets (a rerun must not break a working release): only
# upload what the release does not have yet.
existing="$(gh release view "$TAG" --json assets --jq '.assets[].name')"
for f in "$stage"/*; do
  if grep -qxF "$(basename "$f")" <<<"$existing"; then
    echo "skip (already published): $(basename "$f")"
  else
    gh release upload "$TAG" "$f"
  fi
done
