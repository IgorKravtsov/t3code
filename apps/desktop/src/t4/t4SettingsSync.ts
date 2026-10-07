// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Fork-only startup step; plain JSON files are merged before any Effect service reads them.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Three-way merge: a value edited in T4 wins; untouched values receive updates from T3.
 * Mirrors mergeT4Values in scripts/lib/t4-merge.ts, which offline transfers use. */
export function mergeT4Values(source: unknown, target: unknown, baseline: unknown): unknown {
  if (equal(target, baseline) || target === undefined) return source;
  if (Array.isArray(source) && Array.isArray(target)) {
    const key = (value: unknown) =>
      object(value)
        ? ["id", "connectionId", "environmentId"]
            .map((name) => value[name])
            .find((value) => typeof value === "string")
        : undefined;
    if ([...source, ...target].every((value) => key(value) !== undefined)) {
      const incoming = new Map(source.map((value) => [key(value), value]));
      const current = new Map(target.map((value) => [key(value), value]));
      const original = new Map(
        (Array.isArray(baseline) ? baseline : []).map((value) => [key(value), value]),
      );
      return [...new Set([...current.keys(), ...incoming.keys()])]
        .map((id) => mergeT4Values(incoming.get(id), current.get(id), original.get(id)))
        .filter((value) => value !== undefined);
    }
  }
  if (object(source) && object(target)) {
    const original = object(baseline) ? baseline : {};
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(source), ...Object.keys(target)])) {
      const value = mergeT4Values(source[key], target[key], original[key]);
      if (value !== undefined) result[key] = value;
    }
    return result;
  }
  return target;
}

const SETTINGS_FILES = [
  "settings.json",
  "client-settings.json",
  "desktop-settings.json",
  "keybindings.json",
];

const readJson = (path: string): unknown =>
  NodeFS.existsSync(path) ? JSON.parse(NodeFS.readFileSync(path, "utf8")) : undefined;

/** Where the previous T3 values came from: the last sync, else the first migration. */
function initialBaseline(t4Home: string): string {
  try {
    const lastSync = readJson(NodePath.join(t4Home, "last-sync.json"));
    if (object(lastSync) && typeof lastSync.sourceSnapshot === "string")
      return lastSync.sourceSnapshot;
  } catch {}
  return NodePath.join(t4Home, "migration-source", "userdata");
}

/**
 * Applies settings changed in T3 since the previous snapshot to an installed T4 build, keeping
 * values edited in T4. Runs at startup before the server and window read them. Inert in T3 and
 * development builds, which have no t4-source.json.
 */
export function syncT3SettingsIntoT4(
  t4Home: string,
  t3Userdata = NodePath.join(NodeOS.homedir(), ".t3", "userdata"),
): ReadonlyArray<string> {
  if (!NodeFS.existsSync(NodePath.join(t4Home, "t4-source.json"))) return [];
  const t4Userdata = NodePath.join(t4Home, "userdata");
  const baselineDirectory = NodePath.join(t4Home, "t3-settings-baseline");
  const legacyBaseline = initialBaseline(t4Home);
  NodeFS.mkdirSync(baselineDirectory, { recursive: true, mode: 0o700 });
  const changed: string[] = [];
  for (const name of SETTINGS_FILES) {
    try {
      const source = readJson(NodePath.join(t3Userdata, name));
      if (source === undefined) continue;
      const targetPath = NodePath.join(t4Userdata, name);
      const baselinePath = NodePath.join(baselineDirectory, name);
      const target = readJson(targetPath);
      const baseline = NodeFS.existsSync(baselinePath)
        ? readJson(baselinePath)
        : readJson(NodePath.join(legacyBaseline, name));
      const merged = mergeT4Values(source, target, baseline);
      // Both apps would otherwise resume the same threads in shared worktrees.
      if (name === "settings.json" && object(merged)) {
        // The global Storage screen edits storageCleanup only, so a global worktreeCleanup here
        // is left over from early migrations that forced it off. It always follows T3.
        if (object(source) && "worktreeCleanup" in source)
          merged.worktreeCleanup = source.worktreeCleanup;
        else delete merged.worktreeCleanup;
        merged.continueThreadsAfterServerUpdate = false;
        merged.autoResumeLimitedThreads = false;
        for (const override of Object.values(
          object(merged.projectSettingsOverrides) ? merged.projectSettingsOverrides : {},
        ))
          if (object(override)) override.continueThreadsAfterServerUpdate = false;
      }
      if (!equal(merged, target)) {
        NodeFS.writeFileSync(targetPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
        changed.push(name);
      }
      NodeFS.writeFileSync(baselinePath, JSON.stringify(source, null, 2) + "\n", { mode: 0o600 });
    } catch {
      // A file T3 is rewriting right now is picked up on the next start.
    }
  }
  return changed;
}
