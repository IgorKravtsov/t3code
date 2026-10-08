---
name: t4-code
description: Build, install, deploy and operate T4 Code, the `t4-code` fork of T3 Code on Ihor's machines. Use for building the local T4 desktop app, merging upstream and rebuilding, redeploying the headless T4 servers on omarchy and the M1, checking or restarting them, pairing clients, syncing T3 data into T4, and diagnosing a T4 install. Also use when asked which machines run T4, which ports or URLs they use, or how to use T4 alongside T3.
---

# T4 Code

T4 is the `t4-code` branch of this repository (`origin` = `IgorKravtsov/t3code`), installed
beside stock T3 on every machine. The source checkout is `~/usr/projects/t3code` on the
MacBook M4.

The docs are the source of truth. Read the section you need before acting, and update them when
the setup changes:

- [docs/operations/t4-machines.md](../../../docs/operations/t4-machines.md): what runs where,
  status/logs/restart, staying up, GitHub accounts on omarchy, pairing clients, updating the
  headless servers, data migration, troubleshooting.
- [docs/operations/release.md#separate-local-t4-code-build](../../../docs/operations/release.md#separate-local-t4-code-build):
  building the local desktop app, the in-app upstream updater (**Merge & rebuild** /
  **Rebuild**), `t4-sync` and `t4-replace`.

## Map

| Machine                | ssh          | T4 runs as                                                   | Tailnet URL                                     |
| ---------------------- | ------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| MacBook M4 (client)    | local        | `~/Applications/T4 Code.app`, own server on `:3774`          | `https://ihors-macbook-air.taild33710.ts.net`   |
| omarchy (Linux x64)    | `omarchy`    | systemd user unit `t4code.service` on `127.0.0.1:3774`       | `https://omarchy.taild33710.ts.net:8444`        |
| MacBook M1 (macOS arm) | `mac-m1-pro` | LaunchAgent `com.t4tools.t4code.service` on `127.0.0.1:3774` | `https://macbook-pro-m1.taild33710.ts.net:8443` |

T3 keeps `~/.t3` and port 3773 (omarchy `:8443`, M1 `:443`). Long-running work belongs on
omarchy or the M1; the M4 environment stops when its app quits or the Mac sleeps.

## Which task, which tool

- **Local desktop app, first install or manual rebuild:** `node scripts/build-t4-local.ts --launch`
  (Node 24, pnpm, Rust). Normally the app's own updater does this.
- **Upstream T3 changed:** **Merge & rebuild** in the T4 app (merge icon in the sidebar footer),
  or merge `upstream/main` into `t4-code` by hand and push. Then redeploy the headless servers if
  server code changed.
- **Headless servers:** `scripts/t4-remote/build-cli.sh` builds an archive from
  `origin/t4-code`, `scripts/t4-remote/install-service.sh <archive> <version> 3774` installs it
  and restarts the service. omarchy builds its own; the M1 gets an archive built on the M4. Exact
  commands are in t4-machines.md under "Updating the servers".
- **Pairing a phone or Mac:** `t3 auth pairing create --base-dir ~/.t4 ...` on the target host;
  see "Connecting clients".
- **Bringing T3 data into T4:** `t4-sync` (merge) or `t4-replace` (fresh snapshot), with the T4
  app or `t4code.service` stopped; new machine: `scripts/t4-remote/migrate-userdata.py`.

## Rules

- Never point a T4 server at `~/.t3`, and never run two servers on the same data home. Do not
  launch the T4 desktop app on omarchy while `t4code.service` runs.
- Never accept a client's "Update server" for a T4 server; redeploy instead.
- Run copies of `build-cli.sh` (from `/tmp`), never the file inside
  `~/.local/share/t4code-build/cli-src`, which the script resets.
- Installing or restarting a service interrupts running turns (they resume afterwards). Tell the
  user before restarting a server they may be working on.
- Edit `scripts/t4-remote/install-service.sh`, not the installed unit or plist.
- Prefer headless services; do not set up the desktop GUI as a server.
