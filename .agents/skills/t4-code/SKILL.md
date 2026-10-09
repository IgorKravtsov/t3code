---
name: t4-code
description: Build, install, deploy and operate T4 Code, the `t4-code` fork of T3 Code on Ihor's machines. Use for building the local T4 desktop app, merging upstream T3 into t4-code, updating every T4 machine (the M4 app, omarchy and the M1) with scripts/t4-remote/deploy-all.sh, checking or restarting them, pairing clients, syncing T3 data into T4, and diagnosing a T4 install. Also use when asked which machines run T4, which ports or URLs they use, or how to use T4 alongside T3.
---

# T4 Code

T4 is the `t4-code` branch of this repository (`origin` = `IgorKravtsov/t3code`), installed
beside stock T3 on every machine. The source checkout is `~/usr/projects/t3code` on the
MacBook M4.

The docs are the source of truth. Read the section you need before acting, and update them when
the setup changes:

- [docs/operations/t4-machines.md](../../../docs/operations/t4-machines.md): what runs where,
  status/logs/restart, staying up, GitHub accounts on omarchy, pairing clients, **updating T4**
  (merge upstream, then `deploy-all.sh`), data migration, troubleshooting.
- [docs/operations/release.md#separate-local-t4-code-build](../../../docs/operations/release.md#separate-local-t4-code-build):
  building the local desktop app, the in-app upstream updater (**Merge & rebuild** /
  **Rebuild**), `t4-sync` and `t4-replace`.
- [docs/operations/t4-differences.md](../../../docs/operations/t4-differences.md): what the
  fork changes compared with stock T3, and what a merge with upstream has to carry.

## Map

| Machine                | ssh          | T4 runs as                                                   | Tailnet URL                                     |
| ---------------------- | ------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| MacBook M4 (client)    | local        | `~/Applications/T4 Code.app`, own server on `:3774`          | `https://ihors-macbook-air.taild33710.ts.net`   |
| omarchy (Linux x64)    | `omarchy`    | systemd user unit `t4code.service` on `127.0.0.1:3774`       | `https://omarchy.taild33710.ts.net:8444`        |
| MacBook M1 (macOS arm) | `mac-m1-pro` | LaunchAgent `com.t4tools.t4code.service` on `127.0.0.1:3774` | `https://macbook-pro-m1.taild33710.ts.net:8443` |

T3 keeps `~/.t3` and port 3773 (omarchy `:8443`, M1 `:443`). Long-running work belongs on
omarchy or the M1; the M4 environment stops when its app quits or the Mac sleeps.

## Which task, which tool

- **Update T4 (upstream T3 changed, or new commits on `t4-code`):** two steps, both on the M4 in
  `~/usr/projects/t3code`. 1) Merge `upstream/main` into `t4-code` and push: **Merge & rebuild**
  in the T4 app, or by hand when it conflicts (keep both sides; see t4-differences.md). 2) `scripts/t4-remote/deploy-all.sh --dry-run`, then without `--dry-run`. It updates all three
  machines: the M4 app (`m4`), `omarchy` and `mac-m1-pro`. It stops if the merge broke a T4
  test that passes upstream, skips machines that are current or running a turn, and rolls back a
  server that does not come up as T4. Full description: t4-machines.md, "Updating T4".
- **Check what a machine runs:** m4 `~/.t4/t4-source.json` (`builtCommit`); servers
  `~/.t4/runtime/t4-commit` and `curl -fsS <tailnet URL>/.well-known/t3/environment`
  (`serverVersion`). `deploy-all.sh --dry-run --skip-tests` prints all three.
- **Local desktop app, first install:** `node scripts/build-t4-local.ts --launch` (Node 24,
  pnpm, Rust); see release.md.
- **Pairing a phone or Mac:** `t3 auth pairing create --base-dir ~/.t4 ...` on the target host;
  see "Connecting clients".
- **Bringing T3 data into T4:** `t4-sync` (merge) or `t4-replace` (fresh snapshot), with the T4
  app or `t4code.service` stopped; new machine: `scripts/t4-remote/migrate-userdata.py`.

## Rules

- Never point a T4 server at `~/.t3`, and never run two servers on the same data home. Do not
  launch the T4 desktop app on omarchy while `t4code.service` runs.
- Never accept a client's "Update server" for a T4 server, whichever client (T3 or T4) offers
  it. The button downloads a stock T3 release from GitHub, so it would replace the fork; the
  services set `T3CODE_RELEASE_BASE_URL=https://t4-updates.invalid` so it fails instead. Update
  T4 servers by redeploying. On the stock T3 servers (`~/.t3`) the button works as usual, so
  check which server a prompt is about.
- Run copies of `build-cli.sh` (`deploy-all.sh` copies it to the host), never the file inside
  `~/.local/share/t4code-build/cli-src`, which the build resets.
- Installing or restarting a service interrupts running turns (they resume afterwards). Tell the
  user before restarting a server they may be working on.
- You may be running inside T4 on the M4. Building the M4 app is safe; the new build applies when
  T4 restarts. Never quit or relaunch T4 yourself (no `--launch`), since that ends your own
  session; ask the user to restart it.
- A guard failure means lost T4 behaviour: fix it, do not bypass it with `--skip-tests`. When
  adding a T4 feature, give it a test in a file the fork changes, so the guard covers it.
- Agent sessions in T3/T4 export `ELECTRON_RUN_AS_NODE=1`; unset it before running tests or
  builds by hand (`env -u ELECTRON_RUN_AS_NODE ...`).
- Edit `scripts/t4-remote/install-service.sh`, not the installed unit or plist.
- Prefer headless services; do not set up the desktop GUI as a server.
