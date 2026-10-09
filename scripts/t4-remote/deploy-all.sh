#!/bin/bash
# Brings every T4 install to the pushed t4-code commit: the T4 Code desktop app on this M4
# (target "m4") and the headless servers on omarchy and the M1 (their ssh host names).
# Run it by hand on the M4 from the main checkout after merging upstream and pushing.
#
# Usage: scripts/t4-remote/deploy-all.sh [--dry-run] [--force] [--skip-tests] [target...]
#        targets default to: m4 omarchy mac-m1-pro
#
#   1. Guard: runs every test file the fork changes relative to upstream. A test that fails
#      here (twice) but passes on the upstream commit we merged means a merge lost T4
#      behaviour, and nothing is deployed. Tests that fail on upstream too are listed and ignored.
#   2. Per target: skips it when it already runs this commit or nothing it ships changed. A
#      server is also skipped while a turn runs there, because installing restarts it.
#   3. Builds all targets in parallel. m4: build-t4-local.ts installs the app, which takes effect
#      the next time T4 starts (the running app is not touched). Servers: build-cli.sh on the
#      host, then install-service.sh, a version and T4-capability check, and a rollback to the
#      previous version if the new server does not come up as T4.
#
# --dry-run stops after the checks, --force ignores "up to date" and running turns.
# See docs/operations/t4-machines.md#updating-t4.
set -euo pipefail
unset ELECTRON_RUN_AS_NODE

PORT=3774
DRY_RUN=false FORCE=false SKIP_TESTS=false HOSTS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    --skip-tests) SKIP_TESTS=true ;;
    -*) echo "Unknown option $arg" >&2; exit 2 ;;
    *) HOSTS+=("$arg") ;;
  esac
done
[ ${#HOSTS[@]} -gt 0 ] || HOSTS=(m4 omarchy mac-m1-pro)

REPO=$(git rev-parse --show-toplevel)
cd "$REPO"
SCRIPTS="$REPO/scripts/t4-remote"
WORK="$HOME/.local/share/t4code-build/deploy"
mkdir -p "$WORK"
export PATH="$(mise where node@24)/bin:$PATH"
# Tests compare realpaths, and macOS hands out /var/folders, a symlink into /private.
export TMPDIR="$(cd "${TMPDIR:-/tmp}" && pwd -P)/"
# Remote commands run in a non-login shell; Homebrew, mise and rustup live outside its PATH.
REMOTE_PATH='export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";'
say() { printf '\n== %s\n' "$*"; }
# macOS ships bash 3.2: no mapfile, and "${empty[@]}" trips set -u.
lines_into() { # <array> <command...>
  local name=$1 line
  shift
  eval "$name=()"
  while IFS= read -r line; do eval "$name+=(\"\$line\")"; done < <("$@")
}

git fetch -q origin t4-code
git fetch -q upstream main
TARGET=$(git rev-parse HEAD)
if [ "$TARGET" != "$(git rev-parse origin/t4-code)" ] || [ -n "$(git status --porcelain)" ]; then
  echo "Deploy what origin has: check out t4-code at origin/t4-code with a clean tree (push or pull first)." >&2
  exit 1
fi
say "Deploying t4-code $(git log --oneline -1 "$TARGET")"

# --- 1. Guard -----------------------------------------------------------------------------
failed_tests() { # <checkout> <json> <files...>: prints "file :: test" for every failure
  local dir=$1 out=$2
  shift 2
  (cd "$dir" && node_modules/.bin/vp test run "$@" --reporter=json --outputFile="$out" >/dev/null 2>&1) || true
  node -e '
    const path = require("path");
    const report = require(process.argv[1]);
    for (const file of report.testResults)
      for (const test of file.assertionResults)
        if (test.status === "failed")
          console.log(path.relative(process.argv[2], file.name) + " :: " + test.fullName);
    if (report.testResults.length === 0) console.log("(no test results)");
  ' "$out" "$dir"
}

if [ "$SKIP_TESTS" = false ]; then
  BASE=$(git merge-base "$TARGET" upstream/main)
  changed_tests() {
    git diff --name-only "$BASE" "$TARGET" -- '*.test.ts' |
      while read -r file; do if [ -f "$file" ]; then echo "$file"; fi; done
  }
  lines_into TESTS changed_tests
  say "Guard: ${#TESTS[@]} test files the fork changes"
  FAILED=()
  [ ${#TESTS[@]} -eq 0 ] || lines_into FAILED failed_tests "$REPO" "$WORK/guard-t4.json" "${TESTS[@]}"
  if [ ${#FAILED[@]} -gt 0 ]; then
    # Timing-sensitive tests can fail under the load of the full run; rerun those files alone.
    lines_into RETRY_FILES eval 'printf "%s\n" "${FAILED[@]}" | sed "s/ :: .*//" | sort -u'
    lines_into FAILED failed_tests "$REPO" "$WORK/guard-t4.json" "${RETRY_FILES[@]}"
  fi
  if [ ${#FAILED[@]} -gt 0 ]; then
    printf '%d failing; checking which of them fail on upstream %s too\n' "${#FAILED[@]}" "${BASE:0:10}"
    UPSTREAM="$HOME/.local/share/t4code-build/upstream-check"
    if [ ! -e "$UPSTREAM/.git" ]; then
      git worktree add -q --detach "$UPSTREAM" "$BASE"
    else
      git -C "$UPSTREAM" checkout -q --detach -f "$BASE"
      git -C "$UPSTREAM" clean -fdq -e node_modules
    fi
    (cd "$UPSTREAM" && pnpm install --frozen-lockfile --prefer-offline >"$WORK/upstream-install.log" 2>&1)
    failed_files() {
      printf '%s\n' "${FAILED[@]}" | sed 's/ :: .*//' | sort -u |
        while read -r file; do if [ -f "$UPSTREAM/$file" ]; then echo "$file"; fi; done
    }
    lines_into FILES failed_files
    UPSTREAM_FAILED=""
    [ ${#FILES[@]} -eq 0 ] || UPSTREAM_FAILED=$(failed_tests "$UPSTREAM" "$WORK/guard-upstream.json" "${FILES[@]}")
    REGRESSIONS=$(printf '%s\n' "${FAILED[@]}" | grep -vxF -f <(printf '%s\n' "$UPSTREAM_FAILED") || true)
    printf '%s\n' "${FAILED[@]}" | grep -xF -f <(printf '%s\n' "$UPSTREAM_FAILED") |
      sed 's/^/  fails on upstream too, ignored: /' || true
    if [ -n "$REGRESSIONS" ]; then
      echo "T4 regressions, nothing deployed:" >&2
      printf '%s\n' "$REGRESSIONS" | sed 's/^/  /' >&2
      echo "Full report: $WORK/guard-t4.json" >&2
      exit 1
    fi
  fi
  echo "Guard passed."
fi

# --- 2. Which targets need it -------------------------------------------------------------
# What an install does not contain; changes there alone need no rebuild.
NOT_SHIPPED=(':!docs' ':!apps/mobile' ':!apps/marketing' ':!.agents' ':!*.md')
SERVER_NOT_SHIPPED=("${NOT_SHIPPED[@]}" ':!apps/desktop')
DESKTOP_NOT_SHIPPED=("${NOT_SHIPPED[@]}" ':!scripts/t4-remote')
DEPLOY=() BUILT=() pids=()
for host in "${HOSTS[@]}"; do
  if [ "$host" = m4 ]; then
    # build-t4-local.ts records the commit it built; building never restarts the running app.
    deployed=$(node -p 'require(process.argv[1]).builtCommit' "$HOME/.t4/t4-source.json" 2>/dev/null || true)
    running=0
    NOT_SHIPPED=("${DESKTOP_NOT_SHIPPED[@]}")
  else
    deployed=$(ssh "$host" 'cat ~/.t4/runtime/t4-commit 2>/dev/null' || true)
    running=$(ssh "$host" "sqlite3 -readonly ~/.t4/userdata/statev2.sqlite \"SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing','starting','running');\"" 2>/dev/null || echo "?")
    NOT_SHIPPED=("${SERVER_NOT_SHIPPED[@]}")
  fi
  if [ "$FORCE" = false ] && [ "$deployed" = "$TARGET" ]; then
    echo "$host: already runs ${TARGET:0:10}, skipped"
  elif [ "$FORCE" = false ] && [ -n "$deployed" ] && git cat-file -e "$deployed^{commit}" 2>/dev/null &&
    git diff --quiet "$deployed" "$TARGET" -- . "${NOT_SHIPPED[@]}"; then
    echo "$host: nothing it ships changed since ${deployed:0:10}, skipped"
  elif [ "$FORCE" = false ] && [ "$running" != 0 ]; then
    echo "$host: $running turn(s) running, skipped (rerun later, or --force to interrupt them)"
  else
    echo "$host: deploying (was ${deployed:-unknown commit}, running turns: $running)"
    DEPLOY+=("$host")
  fi
done
[ ${#DEPLOY[@]} -gt 0 ] || { say "Nothing to deploy."; exit 0; }
[ "$DRY_RUN" = false ] || { say "Dry run: would deploy ${DEPLOY[*]}."; exit 0; }

# --- 3. Build everywhere in parallel, then install one by one -----------------------------
say "Building on ${DEPLOY[*]} (logs in $WORK)"
for host in "${DEPLOY[@]}"; do
  if [ "$host" = m4 ]; then
    node scripts/build-t4-local.ts >"$WORK/build-m4.log" 2>&1 &
    pids+=($!)
    continue
  fi
  (
    ssh "$host" 'mkdir -p ~/.local/share/t4code-build/scripts'
    scp -q "$SCRIPTS/build-cli.sh" "$SCRIPTS/install-service.sh" "$host:.local/share/t4code-build/scripts/"
    ssh "$host" "$REMOTE_PATH T4_COMMIT=$TARGET mise exec node@24 -- bash ~/.local/share/t4code-build/scripts/build-cli.sh"
  ) >"$WORK/build-$host.log" 2>&1 &
  pids+=($!)
done
for i in "${!DEPLOY[@]}"; do
  host=${DEPLOY[$i]}
  if wait "${pids[$i]}"; then
    BUILT+=("$host")
    [ "$host" = m4 ] || echo "$host: built $(basename "$(tail -1 "$WORK/build-$host.log")")"
  else
    echo "$host: build failed, not installed; see $WORK/build-$host.log" >&2
    tail -5 "$WORK/build-$host.log" | sed 's/^/  /' >&2
  fi
done

FAILURES=$((${#DEPLOY[@]} - ${#BUILT[@]}))
for host in ${BUILT[@]+"${BUILT[@]}"}; do
  if [ "$host" = m4 ]; then
    if [ "$(node -p 'require(process.argv[1]).builtCommit' "$HOME/.t4/t4-source.json")" = "$TARGET" ]; then
      echo "m4: T4 Code.app installed at ${TARGET:0:10}; it takes effect the next time T4 starts"
    else
      FAILURES=$((FAILURES + 1))
      echo "m4: build finished but ~/.t4/t4-source.json does not record ${TARGET:0:10}; see $WORK/build-m4.log" >&2
    fi
    continue
  fi
  archive=$(tail -1 "$WORK/build-$host.log")
  version=$(basename "$archive" | sed -E 's/^t3-(.*)-(darwin|linux)-[a-z0-9]+\.tar\.gz$/\1/')
  previous=$(ssh "$host" 'cat ~/.t4/runtime/service-state.json' | sed -n 's/.*"activeVersion": *"\([^"]*\)".*/\1/p' || true)
  previous_commit=$(ssh "$host" 'cat ~/.t4/runtime/t4-commit 2>/dev/null' || true)
  say "$host: installing $version (previous $previous)"
  descriptor=""
  if ssh "$host" "$REMOTE_PATH bash ~/.local/share/t4code-build/scripts/install-service.sh '$archive' '$version' $PORT $TARGET" >>"$WORK/build-$host.log" 2>&1; then
    descriptor=$(ssh "$host" "curl -fsS -m 5 http://127.0.0.1:$PORT/.well-known/t3/environment" || true)
  fi
  if grep -q "\"serverVersion\":\"$version\"" <<<"$descriptor" &&
    grep -q '"environmentName":true' <<<"$descriptor" &&
    grep -q '"projectWorktreeDefaults":true' <<<"$descriptor"; then
    echo "$host: running $version with T4 capabilities"
  else
    FAILURES=$((FAILURES + 1))
    echo "$host: new server did not come up as T4; rolling back to $previous" >&2
    ssh "$host" "$REMOTE_PATH bash ~/.local/share/t4code-build/scripts/install-service.sh - '$previous' $PORT $previous_commit" >>"$WORK/build-$host.log" 2>&1 ||
      echo "$host: ROLLBACK FAILED, check it by hand; see $WORK/build-$host.log" >&2
  fi
done
[ "$FAILURES" -eq 0 ] && say "Done." || { say "$FAILURES target(s) not updated."; exit 1; }
