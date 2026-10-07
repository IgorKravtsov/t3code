#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Local build orchestration uses native file copies and synchronous pipes to keep keyring plaintext off disk.
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import { copyStateDirectory, exists, migrateT4State } from "./lib/t4-state.ts";
import { reencryptT4Credentials } from "./lib/t4-keyring.ts";

const repository = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const home = NodeOS.homedir();
const hostPlatform = Effect.runSync(HostProcessPlatform);
const architecture = Effect.runSync(HostProcessArchitecture);
const platform = hostPlatform === "darwin" ? "mac" : hostPlatform === "linux" ? "linux" : undefined;
const args = new Set(process.argv.slice(2));
if (args.has("--help")) {
  Effect.runSync(
    Effect.log(
      "node scripts/build-t4-local.ts [--launch] [--no-migrate]\nBuild on Linux or macOS; copy local ~/.t3 on first installation only. Requires Node 24, pnpm and Rust. Existing T4 data is preserved.",
    ),
  );
  process.exit(0);
}
if (!platform || !["arm64", "x64"].includes(architecture))
  throw new Error("Build T4 on a Linux or macOS x64/arm64 machine.");
for (const arg of args)
  if (!["--launch", "--no-migrate"].includes(arg)) throw new Error(`Unknown option: ${arg}`);
const buildRoot = NodePath.join(home, ".local", "share", "t4code-build");
await NodeFSP.mkdir(buildRoot, { recursive: true, mode: 0o700 });
const worktree = await NodeFSP.mkdtemp(NodePath.join(buildRoot, "source-"));
const output = NodePath.join(worktree, "release-t4");
const temporary = NodePath.join(buildRoot, "tmp");
await NodeFSP.mkdir(temporary, { recursive: true, mode: 0o700 });
let rustToolchain: string | undefined;

async function run(command: string, arguments_: string[], cwd = worktree) {
  const environment: NodeJS.ProcessEnv = { ...process.env, CI: "true", TMPDIR: temporary };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (rustToolchain) environment.RUSTUP_TOOLCHAIN = rustToolchain;
  await new Promise<void>((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, arguments_, {
      cwd,
      stdio: "inherit",
      env: environment,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const rust = NodeChildProcess.spawnSync("rustc", ["--version"], { encoding: "utf8" });
const rustVersion = /^rustc (\d+)\.(\d+)\./.exec(rust.stdout ?? "");
if (rust.status !== 0 || !rustVersion)
  throw new Error("Install Rust 1.95 or newer (via rustup) before building T4 Code.");
if (Number(rustVersion[1]) === 1 && Number(rustVersion[2]) < 95) {
  // sysinfo in the resource monitor needs 1.95. Keep the user's default toolchain unchanged.
  await run("rustup", ["toolchain", "install", "1.95.0", "--profile", "minimal"], repository);
  rustToolchain = "1.95.0";
}
await run("git", ["worktree", "add", "--detach", worktree, "HEAD"], repository);
await run("git", ["apply", NodePath.join(repository, "scripts", "lib", "t4-branding.patch")]);
await run("pnpm", ["install", "--frozen-lockfile"]);
const sourceVersion = JSON.parse(
  await NodeFSP.readFile(NodePath.join(worktree, "apps/server/package.json"), "utf8"),
).version.split("-")[0];
const version = `${sourceVersion}-preview.${DateTime.formatIso(Effect.runSync(DateTime.now)).slice(0, 10).replaceAll("-", "")}.${Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000)}`;
await run("pnpm", [
  "exec",
  "node",
  "scripts/build-desktop-artifact.ts",
  "--platform",
  platform,
  "--target",
  "dir",
  "--arch",
  architecture,
  "--build-version",
  version,
  "--output-dir",
  output,
]);

const t4Home = NodePath.join(home, ".t4");
if (!args.has("--no-migrate")) {
  const result = await migrateT4State(NodePath.join(home, ".t3"), t4Home);
  Effect.runSync(
    Effect.log(
      result.migrated
        ? "Copied all T3 database tables and userdata; original snapshot retained in ~/.t4/migration-source."
        : "Existing T4 data preserved (or no local T3 data found).",
    ),
  );
  const marker = NodePath.join(t4Home, "migration-source", "desktop-migration-complete");
  if (
    (result.migrated ||
      (await exists(NodePath.join(t4Home, "migration-source", "manifest.json")))) &&
    !(await exists(marker))
  ) {
    await migrateProfileAndCredentials();
    await NodeFSP.writeFile(marker, "complete\n", { mode: 0o600 });
  }
}

async function migrateProfileAndCredentials() {
  const appData =
    platform === "mac"
      ? NodePath.join(home, "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || NodePath.join(home, ".config");
  const destination = NodePath.join(appData, "t4code-v1");
  for (const name of ["t3code-v2", "T3 Code (Alpha)", "t3code"]) {
    const source = NodePath.join(appData, name);
    if (!(await exists(source))) continue;
    const snapshot = NodePath.join(t4Home, "migration-source", "desktop-profile");
    const profileMarker = NodePath.join(t4Home, "migration-source", "desktop-profile-complete");
    if (!(await exists(profileMarker))) {
      await copyStateDirectory(source, snapshot, { snapshotLockedDatabases: true });
      await NodeFSP.writeFile(profileMarker, "complete\n", { mode: 0o600 });
    }
    if (!(await exists(destination))) {
      const staging = await NodeFSP.mkdtemp(destination + ".migrating-");
      try {
        await copyStateDirectory(snapshot, staging);
        await NodeFSP.rename(staging, destination);
      } finally {
        await NodeFSP.rm(staging, { force: true, recursive: true });
      }
    }
    Effect.runSync(Effect.log(`Copied local desktop profile from ${name}.`));
    break;
  }
  const electron = NodePath.join(
    worktree,
    "apps",
    "desktop",
    "node_modules",
    "electron",
    "dist",
    platform === "mac" ? "Electron.app/Contents/MacOS/Electron" : "electron",
  );
  await run("pnpm", ["--filter", "@t3tools/desktop", "run", "ensure:electron"]);
  await reencryptT4Credentials(
    NodePath.join(t4Home, "migration-source", "userdata"),
    NodePath.join(t4Home, "userdata"),
    electron,
    temporary,
  );
}

const install =
  platform === "mac"
    ? NodePath.join(home, "Applications", "T4 Code.app")
    : NodePath.join(home, ".local", "share", "t4code", "app");
await NodeFSP.mkdir(NodePath.dirname(install), { recursive: true });
const built =
  platform === "mac"
    ? NodePath.join(output, architecture === "arm64" ? "mac-arm64" : "mac", "T4 Code.app")
    : NodePath.join(output, "linux" + (architecture === "arm64" ? "-arm64" : "") + "-unpacked");
if (!(await exists(built))) throw new Error(`Missing built application: ${built}`);
if (await exists(install)) {
  const old = install + ".previous-" + Effect.runSync(Clock.currentTimeMillis);
  await NodeFSP.rename(install, old);
  Effect.runSync(
    Effect.log(
      `Previous application retained at ${old}. Quit the old T4 application before launching the rebuilt version.`,
    ),
  );
}
await NodeFSP.cp(built, install, { recursive: true });
const executable =
  platform === "mac"
    ? NodePath.join(install, "Contents", "MacOS", "T4 Code")
    : NodePath.join(install, "t4code");
const bin = NodePath.join(home, ".local", "bin");
await NodeFSP.mkdir(bin, { recursive: true });
const launcher = NodePath.join(bin, "t4-code");
await NodeFSP.writeFile(
  launcher,
  platform === "mac"
    ? `#!/bin/sh\nexec /usr/bin/open -a ${shellQuote(install)} --env ${shellQuote("T3CODE_HOME=" + t4Home)} --args "$@"\n`
    : `#!/bin/sh\nexport T3CODE_HOME=${shellQuote(t4Home)}\nunset ELECTRON_RUN_AS_NODE\nexec ${shellQuote(executable)} "$@"\n`,
  { mode: 0o755 },
);
if (platform === "linux") {
  await NodeFSP.copyFile(
    NodePath.join(worktree, "apps", "desktop", "resources", "icon.png"),
    NodePath.join(home, ".local", "share", "t4code", "icon.png"),
  );
  const applications = NodePath.join(home, ".local", "share", "applications");
  await NodeFSP.mkdir(applications, { recursive: true });
  const desktopQuote = (value: string) =>
    '"' +
    value
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("`", "\\`")
      .replaceAll("$", "\\$") +
    '"';
  await NodeFSP.writeFile(
    NodePath.join(applications, "t4-code.desktop"),
    `[Desktop Entry]\nType=Application\nName=T4 Code\nComment=Local T4 Code build with a separate data profile\nExec=${desktopQuote(launcher)} %U\nIcon=${NodePath.join(home, ".local", "share", "t4code", "icon.png")}\nTerminal=false\nCategories=Development;\nStartupWMClass=t4code\n`,
  );
}
Effect.runSync(
  Effect.log(`Installed ${NodePath.basename(install)}. Run ${launcher}. Source build: ${worktree}`),
);
if (args.has("--launch")) {
  const child = NodeChildProcess.spawn(launcher, [], { detached: true, stdio: "ignore" });
  child.unref();
}
