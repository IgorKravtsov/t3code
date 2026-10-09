# T4 Code machines

> Runbook for the `t4-code` fork as deployed on Ihor's machines: what runs where, how to check
> it, restart it, update it and diagnose it. Building the local desktop app itself is covered in
> [release.md](./release.md#separate-local-t4-code-build).
> What the fork changes compared with stock T3: [t4-differences.md](./t4-differences.md).

T4 runs **beside** stock T3 on every machine and never shares its data: T3 keeps `~/.t3` and
port 3773, T4 uses `~/.t4` and port 3774. Never run two servers against the same data home, and
never point a T4 server at `~/.t3`.

| Machine                                          | Role                                            | T4 server                                                                              | Tailnet URL                                     | Environment label |
| ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------- |
| MacBook M4 (`ihors-macbook-air`)                 | Client; `T4 Code.app` with its own local server | Inside the desktop app, `127.0.0.1:3774`, only while the app runs and the Mac is awake | `https://ihors-macbook-air.taild33710.ts.net`   | `m4-air`          |
| omarchy (Linux x64)                              | Always-on headless server                       | systemd user unit `t4code.service`, `127.0.0.1:3774`                                   | `https://omarchy.taild33710.ts.net:8444`        | `omarchy`         |
| MacBook M1 (`Noutbuk-Igor`, user `igorkravtsov`) | Always-on headless server                       | launchd agent `com.t4tools.t4code.service`, `127.0.0.1:3774`                           | `https://macbook-pro-m1.taild33710.ts.net:8443` | `Ноутбук — Ігор`  |

T3 on the same machines: omarchy `t3code.service` → `:8443`, M1 `com.t3tools.t3code.service` →
`:443`. Work that must survive the M4 closing its lid runs in the omarchy or M1 environment; the
M4's own environment stops when the app quits or the Mac sleeps.

The source checkout is `~/usr/projects/t3code` on the M4, on branch `t4-code` (pushed to
`origin` = `IgorKravtsov/t3code`).

## Headless servers (omarchy and M1)

Each server is the fork's CLI archive (`t3` single executable plus `client/`,
`resource-monitor/` and native `node_modules/`) installed under `~/.t4`:

```text
~/.t4/runtime/versions/<version>/t3      the server; `t3 __service-launcher` supervises `t3 serve`
~/.t4/runtime/service-state.json         {"protocol":3,"activeVersion":"<version>"}
~/.t4/userdata/                          database, settings, secrets, logs (the T4 data home)
~/.t4/userdata/logs/boot-service.log     launcher and server stdout/stderr
~/.t4/userdata/logs/server.trace.ndjson  structured trace (spans, errors)
~/.t4/worktrees/<project>/               worktrees of threads started in T4
```

The service sets `T3CODE_HOME=~/.t4`, `T3CODE_PORT=3774`, and
`T3CODE_RELEASE_BASE_URL=https://t4-updates.invalid`, so an "Update server" request from a client
fails instead of replacing the fork with a stock T3 release. Update with `deploy-all.sh` (see [Updating T4](#updating-t4)).

### Status, logs, restart

omarchy:

```sh
systemctl --user status t4code.service
journalctl --user -u t4code.service -n 50       # unit events; output goes to boot-service.log
tail -f ~/.t4/userdata/logs/boot-service.log
curl -fsS http://127.0.0.1:3774/.well-known/t3/environment
systemctl --user restart t4code.service         # interrupts running turns; they continue after restart
tailscale serve status
```

M1:

```sh
launchctl print gui/$(id -u)/com.t4tools.t4code.service | grep -E 'state|pid'
tail -f ~/.t4/userdata/logs/boot-service.log
curl -fsS http://127.0.0.1:3774/.well-known/t3/environment
launchctl kickstart -k gui/$(id -u)/com.t4tools.t4code.service
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

Unit and plist: `~/.config/systemd/user/t4code.service`,
`~/Library/LaunchAgents/com.t4tools.t4code.service.plist`. Both are written by
`scripts/t4-remote/install-service.sh`; edit the script, not the installed file.

### Staying up

- **Crash:** `Restart=always` / `KeepAlive` restart the server within seconds.
- **Reboot, omarchy:** the unit is enabled and `Linger=yes`, so it starts at boot without a
  login. The LUKS disk password is still needed at boot.
- **Reboot, M1:** FileVault asks for the password before boot; entering it logs the user in,
  which starts the launch agent. There is no auto-login, and the agent needs the login session
  for Keychain-backed provider credentials, so it cannot be a system daemon.
- **Sleep:** M1 never sleeps (`pmset disablesleep 1` plus `caffeinate`). omarchy stays awake with
  the lid closed while on AC power (the remote-desktop sleep inhibitor). On battery it can still
  suspend; the server does not take a sleep inhibitor itself.
- **Interrupted turns:** both servers set `continueThreadsAfterServerUpdate` and
  `autoResumeLimitedThreads`, so turns cut off by a restart, crash or reboot, and threads paused
  by a provider limit, continue on their own. This is best effort, not exactly-once: a tool call
  in flight can repeat or be lost.
- Clients only read and steer. Closing a client, the M4 sleeping, or losing the connection
  never stops work on these servers.

## GitHub accounts on omarchy

omarchy picks the GitHub account per directory with `gh-dir-auth`
(`~/usr/projects/gh-cli-wrapper/gh`, linked as `~/.local/bin/gh`; rules in
`~/.config/gh-dir-auth/config`, longest prefix wins). T4 relies on it in two places:

- The fork asks `gh auth token` **in the project's checkout** and pins that token for every pull
  request call (`apps/server/src/pullRequest/GitHubPullRequestApi.ts`, `CredentialDirectory` in
  `apps/server/src/sourceControl/GitHubCredentials.ts`). Stock T3 asks from the server's working
  directory, so it always got the default account.
- The wrapper must come before mise's `gh` shim on the service `PATH`. `t4code.service` takes
  `~/.local/bin` first; `t3code.service` has the same fix in
  `~/.config/systemd/user/t3code.service.d/gh-wrapper.conf` (applies on its next restart).

Threads started in T4 create worktrees in `~/.t4/worktrees/<project>`; the config mirrors every
`~/.t3/worktrees/<project>` rule for them (backup before that change: `config.bak-t4`). Add both
paths when adding a project rule.

M1 has no `gh` and no wrapper; GitHub features there use only a token saved in Settings.

Check what the server would get, from a thread's worktree:

```sh
cd <worktree>; PATH=$(systemctl --user show t4code.service -p Environment | tr ' ' '\n' | sed -n 's/^PATH=//p') gh api user -q .login
```

## Connecting clients

The servers accept direct HTTPS over the tailnet only; keep SSH for administration. A client
pairs once with a one-time code. Mint one on the server (valid 2 hours here):

```sh
# omarchy or M1
~/.t4/runtime/versions/$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.t4/runtime/service-state.json")))["activeVersion"])')/t3 \
  auth pairing create --base-dir ~/.t4 --ttl 2h --label iPhone \
  --base-url https://omarchy.taild33710.ts.net:8444      # or https://macbook-pro-m1.taild33710.ts.net:8443
# the M4's own environment (T4 app running), from the CLI build checkout
~/.local/share/t4code-build/cli-src/apps/server/dist-exe/t3 auth pairing create --base-dir ~/.t4 \
  --ttl 2h --label iPhone --base-url https://ihors-macbook-air.taild33710.ts.net
```

It prints a code and a `/pair#token=…` link. In T4 on a Mac add the environment by URL and code.
The stock T3 iPhone app works too (the client checks only `orchestrationProtocolVersion`, 2 on
both sides); the phone needs Tailscale on. `t3 auth session list --base-dir ~/.t4` shows paired
clients, `t3 auth session revoke` removes one. Do not accept a client's offer to update a T4
server.

## Updating T4

An update has two steps: merge upstream T3 into `t4-code` and push, then bring every machine to
that commit with one command. Everything runs on the M4 from `~/usr/projects/t3code`.

### 1. Merge upstream

Either press **Merge & rebuild** in the T4 app (merge icon in the sidebar footer; see
[release.md](./release.md#separate-local-t4-code-build)), or by hand:

```sh
git checkout t4-code && git pull
git fetch upstream && git merge upstream/main
# resolve conflicts, then: git push origin t4-code
```

The app's button is unavailable while the merge conflicts; it lists the files, and the merge is
done by hand. Upstream and T4 usually add unrelated things to the same lines, so keep both
sides. Drop a T4 change only when upstream now ships the same feature, and then update
[t4-differences.md](./t4-differences.md).

### 2. Deploy everywhere

```sh
scripts/t4-remote/deploy-all.sh --dry-run   # the guard and the per-target decisions, no changes
scripts/t4-remote/deploy-all.sh             # all targets: m4 omarchy mac-m1-pro
scripts/t4-remote/deploy-all.sh omarchy     # only the named targets
```

Prerequisites: the checkout is on `t4-code` at `origin/t4-code` with a clean tree (the script
refuses anything else, so it deploys exactly what was pushed); remotes `origin` and `upstream`;
ssh host aliases `omarchy` and `mac-m1-pro`; Node 24 through mise.

What it does, in order:

1. **Guard.** It runs every `*.test.ts` file the fork changes relative to upstream (about 30
   files, about a minute). Files with failures run again on their own, because some tests fail
   only under load. A test that still fails is run on the upstream commit that was merged, in a
   cached checkout at `~/.local/share/t4code-build/upstream-check`. Tests that fail there too
   are listed as "fails on upstream too, ignored". Any other failure is a **T4 regression**:
   the script stops and deploys nothing. Fix the regression on `t4-code`, push, and run again.
   `--skip-tests` skips the guard; use it only right after a guard passed for the same commit.
2. **Per target decision.** It skips a target that already has this commit, and one where
   nothing it ships changed (docs, mobile, marketing and agent files never count; desktop code
   does not count for servers, and the server deploy scripts do not count for the app). A server
   with a running turn is skipped as well, because installing restarts it and interrupts the
   turn. Rerun later, or pass `--force` to override all skips.
3. **Build and install, all targets in parallel.**
   - **m4**: `node scripts/build-t4-local.ts` builds the desktop app and installs
     `~/Applications/T4 Code.app`. The running app keeps working (its bundle is renamed to
     `T4 Code.app.previous-<time>`), and the new build takes effect the next time T4 starts. An
     agent running inside T4 must not quit T4 itself; tell the user to restart it.
   - **omarchy, mac-m1-pro**: each builds its own archive with `build-cli.sh` (copied to
     `~/.local/share/t4code-build/scripts/` on the host), then `install-service.sh` installs it
     and restarts the service. The script checks that the server answers with the new version
     and the T4 capabilities (`environmentName`, `projectWorktreeDefaults`); otherwise it
     reinstalls the previous version.

It exits 0 only when every chosen target is current. Logs:
`~/.local/share/t4code-build/deploy/build-<target>.log`, guard reports `guard-t4.json` and
`guard-upstream.json` in the same directory.

Where the deployed commit is recorded, which is also how to check a machine by hand:

| Target      | Recorded in                            | Build checkout                                    |
| ----------- | -------------------------------------- | ------------------------------------------------- |
| m4          | `~/.t4/t4-source.json` (`builtCommit`) | `~/.local/share/t4code-build/source-*` worktrees  |
| omarchy, M1 | `~/.t4/runtime/t4-commit` on the host  | `~/.local/share/t4code-build/cli-src` on the host |

### By hand

One server: copy `scripts/t4-remote/build-cli.sh` and `install-service.sh` to the host, never
run the copy inside `~/.local/share/t4code-build/cli-src` (the build resets that checkout), then:

```sh
T4_COMMIT=<sha> mise exec node@24 -- bash build-cli.sh       # prints the archive path last
bash install-service.sh <archive> <version> 3774 <sha>       # version: t3-<version>-<os>-<arch>.tar.gz
```

`T4_COMMIT` makes the build refuse anything but that commit. Both hosts build natively and need
git, rustup and mise; the build installs Node, pnpm 11.10 and Rust 1.95 when missing, without
changing the host's defaults. Temporary files go to `~/.cache/t4-build-tmp`, because omarchy's
`/tmp` is a small tmpfs. The M4 app alone: `node scripts/build-t4-local.ts`.

To roll a server back, reinstall a version that is still under `~/.t4/runtime/versions`; no
archive is needed for an installed version: `bash install-service.sh - <old-version> 3774`.

## Data

- **New machine:** copy `scripts/t4-remote/migrate-userdata.py` to the host and run it with
  `python3`; it copies `~/.t3/userdata` into a new `~/.t4/userdata` (SQLite through the read-only backup API, a new
  environment id, host keys dropped, schedules off), then `install-service.sh`. It refuses to
  overwrite an existing `~/.t4/userdata`.
- **Refresh T4 from T3 on omarchy:** `~/.local/bin/t4-sync` (merge, keeps T4 edits) or
  `t4-replace` (fresh T3 snapshot) from the omarchy desktop install. Stop `t4code.service` first;
  over SSH export `WAYLAND_DISPLAY`, `DISPLAY`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS`
  from `systemctl --user show-environment`, because credential re-encryption runs Electron. Every
  run keeps full backups in `~/.t4/sync-backups`. A merge aborts when both sides changed the same
  thread; nothing is written then.
- **Do not launch the T4 desktop app on omarchy while `t4code.service` runs:** it would start a
  second server on `~/.t4`. Use the browser at the tailnet URL there, or connect from a Mac.
- The M4 has no service; its `~/.t4` belongs to the desktop app, and `t4-sync`/`t4-replace`
  there need the app quit.

## Troubleshooting

| Symptom                                                               | Cause and fix                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request "not found" on omarchy                                   | Wrong GitHub account. Check the `gh api user` command above from the thread's worktree, the service `PATH`, and that the worktree path has a `gh-dir-auth` rule.                                                                                               |
| Client says the server needs an update                                | Upstream raised `ORCHESTRATION_PROTOCOL_VERSION`; merge upstream into `t4-code` and run `deploy-all.sh`.                                                                                                                                                       |
| Server down after reboot (M1)                                         | Nobody logged in yet; unlock FileVault at the Mac.                                                                                                                                                                                                             |
| `t4-sync` on macOS fails with `Cannot find module 'electron'`         | It ran with `ELECTRON_RUN_AS_NODE=1` from a T3 terminal on a build before `23099bfebe`; rebuild T4 or run `env -u ELECTRON_RUN_AS_NODE t4-sync`.                                                                                                               |
| `t4-sync`/`t4-replace` over SSH: `Missing X server or $DISPLAY`       | Export the graphical session variables (see Data).                                                                                                                                                                                                             |
| `migrate-userdata.py` hangs                                           | An older copy without the locked-database fallback met a Chromium database held by the in-app browser.                                                                                                                                                         |
| omarchy: "CLI is installed but failed to run. Timed out", Stop slow   | Agents share `t3work.slice` through `~/.local/lib/t3-resource-guard` (see its README). Above the slice's `MemoryHigh` the kernel throttles every agent; check `systemctl --user show t3work.slice -p MemoryCurrent -p MemoryHigh` and `/proc/pressure/memory`. |
| `deploy-all.sh`: "T4 regressions, nothing deployed"                   | The merge broke a T4 test that passes upstream. Read the listed test and `guard-t4.json`, fix it on `t4-code`, push, rerun.                                                                                                                                    |
| `deploy-all.sh`: "Deploy what origin has"                             | The checkout is not at `origin/t4-code` or has uncommitted changes; push or pull first.                                                                                                                                                                        |
| Build: "origin/t4-code is X, expected Y"                              | Someone pushed during the deploy; rerun `deploy-all.sh`.                                                                                                                                                                                                       |
| Build on omarchy: `Unknown system error -122` or ENOSPC in `copyfile` | `/tmp` (tmpfs) is full. `build-cli.sh` uses `~/.cache/t4-build-tmp` since `676ba7e3e6`; an older copy of the script does not.                                                                                                                                  |
| Tests fail only when run from a T3/T4 terminal or agent               | Those sessions export `ELECTRON_RUN_AS_NODE=1`; run tests with `env -u ELECTRON_RUN_AS_NODE`. `deploy-all.sh` unsets it.                                                                                                                                       |
| Install says the server did not answer                                | Read the tail it prints from `boot-service.log`; check that port 3774 is free (`ss -ltnp` / `lsof -iTCP:3774`).                                                                                                                                                |
| `launchctl bootstrap` fails with `Input/output error`                 | The old job was still unloading; rerun `install-service.sh`, which waits for it.                                                                                                                                                                               |
