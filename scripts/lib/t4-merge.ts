// @effect-diagnostics nodeBuiltinImport:off - Offline database merging operates on private SQLite snapshots, never the live T3 database.
import * as NodeSqlite from "node:sqlite";

type Row = Record<string, NodeSqlite.SQLOutputValue>;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Three-way merge: a value edited in T4 wins; untouched values receive updates from T3. */
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

const passiveEvents = new Set([
  "thread.visited",
  "thread.marked-unread",
  "thread.pull-request-synced",
]);
// A migrated environment stops sessions owned by the original server on startup.
// Those recovery events are not independent user edits to the conversation.
const passive = (row: Row) =>
  passiveEvents.has(String(row.event_type)) ||
  (row.actor_kind === "server" &&
    String(row.command_id).startsWith("command:runtime-reconcile:startup:"));
const ignoredTables = new Set([
  "effect_sql_migrations",
  "sqlite_sequence",
  "auth_sessions",
  "auth_pairing_links",
  "projection_state",
  "orchestration_v2_projection_metadata",
]);

/** Import a compatible snapshot. Divergent domain streams require an explicit resolution;
 * mixing their run ordinals or command versions would corrupt continuation and replay. */
export function mergeT4Databases(sourcePath: string, targetPath: string, baselinePath?: string) {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  const target = new NodeSqlite.DatabaseSync(targetPath);
  const baseline = baselinePath
    ? new NodeSqlite.DatabaseSync(baselinePath, { readOnly: true })
    : undefined;
  const tables = (db: NodeSqlite.DatabaseSync) =>
    new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name)),
    );
  const rows = (db: NodeSqlite.DatabaseSync, table: string) =>
    db.prepare(`SELECT * FROM ${quote(table)}`).all();
  const columns = (db: NodeSqlite.DatabaseSync, table: string) =>
    db.prepare(`PRAGMA table_info(${quote(table)})`).all();
  const sourceTables = tables(source);
  const targetTables = tables(target);
  const baselineTables = baseline ? tables(baseline) : new Set<string>();
  const originals = (table: string) =>
    baseline && baselineTables.has(table) ? rows(baseline, table) : [];
  const streamKey = (row: Row) => JSON.stringify([row.aggregate_kind, row.stream_id]);
  let importedEvents = 0;
  let importedRows = 0;
  const acceptedThreads = new Set<string>();
  const acceptedProjects = new Set<string>();
  const sequenceMap = new Map<number, number>();
  const legacySequenceMap = new Map<number, number>();
  try {
    for (const table of sourceTables) {
      if (ignoredTables.has(table)) continue;
      if (!targetTables.has(table) || !equal(columns(source, table), columns(target, table)))
        throw new Error(
          `Database schemas differ at ${table}. Update T4 to a compatible version before syncing.`,
        );
    }
    if (!sourceTables.has("orchestration_events")) throw new Error("Missing T3 event store.");
    const incoming = rows(source, "orchestration_events");
    const current = rows(target, "orchestration_events");
    const sourceIds = new Set(incoming.map((row) => row.event_id));
    const targetIds = new Set(current.map((row) => row.event_id));
    const originalIds = new Set(originals("orchestration_events").map((row) => row.event_id));
    const sourceChanged = new Set(
      incoming.filter((row) => !targetIds.has(row.event_id) && !passive(row)).map(streamKey),
    );
    const targetChanged = new Set(
      current
        .filter(
          (row) => !sourceIds.has(row.event_id) && !originalIds.has(row.event_id) && !passive(row),
        )
        .map(streamKey),
    );
    const conflicts = [...sourceChanged].filter((key) => targetChanged.has(key));
    if (conflicts.length)
      throw new Error(
        `T3 and T4 independently changed the same histories: ${conflicts.join(", ")}. No data was merged. Both snapshots are preserved in the sync backup.`,
      );
    const accepted = new Set(
      incoming
        .filter((row) => !targetIds.has(row.event_id) && !targetChanged.has(streamKey(row)))
        .map(streamKey),
    );
    for (const row of incoming) {
      if (!accepted.has(streamKey(row))) continue;
      if (row.aggregate_kind === "thread") acceptedThreads.add(String(row.stream_id));
      if (row.aggregate_kind === "project") acceptedProjects.add(String(row.stream_id));
    }
    target.exec("BEGIN IMMEDIATE");
    const appendEvents = (table: string, mapping: Map<number, number>) => {
      if (!sourceTables.has(table)) return;
      const existing = new Map(
        rows(target, table).map((row) => [row.event_id, Number(row.sequence)]),
      );
      const names = columns(source, table)
        .map((row) => String(row.name))
        .filter((name) => name !== "sequence");
      const insert = target.prepare(
        `INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      );
      const versions = new Map<string, number>();
      for (const row of rows(target, table))
        if (row.stream_version !== undefined)
          versions.set(
            streamKey(row),
            Math.max(versions.get(streamKey(row)) ?? -1, Number(row.stream_version)),
          );
      for (const original of rows(source, table).sort(
        (a, b) => Number(a.sequence) - Number(b.sequence),
      )) {
        const found = existing.get(original.event_id);
        if (found !== undefined) {
          mapping.set(Number(original.sequence), found);
          continue;
        }
        if (
          table === "orchestration_events"
            ? !accepted.has(streamKey(original))
            : !acceptedThreads.has(String(original.thread_id))
        )
          continue;
        const row = { ...original };
        if (row.stream_version !== undefined) {
          const version = (versions.get(streamKey(row)) ?? -1) + 1;
          row.stream_version = version;
          versions.set(streamKey(row), version);
        }
        const result = insert.run(...names.map((name) => row[name]!));
        mapping.set(Number(original.sequence), Number(result.lastInsertRowid));
        importedEvents++;
      }
    };
    appendEvents("orchestration_events", sequenceMap);
    appendEvents("orchestration_v2_events", legacySequenceMap);
    for (const table of sourceTables) {
      if (
        ignoredTables.has(table) ||
        table === "orchestration_events" ||
        table === "orchestration_v2_events"
      )
        continue;
      const info = columns(source, table);
      let keys = info
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => String(column.name));
      if (table === "projection_turns") keys = ["thread_id", "turn_id", "checkpoint_turn_count"];
      if (table === "checkpoint_diff_blobs")
        keys = ["thread_id", "from_turn_count", "to_turn_count"];
      if (!keys.length) throw new Error(`Cannot safely merge ${table}: no stable record key.`);
      const key = (row: Row) => JSON.stringify(keys.map((name) => row[name]));
      const originalRows = new Map(originals(table).map((row) => [key(row), row]));
      const targetRows = new Map(rows(target, table).map((row) => [key(row), row]));
      const incomingRows = rows(source, table);
      const incomingKeys = new Set(incomingRows.map(key));
      const owned = (row: Row) => {
        const ids = [row.thread_id, row.source_thread_id, row.target_thread_id].filter(
          (value) => value !== undefined && value !== null,
        );
        if (ids.length) return ids.some((id) => acceptedThreads.has(String(id)));
        if (table === "projection_projects") return acceptedProjects.has(String(row.project_id));
        if (table === "orchestration_command_receipts")
          return (row.aggregate_kind === "thread" ? acceptedThreads : acceptedProjects).has(
            String(row.aggregate_id),
          );
        return true;
      };
      const names = info
        .map((column) => String(column.name))
        .filter((name) => !(table === "projection_turns" && name === "row_id"));
      const insert = target.prepare(
        `INSERT INTO ${quote(table)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      );
      const where = keys.map((name) => `${quote(name)} IS ?`).join(" AND ");
      const update = target.prepare(
        `UPDATE ${quote(table)} SET ${names.map((name) => `${quote(name)}=?`).join(",")} WHERE ${where}`,
      );
      const remove = target.prepare(`DELETE FROM ${quote(table)} WHERE ${where}`);
      for (const row of incomingRows) {
        if (!owned(row)) continue;
        const found = targetRows.get(key(row));
        const original = originalRows.get(key(row));
        const merged: Row = {};
        for (const name of names) {
          const read = (record: Row | undefined) => {
            const value = record?.[name];
            return name.endsWith("_json") && typeof value === "string"
              ? (JSON.parse(value) as unknown)
              : value;
          };
          const value = mergeT4Values(read(row), read(found), read(original));
          merged[name] =
            name.endsWith("_json") && value !== undefined
              ? JSON.stringify(value)
              : (value as NodeSqlite.SQLOutputValue);
          if (["sequence", "result_sequence"].includes(name) && typeof row[name] === "number") {
            const mapping =
              table === "orchestration_v2_command_receipts" ? legacySequenceMap : sequenceMap;
            merged[name] = mapping.get(Number(row[name])) ?? merged[name]!;
          }
        }
        // Import records, never work waiting to execute on the other server.
        if (!found && table === "scheduled_tasks") merged.enabled = 0;
        if (
          table.endsWith("effect_outbox") &&
          ["pending", "running"].includes(String(merged.status))
        )
          merged.status = "cancelled";
        if (found)
          update.run(...names.map((name) => merged[name]!), ...keys.map((name) => row[name]!));
        else {
          insert.run(...names.map((name) => merged[name]!));
          importedRows++;
        }
      }
      for (const [id, row] of targetRows) {
        if (owned(row) && !incomingKeys.has(id) && equal(row, originalRows.get(id)))
          remove.run(...keys.map((name) => row[name]!));
      }
    }
    if (targetTables.has("projection_state"))
      target.exec(
        "UPDATE projection_state SET last_applied_sequence=(SELECT COALESCE(MAX(sequence),0) FROM orchestration_events)",
      );
    if (targetTables.has("orchestration_v2_projection_metadata"))
      target.exec(
        "UPDATE orchestration_v2_projection_metadata SET last_sequence=(SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread') WHERE projection_name='thread-projections'",
      );
    if (target.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Merged database failed integrity validation.");
    target.exec("COMMIT");
    return {
      importedEvents,
      importedRows,
      threads: acceptedThreads.size,
      projects: acceptedProjects.size,
    };
  } catch (error) {
    try {
      target.exec("ROLLBACK");
    } catch {
      /* Validation may fail before BEGIN. */
    }
    throw error;
  } finally {
    source.close();
    target.close();
    baseline?.close();
  }
}
