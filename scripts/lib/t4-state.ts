// @effect-diagnostics nodeBuiltinImport:off - SQLite backup requires native file handles while reading live databases without opening them writable.
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";

export async function exists(path: string) {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Copy database contents through SQLite, including committed WAL frames. Never open the source writable. */
export async function copyStateDirectory(
  source: string,
  destination: string,
  options: { skipNames?: ReadonlySet<string>; snapshotLockedDatabases?: boolean } = {},
) {
  await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await NodeFSP.readdir(source, { withFileTypes: true })) {
    if (options.skipNames?.has(entry.name)) continue;
    if (/(-wal|-shm|-journal)$/.test(entry.name) || /^(Singleton|LOCK$)/.test(entry.name)) continue;
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      // Chromium's process locks are symlinks. Other symlinks could lead back to live state.
      if (!entry.name.startsWith("Singleton"))
        throw new Error(`Refusing to copy state symlink: ${from}`);
      continue;
    }
    if (entry.isDirectory()) await copyStateDirectory(from, to, options);
    else if (entry.isFile()) {
      const handle = await NodeFSP.open(from, "r");
      const header = Buffer.alloc(16);
      try {
        await handle.read(header, 0, 16, 0);
      } finally {
        await handle.close();
      }
      if (header.toString() === "SQLite format 3\0") {
        const database = new NodeSqlite.DatabaseSync(from, { readOnly: true });
        try {
          await NodeSqlite.backup(database, to);
        } catch (cause) {
          if (!options.snapshotLockedDatabases)
            throw new Error(`Could not snapshot SQLite database: ${from}`, { cause });
          await snapshotLockedDatabase(from, to);
        } finally {
          database.close();
        }
      } else await NodeFSP.copyFile(from, to);
    }
  }
}

/** Chromium holds some databases exclusively. Clone stable DB/journal files, then let SQLite
 * recover and validate that private copy. The live source is never opened writable or unlocked. */
async function snapshotLockedDatabase(source: string, destination: string) {
  const directory = await NodeFSP.mkdtemp(destination + ".snapshot-");
  const copy = NodePath.join(directory, "source.sqlite");
  const version = async (path: string) => {
    try {
      const stat = await NodeFSP.stat(path, { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const suffixes = ["", "-wal", "-journal"];
      const before = await Promise.all(suffixes.map((suffix) => version(source + suffix)));
      try {
        for (const [index, suffix] of suffixes.entries()) {
          if (before[index] !== null) await NodeFSP.copyFile(source + suffix, copy + suffix);
          else await NodeFSP.rm(copy + suffix, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const after = await Promise.all(suffixes.map((suffix) => version(source + suffix)));
      if (before.some((value, index) => value !== after[index])) continue;
      // Writable only on the private clone, so SQLite can recover a hot rollback journal.
      const database = new NodeSqlite.DatabaseSync(copy);
      try {
        if (database.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
          throw new Error(`Copied Chromium database failed integrity validation: ${source}`);
        await NodeSqlite.backup(database, destination);
        return;
      } finally {
        database.close();
      }
    }
    throw new Error(
      `Chromium database kept changing during profile copy: ${source}. Retry migration when the browser is idle.`,
    );
  } finally {
    await NodeFSP.rm(directory, { force: true, recursive: true });
  }
}

export function databaseCounts(path: string) {
  const database = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").get();
    if (integrity?.integrity_check !== "ok")
      throw new Error(`Database integrity check failed: ${path}`);
    const counts: Record<string, number> = {};
    for (const row of database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) {
      const name = String(row.name);
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      counts[name] = Number(
        database.prepare(`SELECT count(*) AS count FROM ${quoted}`).get()?.count,
      );
    }
    return counts;
  } finally {
    database.close();
  }
}

export async function prepareIndependentCopy(userdata: string) {
  const settingsPath = NodePath.join(userdata, "settings.json");
  const settings = (await exists(settingsPath))
    ? JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"))
    : {};
  // Both apps would otherwise resume the same threads. Worktree cleanup stays as configured
  // in T3: it keeps worktrees with local changes, and branches and history survive it.
  settings.continueThreadsAfterServerUpdate = false;
  settings.autoResumeLimitedThreads = false;
  for (const override of Object.values(settings.projectSettingsOverrides ?? {})) {
    if (typeof override === "object" && override !== null)
      Object.assign(override, { continueThreadsAfterServerUpdate: false });
  }
  await NodeFSP.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await NodeFSP.writeFile(
    NodePath.join(userdata, "environment-id"),
    NodeCrypto.randomUUID() + "\n",
    { mode: 0o600 },
  );
  await NodeFSP.rm(NodePath.join(userdata, "server-runtime.json"), { force: true });
  // Host credentials identify one running environment. Client connection credentials remain copied.
  for (const secret of [
    "cloud-relay-environment-credential",
    "cloud-link-ed25519-key-pair",
    "server-signing-key",
    "asset-access-signing-key",
  ]) {
    await NodeFSP.rm(NodePath.join(userdata, "secrets", secret + ".bin"), { force: true });
  }
  for (const name of ["state.sqlite", "statev2.sqlite"]) {
    const path = NodePath.join(userdata, name);
    if (!(await exists(path))) continue;
    const database = new NodeSqlite.DatabaseSync(path);
    try {
      const tables = new Set(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      if (tables.has("scheduled_tasks")) database.exec("UPDATE scheduled_tasks SET enabled = 0");
      for (const table of ["orchestration_v2_effect_outbox", "orchestration_effect_outbox"]) {
        if (tables.has(table))
          database.exec(
            `UPDATE ${table} SET status = 'cancelled' WHERE status IN ('pending', 'running')`,
          );
      }
    } finally {
      database.close();
    }
  }
}

/** First installation only. Keep an untouched full snapshot, then prepare a separate active copy. */
export async function migrateT4State(sourceHome: string, destinationHome: string) {
  const source = NodePath.resolve(sourceHome);
  const destination = NodePath.resolve(destinationHome);
  if (
    source === destination ||
    destination.startsWith(source + "/") ||
    source.startsWith(destination + "/")
  ) {
    throw new Error("T3 and T4 data directories must be separate.");
  }
  if (await exists(destination)) return { migrated: false } as const;
  if (!(await exists(NodePath.join(source, "userdata")))) return { migrated: false } as const;
  const staging = destination + ".migrating-" + NodeCrypto.randomUUID();
  try {
    const snapshot = NodePath.join(staging, "migration-source", "userdata");
    await copyStateDirectory(NodePath.join(source, "userdata"), snapshot);
    const counts: Record<string, Record<string, number>> = {};
    for (const name of ["state.sqlite", "statev2.sqlite"]) {
      if (await exists(NodePath.join(snapshot, name)))
        counts[name] = databaseCounts(NodePath.join(snapshot, name));
    }
    const userdata = NodePath.join(staging, "userdata");
    await copyStateDirectory(snapshot, userdata);
    await prepareIndependentCopy(userdata);
    await NodeFSP.writeFile(
      NodePath.join(staging, "migration-source", "manifest.json"),
      JSON.stringify(
        {
          sourceHome: source,
          copiedAt: DateTime.formatIso(Effect.runSync(DateTime.now)),
          databaseCounts: counts,
          independentEnvironment: true,
          schedulesDisabled: true,
          automaticResumeDisabled: true,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await NodeFSP.rename(staging, destination);
    return { migrated: true, counts } as const;
  } catch (error) {
    await NodeFSP.rm(staging, { force: true, recursive: true });
    throw error;
  }
}
