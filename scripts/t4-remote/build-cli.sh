#!/bin/bash
# Builds the headless T4 server archive (t3-<version>-<os>-<arch>.tar.gz) for this machine
# from origin/t4-code, the same way the release workflow builds T3's CLI archives.
#
# Usage: [T4_COMMIT=<sha>] scripts/t4-remote/build-cli.sh [version]
#
# Runs in a dedicated, disposable checkout (T4_CLI_SRC, default
# ~/.local/share/t4code-build/cli-src) that is reset to origin/t4-code on every run. With
# T4_COMMIT set it refuses to build anything else, so deploy-all.sh installs the commit it
# tested. Needs Node 24, rustup and mise; pnpm and Rust 1.95 are installed on demand. The
# archive path is printed last. See docs/operations/t4-machines.md.
set -euo pipefail
unset ELECTRON_RUN_AS_NODE
export CI=true
# Archiving copies the whole runtime; omarchy's /tmp is a small tmpfs that runs out of space.
export TMPDIR="$HOME/.cache/t4-build-tmp"
rm -rf "$TMPDIR" && mkdir -p "$TMPDIR"
trap 'rm -rf "$TMPDIR"' EXIT

WT="${T4_CLI_SRC:-$HOME/.local/share/t4code-build/cli-src}"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) PLATFORM=mac ARCH=arm64 RUST_TARGET=aarch64-apple-darwin KEY=darwin-arm64 ;;
  Linux-x86_64) PLATFORM=linux ARCH=x64 RUST_TARGET=x86_64-unknown-linux-gnu KEY=linux-x64 ;;
  Linux-aarch64) PLATFORM=linux ARCH=arm64 RUST_TARGET=aarch64-unknown-linux-gnu KEY=linux-arm64 ;;
  *) echo "No T4 server archive for $(uname -s)-$(uname -m)." >&2; exit 1 ;;
esac

if [ ! -e "$WT/.git" ]; then
  git clone --depth 1 -b t4-code https://github.com/IgorKravtsov/t3code.git "$WT"
fi
# Keep a full repository full: --depth on it would make it shallow.
if [ "$(git -C "$WT" rev-parse --is-shallow-repository)" = true ]; then
  git -C "$WT" fetch -q --depth 1 origin t4-code
else
  git -C "$WT" fetch -q origin t4-code
fi
if [ -n "${T4_COMMIT:-}" ] && [ "$(git -C "$WT" rev-parse FETCH_HEAD)" != "$T4_COMMIT" ]; then
  echo "origin/t4-code is $(git -C "$WT" rev-parse --short FETCH_HEAD), expected ${T4_COMMIT:0:10}." >&2
  exit 1
fi
git -C "$WT" reset -q --hard FETCH_HEAD
git -C "$WT" clean -fdq -e node_modules -e native/resource-monitor/target
cd "$WT"

server_version=$(node -p 'require("./apps/server/package.json").version')
VERSION="${1:-${server_version%%-*}-preview.$(date +%Y%m%d).$(date +%s)}"

export PATH="$WT/node_modules/.bin:$PATH"
if [ "$(pnpm --version 2>/dev/null)" != 11.10.0 ]; then
  npm i -g --prefix "$HOME/.local/share/t4code-build/pnpm" pnpm@11.10.0 >/dev/null
  export PATH="$HOME/.local/share/t4code-build/pnpm/bin:$PATH"
fi

git apply scripts/lib/t4-branding.patch
pnpm install --frozen-lockfile
node scripts/brand-t4.mjs "$WT"
# The executable reports the package version; releases stamp it before building.
node scripts/update-release-package-versions.ts "$VERSION"

# sysinfo in the resource monitor needs Rust 1.95; keep the machine's default toolchain.
if [ "$(rustc --version | cut -d. -f2)" -lt 95 ]; then
  rustup toolchain install 1.95.0 --profile minimal >/dev/null
  export RUSTUP_TOOLCHAIN=1.95.0
fi
(cd native/resource-monitor && cargo build --release --target "$RUST_TARGET")
mkdir -p "$WT/.cli-rm/$KEY"
cp "native/resource-monitor/target/$RUST_TARGET/release/t3-resource-monitor" "$WT/.cli-rm/$KEY/"

pnpm exec vp run --filter t3 build
# --build-sea needs Node 25.7+; CI pins 26.8.2 (SEA_NODE_VERSION in apps/server/vite.config.ts).
mise install -q node@26.8.2
PATH="$(mise where node@26.8.2)/bin:$PATH" node apps/server/scripts/cli.ts build-exe

rm -rf release-cli
node scripts/build-cli-archive.ts --platform "$PLATFORM" --arch "$ARCH" --version "$VERSION" \
  --resource-monitor-dir "$WT/.cli-rm" --output-dir release-cli
node scripts/smoke-cli-archive.ts --archive release-cli/* --expect-version "$VERSION"
ls "$WT"/release-cli/*.tar.gz
