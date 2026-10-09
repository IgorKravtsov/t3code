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
fails instead of replacing the fork with a stock T3 release. Update by redeploying (below).

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

## Updating the servers

Merge upstream and push `t4-code` first (the T4 app's **Merge & rebuild**, or by hand), then
build each platform's archive natively and install it. Installing restarts the service, which
interrupts running turns; they continue afterwards.

The script resets its own checkout, so run a copy of it, never the file inside
`~/.local/share/t4code-build/cli-src`. The archive name carries the version:
`t3-<version>-<os>-<arch>.tar.gz`.

omarchy builds its own Linux archive (Node 24, Rust and mise are installed there):

```sh
scp scripts/t4-remote/build-cli.sh scripts/t4-remote/install-service.sh omarchy:/tmp/
ssh omarchy 'mise exec node@24 -- bash /tmp/build-cli.sh'
ssh omarchy 'bash /tmp/install-service.sh ~/.local/share/t4code-build/cli-src/release-cli/t3-<version>-linux-x64.tar.gz <version> 3774'
```

M1 has no toolchain; build on the M4 (same architecture) and copy:

```sh
cp scripts/t4-remote/build-cli.sh /tmp/ && PATH="$(mise where node@24)/bin:$PATH" bash /tmp/build-cli.sh
scp ~/.local/share/t4code-build/cli-src/release-cli/t3-<version>-darwin-arm64.tar.gz \
  scripts/t4-remote/install-service.sh mac-m1-pro:/tmp/
ssh mac-m1-pro 'bash /tmp/install-service.sh /tmp/t3-<version>-darwin-arm64.tar.gz <version> 3774'
```

The build script unsets `ELECTRON_RUN_AS_NODE`, which T3 terminals export. `install-service.sh` keeps old versions under
`~/.t4/runtime/versions`; to roll back, rerun it with the older archive or point
`service-state.json` and the unit's `ExecStart` back and restart.

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

| Symptom                                                             | Cause and fix                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request "not found" on omarchy                                 | Wrong GitHub account. Check the `gh api user` command above from the thread's worktree, the service `PATH`, and that the worktree path has a `gh-dir-auth` rule.                                                                                               |
| Client says the server needs an update                              | Upstream raised `ORCHESTRATION_PROTOCOL_VERSION`; merge upstream into `t4-code` and redeploy.                                                                                                                                                                  |
| Server down after reboot (M1)                                       | Nobody logged in yet; unlock FileVault at the Mac.                                                                                                                                                                                                             |
| `t4-sync` on macOS fails with `Cannot find module 'electron'`       | It ran with `ELECTRON_RUN_AS_NODE=1` from a T3 terminal on a build before `23099bfebe`; rebuild T4 or run `env -u ELECTRON_RUN_AS_NODE t4-sync`.                                                                                                               |
| `t4-sync`/`t4-replace` over SSH: `Missing X server or $DISPLAY`     | Export the graphical session variables (see Data).                                                                                                                                                                                                             |
| `migrate-userdata.py` hangs                                         | An older copy without the locked-database fallback met a Chromium database held by the in-app browser.                                                                                                                                                         |
| omarchy: "CLI is installed but failed to run. Timed out", Stop slow | Agents share `t3work.slice` through `~/.local/lib/t3-resource-guard` (see its README). Above the slice's `MemoryHigh` the kernel throttles every agent; check `systemctl --user show t3work.slice -p MemoryCurrent -p MemoryHigh` and `/proc/pressure/memory`. |
| Install says the server did not answer                              | Read the tail it prints from `boot-service.log`; check that port 3774 is free (`ss -ltnp` / `lsof -iTCP:3774`).                                                                                                                                                |
| `launchctl bootstrap` fails with `Input/output error`               | The old job was still unloading; rerun `install-service.sh`, which waits for it.                                                                                                                                                                               |
