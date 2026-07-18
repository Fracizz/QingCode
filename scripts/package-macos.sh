#!/usr/bin/env bash
# Build QingCode for macOS (Apple Silicon arm64) via Tauri.
# Usage: ./scripts/package-macos.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-Force) FORCE=1 ;;
  esac
done

TARGET="${TAURI_TARGET:-aarch64-apple-darwin}"
CONF="$ROOT/src-tauri/tauri.conf.json"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
PRODUCT="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
OUT_DIR="$ROOT/release"
BUNDLE_DIR="$ROOT/src-tauri/target/$TARGET/release/bundle"

echo "> Prepare macOS arm64 ($TARGET)"

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi

if [[ "$FORCE" -eq 1 || ! -f dist/index.html ]]; then
  echo "> Frontend build"
  pnpm build
else
  # Rebuild if any src file is newer than dist
  if find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -newer dist/index.html | head -n 1 | grep -q .; then
    echo "> Frontend build (src newer than dist)"
    pnpm build
  else
    echo "  frontend up to date - skipping pnpm build"
  fi
fi

echo "> Tauri release build ($TARGET)"
# Prefer dmg + app; unsigned is OK for CI (Gatekeeper: right-click Open).
pnpm tauri build --target "$TARGET" --bundles dmg,app

mkdir -p "$OUT_DIR"

DMG="$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' -type f | sort | tail -n 1 || true)"
APP="$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' -type d | sort | tail -n 1 || true)"

if [[ -z "$DMG" && -z "$APP" ]]; then
  echo "No .dmg or .app found under $BUNDLE_DIR" >&2
  find "$BUNDLE_DIR" -maxdepth 3 -type f 2>/dev/null || true
  exit 1
fi

VERSIONED_DMG="$OUT_DIR/${PRODUCT}_${VERSION}-macos-arm64.dmg"
LATEST_DMG="$OUT_DIR/${PRODUCT}-macos-arm64.dmg"
VERSIONED_ZIP="$OUT_DIR/${PRODUCT}_${VERSION}-macos-arm64.zip"
LATEST_ZIP="$OUT_DIR/${PRODUCT}-macos-arm64.zip"

if [[ -n "$DMG" ]]; then
  cp -f "$DMG" "$VERSIONED_DMG"
  cp -f "$DMG" "$LATEST_DMG"
  echo "OK dmg -> $VERSIONED_DMG"
fi

if [[ -n "$APP" ]]; then
  rm -f "$VERSIONED_ZIP" "$LATEST_ZIP"
  (
    cd "$(dirname "$APP")"
    ditto -c -k --sequesterRsrc --keepParent "$(basename "$APP")" "$VERSIONED_ZIP"
  )
  cp -f "$VERSIONED_ZIP" "$LATEST_ZIP"
  echo "OK app zip -> $VERSIONED_ZIP"
fi

echo "OK macOS arm64 package written to release/"
