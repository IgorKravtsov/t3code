# How T4 Code differs from T3 Code

> For maintainers of the `t4-code` fork. Where T4 runs and how to operate it:
> [t4-machines.md](./t4-machines.md). Building the desktop app:
> [release.md](./release.md#separate-local-t4-code-build).

T4 Code is the `t4-code` branch of `IgorKravtsov/t3code`: stock T3 Code (`upstream/main`) plus
the changes below. It is merged with upstream regularly, so every difference here is something a
merge has to carry. `git diff upstream/main...t4-code` is the authoritative list.

The changes fall into two groups. **Fork machinery** exists only so T4 can run beside T3 and keep
itself up to date; it would never go upstream. **Product changes** are ordinary T3 Code features
and fixes that upstream does not have (yet); each is a candidate for an upstream PR, and once
upstream ships an equivalent, drop the T4 version during the merge instead of keeping both.

## Fork machinery

### A separate app beside T3

- **Own identity and data.** The desktop app is branded _T4 Code_ (name, icon, bundle id, URL
  handler, desktop profile) and keeps its data in `~/.t4` on port 3774, so it never touches
  T3's `~/.t3` or port 3773. Branding is applied at build time by `scripts/brand-t4.mjs` and
  `scripts/lib/t4-branding.patch`, so the shared source still says "T3 Code".
- **No T3 update feed.** The local build carries no release feed, and headless T4 servers set
  `T3CODE_RELEASE_BASE_URL=https://t4-updates.invalid`, so a client's "Update server" fails
  instead of replacing the fork with a stock T3 release.
- **Isolated launchers.** Local launchers drop the inherited T3 service environment, and the Mac
  app starts in the graphical security session so it can reach the Keychain.

### Data brought over from T3

- **First install** copies all of `~/.t3/userdata` (SQLite through the backup API), the desktop
  profile, and re-encrypts saved connection credentials with T4's own keyring key
  (`scripts/build-t4-local.ts`, `scripts/lib/t4-keyring.ts`).
- **`t4-sync`** merges a fresh T3 snapshot into T4 and keeps T4-only records and settings edited
  in T4; **`t4-replace`** replaces T4 data with the snapshot. Both keep full backups
  (`scripts/lib/t4-merge.ts`, `t4-state.ts`, `t4-transfer.ts`).
- **Settings follow T3.** At every start the desktop app applies settings changed in T3 since
  the previous start, keeping values edited in T4 (`apps/desktop/src/t4/t4SettingsSync.ts`).
- **No double work.** Imported scheduled tasks, pending agent work, thread continuation and
  auto-resume are disabled in T4, so T3 and T4 never run the same work. The copy gets its own
  environment identity.
- **Headless servers** get their data through `scripts/t4-remote/migrate-userdata.py`.

### Updating from upstream

- **Merge & rebuild from the app.** The sidebar footer pill (`T4UpstreamPill.tsx`, backed by
  `apps/desktop/src/t4/T4UpstreamSync.ts` and `t4UpstreamGit.ts`) checks `upstream/main` at
  startup, at 09:00 and 18:00, and on demand. It merges, builds in a separate worktree, pushes
  `t4-code`, and relaunches T4 after it quits. When the merge conflicts it lists the files and waits for a manual
  merge; when `origin/t4-code` is ahead of the installed build it offers **Rebuild**.
- **One deploy command.** `scripts/t4-remote/deploy-all.sh` brings the M4 app and both
  headless servers to the pushed commit, after a test guard that stops a merge which lost T4
  behaviour ([t4-machines.md](./t4-machines.md#updating-t4)).
- **SSH Persist reuse.** The SSH runner can reuse a remote host's installed Persist runtime
  instead of downloading a published release archive, which a local fork build cannot provide
  (`packages/ssh/src/tunnel.ts`, `reusePersistentService`).

## Product changes

| Change                        | What the user gets                                                                                                                                                                                                                                                        | Main code                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Environment names             | Rename a machine once (**Settings → Connections → Rename**, mobile **Environment name**); every client, including T3 Connect, shows the new name. **Use detected name** reverts.                                                                                          | `ServerEnvironment.ts`, `EnvironmentNameDialog.tsx`, `client-runtime/src/state/presentation.ts`, `relay/discovery.ts` |
| Default worktree base branch  | A per-environment and per-project base ref for new worktrees (for example `origin/GA`), used by new threads and scheduled tasks. Agents can set it, and the worktree location, through the environment preferences MCP tool. The picker searches local and `origin` refs. | `GitManager.ts`, `WorktreeBaseBranchSetting.tsx`, `WorktreeBaseBranchPicker.tsx`, `ScheduledTasksSettings.tsx`        |
| Per-project worktree location | The worktree location can be overridden per project and may be relative to the project root (`../worktrees`). Cleanup and review still find worktrees in every location.                                                                                                  | `worktreesDirectory.ts`, `WorktreeMcpService.ts`, `GitVcsDriverCore.ts`, `storageCleanup.ts`, `ReviewService.ts`      |
| GitHub account per checkout   | Pull requests are read with the `gh` account chosen in the project's checkout, so a work and a personal account (separate `GH_CONFIG_DIR`) both work.                                                                                                                     | `GitHubCredentials.ts`, `PullRequestService.ts`, `GitHubPullRequestApi.ts`                                            |
| SSH host aliases              | A remote such as `git@github-work:org/repo` resolves through `ssh -G` to the real host, so the repository is recognised and its pull requests keep the project's credentials.                                                                                             | `RepositoryIdentityResolver.ts`                                                                                       |
| Named worktree branches       | The branch picker of a new-worktree draft has a **New branch** field; the worktree is created on that branch instead of an auto-named one. Web only; the server already accepted an explicit branch.                                                                      | `BranchPicker.tsx`, `BranchToolbarBranchSelector.tsx`, `composerDraftStore.ts`, `ChatView.tsx`                        |
| Reliable Stop for Claude      | Stop ends a Claude turn even when the CLI never acknowledges the interrupt (5 s timeout, then the process is closed), and the composer shows that Stop is in progress instead of offering it again.                                                                       | `ClaudeAdapterV2.ts`, `EffectWorker.ts`, `client-runtime/src/state/threadExecution.ts`, `ComposerPrimaryActions.tsx`  |

The matching user guides are [remote-access.md](../user/remote-access.md#name-a-machine),
[project-settings.md](../user/project-settings.md#new-worktree-defaults) and
[source-control.md](../user/source-control.md).

## Keeping merges clean

- Keep fork machinery in its own files (`apps/desktop/src/t4/`, `scripts/*t4*`,
  `scripts/t4-remote/`, `packages/contracts/src/t4Upstream.ts`) and touch shared files with the
  smallest hook possible. The upstream bridge is declared outside `ipc.ts` for this reason.
- Conflicts usually land in the files the product changes share with active upstream work:
  `ConnectionsSettings.tsx`, `ChatView.tsx`, `ChatComposer.tsx`, `serverSettings.ts`,
  `packages/contracts/src/settings.ts` and the user docs. Keep both sides unless upstream now
  provides the same feature.
- Every T4 difference needs a test in a file the fork changes: `deploy-all.sh` runs those
  files and refuses to deploy a merge that breaks one.
- When you add or drop a difference, update this page in the same commit.
