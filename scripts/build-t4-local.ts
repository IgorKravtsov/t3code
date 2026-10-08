#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Local build orchestration uses native file copies and synchronous pipes to keep keyring plaintext off disk.
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
const argv = process.argv.slice(2);
const waitPidIndex = argv.indexOf("--wait-pid");
const waitPid = waitPidIndex === -1 ? undefined : Number(argv.splice(waitPidIndex, 2)[1]);
const args = new Set(argv);
if (args.has("--help")) {
  Effect.runSync(
    Effect.log(
      "node scripts/build-t4-local.ts [--launch] [--no-migrate]\nBuild on Linux or macOS; copy local ~/.t3 on first installation only. Requires Node 24, pnpm and Rust. Existing T4 data is preserved.\nThe T4 app's upstream updater runs it with --in-place (build inside this dedicated worktree), --prepare-only, and --install-prepared --wait-pid <pid> (install after the app exits).",
    ),
  );
  process.exit(0);
}
if (
  (hostPlatform !== "darwin" && hostPlatform !== "linux") ||
  !["arm64", "x64"].includes(architecture)
)
  throw new Error("Build T4 on a Linux or macOS x64/arm64 machine.");
const platform = hostPlatform === "darwin" ? "mac" : "linux";
for (const arg of args)
  if (
    !["--launch", "--no-migrate", "--in-place", "--prepare-only", "--install-prepared"].includes(
      arg,
    )
  )
    throw new Error(`Unknown option: ${arg}`);
if (waitPid !== undefined && !Number.isInteger(waitPid)) throw new Error("--wait-pid needs a PID.");
const buildRoot = NodePath.join(home, ".local", "share", "t4code-build");
await NodeFSP.mkdir(buildRoot, { recursive: true, mode: 0o700 });
// --in-place modifies this checkout, so only the updater's dedicated worktrees use it.
const worktree = args.has("--in-place")
  ? repository.replace(/\/$/, "")
  : await NodeFSP.mkdtemp(NodePath.join(buildRoot, "source-"));
const output = NodePath.join(worktree, "release-t4");
const temporary = NodePath.join(buildRoot, "tmp");
const t4Home = NodePath.join(home, ".t4");
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
const gitOutput = (arguments_: string[]) =>
  NodeChildProcess.execFileSync("git", ["-C", worktree, ...arguments_], {
    encoding: "utf8",
  }).trim();
if (!args.has("--install-prepared")) await build();

async function build() {
  const rust = NodeChildProcess.spawnSync("rustc", ["--version"], { encoding: "utf8" });
  const rustVersion = /^rustc (\d+)\.(\d+)\./.exec(rust.stdout ?? "");
  if (rust.status !== 0 || !rustVersion)
    throw new Error("Install Rust 1.95 or newer (via rustup) before building T4 Code.");
  if (Number(rustVersion[1]) === 1 && Number(rustVersion[2]) < 95) {
    // sysinfo in the resource monitor needs 1.95. Keep the user's default toolchain unchanged.
    await run("rustup", ["toolchain", "install", "1.95.0", "--profile", "minimal"], repository);
    rustToolchain = "1.95.0";
  }
  if (!args.has("--in-place"))
    await run("git", ["worktree", "add", "--detach", worktree, "HEAD"], repository);
  await run("git", ["apply", NodePath.join(repository, "scripts", "lib", "t4-branding.patch")]);
  await run("pnpm", ["install", "--frozen-lockfile"]);
  await run("node", ["scripts/brand-t4.mjs", worktree]);
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
// Copying the bundle takes tens of seconds, so it happens while the old app still runs.
// After it exits, installing is two renames and the new app launches right away.
const staged = install + ".next";
if (!args.has("--install-prepared") || !(await exists(staged))) {
  const built =
    platform === "mac"
      ? NodePath.join(output, architecture === "arm64" ? "mac-arm64" : "mac", "T4 Code.app")
      : NodePath.join(output, "linux" + (architecture === "arm64" ? "-arm64" : "") + "-unpacked");
  if (!(await exists(built))) throw new Error(`Missing built application: ${built}`);
  await NodeFSP.rm(staged, { recursive: true, force: true });
  await NodeFSP.cp(built, staged, { recursive: true, verbatimSymlinks: true });
}
// Daily updates would otherwise accumulate full application copies; keep only the last one.
for (const entry of await NodeFSP.readdir(NodePath.dirname(install)))
  if (entry.startsWith(NodePath.basename(install) + ".previous-"))
    await NodeFSP.rm(NodePath.join(NodePath.dirname(install), entry), {
      recursive: true,
      force: true,
    });
if (args.has("--prepare-only")) {
  Effect.runSync(Effect.log(`Prepared T4 build in ${staged}.`));
  process.exit(0);
}

if (waitPid !== undefined) {
  // The updater spawns this before quitting; replace the app only after it has exited.
  const running = () => {
    try {
      process.kill(waitPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (running()) await new Promise((resolve) => setTimeout(resolve, 500));
}

if (await exists(install)) {
  const old = install + ".previous-" + Effect.runSync(Clock.currentTimeMillis);
  await NodeFSP.rename(install, old);
  Effect.runSync(
    Effect.log(
      `Previous application retained at ${old}. Quit the old T4 application before launching the rebuilt version.`,
    ),
  );
}
await NodeFSP.rename(staged, install);
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
    ? `#!/bin/sh\nunset T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT\nexec /usr/bin/open -a ${shellQuote(install)} --env ${shellQuote("T3CODE_HOME=" + t4Home)} --args "$@"\n`
    : `#!/bin/sh\nexport T3CODE_HOME=${shellQuote(t4Home)}\nunset ELECTRON_RUN_AS_NODE T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT\nexec ${shellQuote(executable)} "$@"\n`,
  { mode: 0o755 },
);
for (const [command, script] of [
  ["t4-sync", "sync-t4-local.ts"],
  ["t4-replace", "replace-t4-local.ts"],
])
  await NodeFSP.writeFile(
    NodePath.join(bin, command!),
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(NodePath.join(worktree, "scripts", script!))} "$@"\n`,
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
// Read by the app's upstream updater (apps/desktop/src/t4/T4UpstreamSync.ts).
await NodeFSP.mkdir(t4Home, { recursive: true, mode: 0o700 });
await NodeFSP.writeFile(
  NodePath.join(t4Home, "t4-source.json"),
  JSON.stringify(
    {
      repository: NodePath.dirname(
        NodePath.resolve(worktree, gitOutput(["rev-parse", "--git-common-dir"])),
      ),
      branch: "t4-code",
      builtCommit: gitOutput(["rev-parse", "HEAD"]),
      buildRoot,
      node: process.execPath,
      path: process.env.PATH ?? "",
    },
    null,
    2,
  ) + "\n",
  { mode: 0o600 },
);
// Launch before this slow cleanup, which removes multi-GB source worktrees.
if (args.has("--launch")) {
  const child = NodeChildProcess.spawn(launcher, [], { detached: true, stdio: "ignore" });
  child.unref();
}
// Each source worktree holds a full install (several GB). The launchers now use this one.
for (const entry of gitOutput(["worktree", "list", "--porcelain"]).split("\n")) {
  const path = entry.startsWith("worktree ") ? entry.slice("worktree ".length) : undefined;
  if (path && path !== worktree && path.startsWith(NodePath.join(buildRoot, "source-")))
    await run("git", ["worktree", "remove", "--force", path]).catch((error) =>
      Effect.runSync(Effect.logWarning(`Could not remove old source ${path}: ${error}`)),
    );
}
Effect.runSync(
  Effect.log(`Installed ${NodePath.basename(install)}. Run ${launcher}. Source build: ${worktree}`),
);
