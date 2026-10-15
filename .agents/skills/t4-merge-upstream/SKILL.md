---
name: t4-merge-upstream
description: Merge upstream T3 Code (`upstream/main`) into the `t4-code` fork and resolve the conflicts so both sides keep working. Use when the T4 app reports conflicting files ("Resolve these conflicts in t4-code before updating"), when asked to merge or sync upstream into t4-code, or to resolve merge conflicts on the t4-code branch. Deploying afterwards belongs to the t4-code skill.
---

# Merge upstream into t4-code

`t4-code` is stock T3 (`upstream/main`) plus the fork's changes. A merge must keep every T4
difference and every upstream change, unless upstream now ships the same feature. Background:
[t4-differences.md](../../../docs/operations/t4-differences.md) (what the fork carries and
where conflicts usually land) and
[t4-machines.md, "Updating T4"](../../../docs/operations/t4-machines.md#updating-t4).

Never press or trigger **Merge & rebuild** from an agent: it relaunches T4 and ends the session.

## 1. Start from a clean, current t4-code

`t4-code` is often checked out in a worktree, not the main checkout. Find it with
`git worktree list | grep '\[t4-code\]'`, otherwise `git checkout t4-code` in a clean checkout.

```sh
git status --short                        # must be clean; never stash someone's work silently
git fetch origin && git fetch upstream
git merge --ff-only origin/t4-code        # a non-ff here means unpushed local work: ask
git merge upstream/main                   # stops with the conflict list
git diff --name-only --diff-filter=U      # the files to resolve
```

## 2. Understand both sides of each file before editing

For every conflicted file:

```sh
base=$(git merge-base HEAD MERGE_HEAD)
git log --oneline $base..MERGE_HEAD -- <file>   # what upstream changed (read the PR titles)
git log --oneline $base..HEAD -- <file>         # what T4 changed
git diff $base HEAD -- <file>                   # the T4 side as a patch
git diff $base MERGE_HEAD -- <file>             # the upstream side as a patch
git checkout --conflict=zdiff3 -- <file>        # re-render markers with the base section
```

Match the T4 hunks to a row in t4-differences.md ("Product changes" or "Fork machinery"). The
base section (`|||||||`) tells which side changed what: a line only one side touched takes that
side's version.

## 3. Resolve

- **Default: keep both.** Most conflicts are two unrelated additions on neighbouring lines (one
  field, one import, one test case each). Take upstream's version of the surrounding code and
  re-apply the T4 addition on top of it.
- **Upstream refactored code T4 extended** (renamed, moved, re-typed, changed signatures): port
  the T4 behaviour onto the new upstream shape. Do not resurrect the old code to keep a T4 hunk.
- **Upstream ships the same feature:** take upstream and drop the T4 version, then remove its
  row from t4-differences.md in the merge commit. When unsure whether it is equivalent, ask.
- **Tests:** keep both sides' cases, and update T4 cases to upstream's new fixtures and helpers.
  A T4 test is the only guard for a T4 behaviour; never delete one to make the merge pass.
- **Generated or lock files** (`pnpm-lock.yaml`, etc.): take upstream's version, then regenerate
  with the package manager rather than hand-merging.
- Then read the whole merged file, not just the hunks: both sides' imports used, no duplicated
  declarations, every caller of a changed signature updated. Also check non-conflicting files
  that use what you changed (`git grep <symbol>`); auto-merged code can still be broken.

`git diff --check` and `grep -rn '^<<<<<<<\|^>>>>>>>' <files>` must come back empty.
`git add` each resolved file.

## 4. Verify

Agent sessions in T3/T4 export `ELECTRON_RUN_AS_NODE=1`; run tools with
`env -u ELECTRON_RUN_AS_NODE`. If the merge changed dependencies, run `vp i` first.

- Typecheck each package you touched: `cd <package> && env -u ELECTRON_RUN_AS_NODE vp run typecheck`
  (or `../../node_modules/.bin/tsc-rs --noEmit`).
- Run the tests of the conflicted files and of the T4 tests next to them:
  `env -u ELECTRON_RUN_AS_NODE vp test run <files>`. A failure that also fails on `upstream/main`
  is not caused by the merge; say so instead of fixing it.
- No repo-wide checks; `deploy-all.sh` runs the full T4 guard later.

## 5. Commit and hand off

```sh
git commit --no-edit -m "chore(t4): merge upstream/main into t4-code"
```

Add a short body listing each conflicted file and how it was resolved (kept both, ported,
dropped in favour of upstream). Push `origin t4-code` when the user asked to update T4 or
agreed to push; then the t4-code skill covers deploying (`scripts/t4-remote/deploy-all.sh`).

If you cannot resolve a conflict confidently, stop with the merge in progress and report the
file, both sides' intent, and the options. `git merge --abort` only with the user's agreement.
