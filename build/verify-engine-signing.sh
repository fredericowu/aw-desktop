#!/usr/bin/env bash
# Assert the bundled engine in a built .app is complete and correctly signed. Run after
# electron-builder (and on the Mac against an installed app). Exits non-zero on any gap.
# usage: verify-engine-signing.sh "/path/AW Desktop.app" [--notarized]
set -euo pipefail
app="${1:?usage: verify-engine-signing.sh <app> [--notarized]}"
e="$app/Contents/Resources/engine"
fail=0
bad() { echo "FAIL: $*" >&2; fail=1; }
ent() { codesign -d --entitlements - --xml "$1" 2>/dev/null || true; }
for f in bin/podman bin/gvproxy bin/vfkit bin/krunkit lib/libkrun.dylib lib/libvirglrenderer.1.dylib lib/libepoxy.0.dylib lib/libMoltenVK.dylib share/krunkit/KRUN_EFI.silent.fd; do
  [ -f "$e/$f" ] || bad "missing $f"
done
for p in "$e"/bin/podman "$e"/bin/gvproxy "$e"/bin/vfkit "$e"/bin/krunkit "$e"/lib/*.dylib; do
  [ -f "$p" ] || continue; f="${p#"$e"/}"
  d="$(codesign -dvv "$p" 2>&1)" || { bad "$f not signed"; continue; }
  echo "$d" | grep -q "Authority=Developer ID Application" || bad "$f: not Developer ID signed"
  echo "$d" | grep -Eq "flags=0x[0-9a-f]+\(.*runtime" || bad "$f: hardened runtime off"
  echo "$d" | grep -q "^Timestamp=" || bad "$f: no secure timestamp"
  codesign --verify --strict "$p" || bad "$f: signature does not verify"
done
ent "$e/bin/vfkit" | grep -q "com.apple.security.virtualization" || bad "vfkit lacks com.apple.security.virtualization"
ent "$e/bin/krunkit" | grep -q "com.apple.security.hypervisor" || bad "krunkit lacks com.apple.security.hypervisor"
ent "$e/bin/krunkit" | grep -q "com.apple.security.cs.disable-library-validation" || bad "krunkit lacks disable-library-validation"
codesign --verify --deep --strict "$app" || bad "app deep verify failed"
if [ "${2:-}" = "--notarized" ]; then
  xcrun stapler validate "$app" || bad "app not stapled"
  spctl --assess --type execute -vv "$app" || bad "Gatekeeper rejects the app"
fi
[ "$fail" = 0 ] && echo "engine signing OK: $e" || exit 1
