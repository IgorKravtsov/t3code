#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Offline sync snapshots databases and atomically replaces only the stopped T4 data directory.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { copyStateDirectory, databaseCounts, exists } from "./lib/t4-state.ts";
import { mergeT4Databases, mergeT4Values } from "./lib/t4-merge.ts";
import { reencryptT4Credentials } from "./lib/t4-keyring.ts";

const repository = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const log = (value: string) => Effect.runSync(Effect.log(value));
const now = () => DateTime.formatIso(Effect.runSync(DateTime.now));
const args = process.argv.slice(2);
const options = {
  source: NodePath.join(NodeOS.homedir(), ".t3"),
  target: NodePath.join(NodeOS.homedir(), ".t4"),
  electron: "",
  dryRun: false,
  launch: false,
};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--help") {
    log(
      "node scripts/sync-t4-local.ts [--dry-run] [--launch] [--source-home PATH] [--target-home PATH] [--electron PATH]\nQuit T4 first. T3 may stay running. Merge new T3 records into T4, preserving T4 edits and creating a backup. Divergent chat histories abort the sync without replacing T4.",
    );
    process.exit(0);
  }
  if (arg === "--dry-run") options.dryRun = true;
  else if (arg === "--launch") options.launch = true;
  else if (["--source-home", "--target-home", "--electron"].includes(arg!)) {
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing path for ${arg}`);
    options[arg === "--source-home" ? "source" : arg === "--target-home" ? "target" : "electron"] =
      NodePath.resolve(value);
  } else throw new Error(`Unknown option: ${arg}`);
}
const source = await NodeFSP.realpath(options.source);
const target = await NodeFSP.realpath(options.target);
if (
  source === target ||
  source.startsWith(target + NodePath.sep) ||
  target.startsWith(source + NodePath.sep)
)
  throw new Error("T3 and T4 homes must be separate.");
const userdata = NodePath.join(target, "userdata");
async function requireStopped() {
  const runtime = NodePath.join(userdata, "server-runtime.json");
  if (!(await exists(runtime))) return;
  const { pid } = JSON.parse(await NodeFSP.readFile(runtime, "utf8")) as { pid: number };
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error("Invalid T4 runtime record; verify T4 is closed before syncing.");
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  throw new Error("T4 is running. Quit T4 Code completely, then retry. T3 can remain running.");
}
await requireStopped();
const lock = NodePath.join(target, ".sync-lock");
const backup = NodePath.join(
  target,
  "sync-backups",
  now().replaceAll(":", "-") + "-" + NodeCrypto.randomUUID().slice(0, 8),
);
const incoming = NodePath.join(backup, "t3-userdata");
const staged = NodePath.join(lock, "userdata");
const marker = NodePath.join(target, "last-sync.json");
const previous: { sourceSnapshot: string } | undefined = (await exists(marker))
  ? JSON.parse(await NodeFSP.readFile(marker, "utf8"))
  : undefined;
const baseline = previous?.sourceSnapshot ?? NodePath.join(target, "migration-source", "userdata");
const credentialFiles = new Set([
  "connection-catalog.json",
  "saved-environments.json",
  "clerk-tokens.json",
]);
const protectedFiles = new Set([
  "environment-id",
  "server-runtime.json",
  "server-signing-key.bin",
  "asset-access-signing-key.bin",
  "cloud-relay-environment-credential.bin",
  "cloud-link-ed25519-key-pair.bin",
]);

async function mergeFiles(relative = "") {
  for (const entry of await NodeFSP.readdir(NodePath.join(incoming, relative), {
    withFileTypes: true,
  })) {
    if (
      protectedFiles.has(entry.name) ||
      credentialFiles.has(entry.name) ||
      /\.sqlite(?:-wal|-shm)?$/.test(entry.name)
    )
      continue;
    const name = NodePath.join(relative, entry.name);
    const from = NodePath.join(incoming, name);
    const to = NodePath.join(staged, name);
    if (entry.isDirectory()) {
      await NodeFSP.mkdir(to, { recursive: true });
      await mergeFiles(name);
    } else if (entry.isFile()) {
      if (!(await exists(to))) await NodeFSP.copyFile(from, to);
      else if (entry.name.endsWith(".json")) {
        // Unrecognized JSON files may contain plain strings. Preserve T4 on a parse failure.
        let value: unknown;
        try {
          const original = NodePath.join(baseline, name);
          value = mergeT4Values(
            JSON.parse(await NodeFSP.readFile(from, "utf8")),
            JSON.parse(await NodeFSP.readFile(to, "utf8")),
            (await exists(original))
              ? JSON.parse(await NodeFSP.readFile(original, "utf8"))
              : undefined,
          );
        } catch {
          continue;
        }
        await NodeFSP.writeFile(to, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
      }
    }
  }
}

try {
  await NodeFSP.mkdir(lock, { mode: 0o700 });
} catch (error) {
  throw new Error(
    "Another sync is running or .sync-lock remains from an interrupted sync. Verify before removing it.",
    { cause: error },
  );
}
try {
  log(`Sync backup: ${backup}`);
  await copyStateDirectory(NodePath.join(source, "userdata"), incoming, {
    snapshotLockedDatabases: true,
  });
  await copyStateDirectory(userdata, NodePath.join(backup, "t4-userdata"));
  await copyStateDirectory(NodePath.join(backup, "t4-userdata"), staged);
  const results: Record<string, ReturnType<typeof mergeT4Databases>> = {};
  for (const name of ["statev2.sqlite", "state.sqlite"]) {
    if (!(await exists(NodePath.join(incoming, name)))) {
      if (name === "statev2.sqlite") throw new Error("T3 statev2.sqlite is missing.");
      continue;
    }
    if (!(await exists(NodePath.join(staged, name)))) {
      if (name === "statev2.sqlite")
        throw new Error("Initialize T4 with build-t4-local.ts before syncing.");
      await NodeFSP.copyFile(NodePath.join(incoming, name), NodePath.join(staged, name));
      continue;
    }
    const original = NodePath.join(baseline, name);
    results[name] = mergeT4Databases(
      NodePath.join(incoming, name),
      NodePath.join(staged, name),
      (await exists(original)) ? original : undefined,
    );
    databaseCounts(NodePath.join(staged, name));
  }
  await mergeFiles();
  const settingsPath = NodePath.join(staged, "settings.json");
  if (await exists(settingsPath)) {
    const settings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
    const existingPath = NodePath.join(userdata, "settings.json");
    const existing = (await exists(existingPath))
      ? JSON.parse(await NodeFSP.readFile(existingPath, "utf8"))
      : {};
    for (const [id, override] of Object.entries(settings.projectSettingsOverrides ?? {})) {
      if (
        !(id in (existing.projectSettingsOverrides ?? {})) &&
        typeof override === "object" &&
        override !== null
      )
        Object.assign(override, {
          continueThreadsAfterServerUpdate: false,
          worktreeCleanup: { mode: "off" },
        });
    }
    await NodeFSP.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  if (options.dryRun) {
    log(JSON.stringify({ dryRun: true, databases: results, backup }, null, 2));
  } else {
    const hasCredentials = (
      await Promise.all([...credentialFiles].map((name) => exists(NodePath.join(incoming, name))))
    ).some(Boolean);
    if (hasCredentials) {
      const executable =
        Effect.runSync(HostProcessPlatform) === "darwin"
          ? "Electron.app/Contents/MacOS/Electron"
          : "electron";
      const candidates = [
        NodePath.join(repository, "apps/desktop/node_modules/electron/dist", executable),
      ];
      const builds = NodePath.join(NodeOS.homedir(), ".local/share/t4code-build");
      if (await exists(builds))
        for (const name of (await NodeFSP.readdir(builds))
          .filter((name) => name.startsWith("source-"))
          .toReversed())
          candidates.push(
            NodePath.join(builds, name, "apps/desktop/node_modules/electron/dist", executable),
          );
      const electron =
        options.electron ||
        (
          await Promise.all(
            candidates.map(async (path) => ((await exists(path)) ? path : undefined)),
          )
        ).find(Boolean);
      if (!electron)
        throw new Error(
          "Electron migration helper is missing. Build T4 first or pass --electron PATH.",
        );
      await reencryptT4Credentials(incoming, staged, electron, lock, { merge: true, baseline });
    }
    await NodeFSP.rm(NodePath.join(staged, "server-runtime.json"), { force: true });
    await requireStopped();
    const nextMarker = NodePath.join(lock, "last-sync.json");
    await NodeFSP.writeFile(
      nextMarker,
      JSON.stringify({ sourceSnapshot: incoming, syncedAt: now(), databases: results }, null, 2) +
        "\n",
      { mode: 0o600 },
    );
    const retired = NodePath.join(lock, "previous-userdata");
    await NodeFSP.rename(userdata, retired);
    try {
      await NodeFSP.rename(staged, userdata);
      await NodeFSP.rename(nextMarker, marker);
    } catch (error) {
      if (await exists(userdata))
        await NodeFSP.rename(userdata, NodePath.join(lock, "failed-userdata"));
      await NodeFSP.rename(retired, userdata);
      throw error;
    }
    log(JSON.stringify({ merged: true, databases: results, backup }, null, 2));
    if (options.launch) {
      const child = NodeChildProcess.spawn(
        NodePath.join(NodeOS.homedir(), ".local/bin/t4-code"),
        [],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    }
  }
} finally {
  await NodeFSP.rm(lock, { force: true, recursive: true });
}
