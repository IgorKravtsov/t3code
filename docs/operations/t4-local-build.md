# Building the local T4 Code app

Where T4 runs on each machine, and how to restart, update and diagnose it:
[t4-machines.md](./t4-machines.md).

On Linux or macOS, install Node 24, pnpm 11.10 and Rust via rustup, then run from this branch:

```sh
pnpm install --frozen-lockfile
node scripts/build-t4-local.ts --launch
```

The script builds the checked-in revision in a detached worktree for the machine's native
architecture. Linux installs under `~/.local/share/t4code/app`; macOS installs
`~/Applications/T4 Code.app`. Both provide `~/.local/bin/t4-code`. The local preview has a
separate application identity, URL handler, desktop profile, and `~/.t4` data directory;
it carries no T3 update feed.
The resource monitor requires Rust 1.95 or newer. If the active compiler is older, the script
installs 1.95 with rustup and selects it only for the build, leaving the default unchanged.

On first installation it copies all local `~/.t3/userdata`, backs up SQLite through the
read-only SQLite backup API (including WAL), and preserves the untouched snapshot in
`~/.t4/migration-source`. It copies the local desktop profile and re-encrypts saved connection
credentials and login tokens with T4's OS keyring key. Run from an unlocked graphical session
when protected credentials exist. Existing T4 data is preserved on subsequent builds;
`--no-migrate` starts with independent empty data instead.

The installed app records its source checkout in `~/.t4/t4-source.json` and checks
`upstream/main` against the `t4-code` branch at startup and at 09:00 and 18:00 while it runs
(the merge icon in the sidebar footer, which also checks on demand). It lists the new T3 commits
and whether they merge cleanly; conflicting files are listed and the update stays unavailable
until `t4-code` is reconciled by hand. **Merge & rebuild** creates the merge commit without
touching any checkout, builds it in a new worktree, pushes `t4-code` to `origin`, fast-forwards
the local branch, then installs and relaunches T4 after it quits. The branch moves only after a
successful build; the build log is `~/.t4/t4-update.log`. The button updates only this Mac's app; run
`scripts/t4-remote/deploy-all.sh` afterwards to update the other machines
([t4-machines.md](./t4-machines.md#updating-t4)). When `origin/t4-code` is ahead of the
installed build (for example, merged on another machine), the same control offers **Rebuild**.
At every start, T4 also applies settings changed in local T3 since the previous start
(`settings.json`, client, desktop and keybinding settings), keeping values edited in T4; the
last applied T3 values are kept in `~/.t4/t3-settings-baseline`. Thread continuation and
auto-resume stay off in T4 so both apps never resume the same threads.
Pushing over HTTPS falls back to the `gh` login. Older source worktrees and all but the last
previous application copy are removed after each installation.

To merge a fresh local T3 snapshot into an existing T4 installation, quit T4 completely
(T3 may keep running), then run on either Linux or macOS:

```sh
~/.local/bin/t4-sync --dry-run
~/.local/bin/t4-sync --launch
```

From this checkout the equivalent is `node scripts/sync-t4-local.ts --launch`.
To replace all T4 chats and settings instead of merging, use the separate command
`~/.local/bin/t4-replace --launch` (`node scripts/replace-t4-local.ts --launch` from this
checkout). `--dry-run` is available for both commands. Replacement removes T4-only data
from the active copy; its complete backup remains under `~/.t4/sync-backups`.
New chats, messages, projects, files and saved connections are imported; T4-only records
and settings edited in T4 are retained. Unchanged settings receive T3 updates through a
three-way merge against the previous snapshot. Repeating a sync does not duplicate events.
Every run retains both complete userdata snapshots under `~/.t4/sync-backups`.
Connections are re-encrypted with T4's OS keyring key; macOS may request access to the T3 key.
Newly imported scheduled tasks and pending agent work are disabled so both apps do not
execute the same work. T4 keeps its own environment identity and authentication sessions.

If both apps independently change the same chat's domain history, or database schemas are
incompatible, the script stops before replacing T4. Both snapshots remain in the backup;
automatic reconciliation of conflicting runs is not supported. A dry run checks databases
and files without replacing T4 or accessing the keyring. Run the command separately on
each machine to import its local T3 data; it does not transfer databases between machines.
Existing non-JSON files with the same path retain the T4 copy; the T3 copy remains in the backup.

The copied environment gets its own identity. Automatic agent continuation and scheduled tasks
are disabled in the active copy; their original values remain in the snapshot. Worktree cleanup
keeps T3's settings. Existing Git worktrees retain their paths and are shared working directories, so
start new T4 conversations in new worktrees when working alongside T3. Migration copies this
machine's local data; it does not synchronize machines or copy browser-only connection storage
from other devices. A macOS build runs on macOS and is locally signed rather than notarized.

Both transfer commands retain saved remote connection profiles, credentials, routes and
disabled states. Persist is owned by the remote server's boot service, which stays installed
and running when T4 quits; migration does not copy, restart or uninstall that service.
The local fork's SSH runner reuses the remote's installed Persist runtime and connects to
its existing server, so a working connection does not require a published T4 archive.
Direct connections also use their existing server. New server capabilities still require
this branch on that server. Without an installed Persist runtime, SSH bootstrap needs the
desktop's exact published CLI archive; a local unpublished preview cannot provide it.
