#!/usr/bin/env bash
# Fetch the pinned container engine into resources/engine (bundled by electron-builder as
# <Resources>/engine, mac only). Layout kept as upstream: bin/ (podman gvproxy vfkit krunkit),
# lib/ (libkrun and friends, found by krunkit through @rpath ../lib), share/krunkit (EFI firmware).
# The pkg is verified against the sha256 in scripts/engine-ref before anything is unpacked.
# podman-mac-helper is NOT shipped: it installs a privileged socket the app never uses.
# Must run on macOS (pkgutil). Dev shortcut: AW_ENGINE_PKG=/path/to/podman-installer-macos-arm64.pkg
# uses a local copy (still checked against the pin).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/resources/engine"
# shellcheck disable=SC1091
. "$root/scripts/engine-ref"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "fetch-engine: bad VERSION in scripts/engine-ref" >&2; exit 1; }
[[ "$ARM64_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "fetch-engine: bad ARM64_SHA256 in scripts/engine-ref" >&2; exit 1; }
[ "$(uname -s)" = "Darwin" ] || { echo "fetch-engine: needs macOS (pkgutil)" >&2; exit 1; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pkg="$work/podman.pkg"
if [ -n "${AW_ENGINE_PKG:-}" ]; then cp "$AW_ENGINE_PKG" "$pkg"; else
  curl -fsSL --retry 3 -o "$pkg" "https://github.com/containers/podman/releases/download/v${VERSION}/podman-installer-macos-arm64.pkg"
fi
actual="$(shasum -a 256 "$pkg" | cut -d' ' -f1)"
[ "$actual" = "$ARM64_SHA256" ] || { echo "fetch-engine: checksum mismatch: expected $ARM64_SHA256, got $actual" >&2; exit 1; }
pkgutil --expand-full "$pkg" "$work/x"
src="$(find "$work/x" -type d -name podman -path '*Payload*' -print -quit)"
[ -n "$src" ] && [ -x "$src/bin/podman" ] || { echo "fetch-engine: no podman payload in the pkg" >&2; exit 1; }
rm -rf "$out"; mkdir -p "$out/bin" "$out/lib" "$out/share"
for b in podman gvproxy vfkit krunkit; do
  [ -f "$src/bin/$b" ] || { echo "fetch-engine: missing bin/$b in the pkg" >&2; exit 1; }
  cp "$src/bin/$b" "$out/bin/$b"
done
# gvproxy: the pkg's copy is v0.8.9 (CVE-2026-107935). Use the pinned patched release instead.
[[ "$GVPROXY_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] && [[ "$GVPROXY_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "fetch-engine: bad GVPROXY pin in scripts/engine-ref" >&2; exit 1; }
curl -fsSL --retry 3 -o "$work/gvproxy" "https://github.com/containers/gvisor-tap-vsock/releases/download/${GVPROXY_VERSION}/gvproxy-darwin"
gv="$(shasum -a 256 "$work/gvproxy" | cut -d' ' -f1)"
[ "$gv" = "$GVPROXY_SHA256" ] || { echo "fetch-engine: gvproxy checksum mismatch: expected $GVPROXY_SHA256, got $gv" >&2; exit 1; }
cp "$work/gvproxy" "$out/bin/gvproxy"
cp "$src"/lib/*.dylib "$out/lib/"
cp -R "$src/share/krunkit" "$out/share/krunkit"
chmod -R u+rwX "$out"
find "$out" -name '._*' -delete
# krunkit's upstream LC_RPATHs are /opt/homebrew/lib and /opt/podman/lib only, so it would load libkrun
# from Homebrew (or fail on a Mac without it) instead of from this bundle. Rpaths are searched in order, so
# drop both and leave only the bundle-relative one. This invalidates the upstream signature; electron-builder re-signs it (hardened, our identity).
install_name_tool -delete_rpath /opt/homebrew/lib -delete_rpath /opt/podman/lib -add_rpath "@executable_path/../lib" "$out/bin/krunkit" 2>/dev/null
[ "$(otool -l "$out/bin/krunkit" | grep -c 'cmd LC_RPATH')" = 1 ] || { echo "fetch-engine: krunkit must have exactly one rpath" >&2; exit 1; }
otool -l "$out/bin/krunkit" | grep -q "@executable_path/../lib" || { echo "fetch-engine: krunkit rpath not added" >&2; exit 1; }
"$out/bin/gvproxy" -version 2>&1 | grep -q "${GVPROXY_VERSION#v}" || { echo "fetch-engine: bundled gvproxy is not $GVPROXY_VERSION" >&2; exit 1; }
"$out/bin/podman" --version | grep -q "$VERSION" || { echo "fetch-engine: bundled podman is not $VERSION" >&2; exit 1; }
printf '%s\n' "$VERSION" > "$out/ENGINE_VERSION"
echo "fetch-engine: bundled engine $VERSION at $out"
