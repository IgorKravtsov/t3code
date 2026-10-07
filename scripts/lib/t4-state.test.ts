// @effect-diagnostics nodeBuiltinImport:off - Exercise real SQLite WAL and filesystem copies against isolated temporary state.
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import { afterEach, expect, it } from "@effect/vitest";
import { copyStateDirectory, databaseCounts, migrateT4State } from "./t4-state.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});

it("copies committed WAL messages, all tables, and files while keeping the source unchanged", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-copy-test-"));
  temporary.push(directory);
  const source = NodePath.join(directory, "t3");
  const userdata = NodePath.join(source, "userdata");
  await NodeFSP.mkdir(userdata, { recursive: true });
  const live = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  try {
    live.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE messages(id TEXT PRIMARY KEY, body TEXT);
      INSERT INTO messages VALUES ('chat', 'full transcript');
      CREATE TABLE scheduled_tasks(enabled INTEGER);
      INSERT INTO scheduled_tasks VALUES (1);
      CREATE TABLE orchestration_v2_effect_outbox(status TEXT, payload_json TEXT);
      INSERT INTO orchestration_v2_effect_outbox VALUES ('pending', 'preserve payload');`);
    const originalSettings = {
      continueThreadsAfterServerUpdate: true,
      projectSettingsOverrides: {
        ui: { defaultWorktreeBaseBranch: "origin/GA", continueThreadsAfterServerUpdate: true },
      },
    };
    await NodeFSP.writeFile(
      NodePath.join(userdata, "settings.json"),
      JSON.stringify(originalSettings),
    );
    await NodeFSP.writeFile(NodePath.join(userdata, "environment-id"), "original-id");
    await NodeFSP.writeFile(NodePath.join(userdata, "attachment"), "attachment contents");
    const destination = NodePath.join(directory, "t4");
    expect((await migrateT4State(source, destination)).migrated).toBe(true);
    const snapshot = NodePath.join(destination, "migration-source", "userdata");
    expect(databaseCounts(NodePath.join(snapshot, "statev2.sqlite"))).toEqual({
      messages: 1,
      scheduled_tasks: 1,
      orchestration_v2_effect_outbox: 1,
    });
    expect(
      await NodeFSP.readFile(NodePath.join(destination, "userdata", "attachment"), "utf8"),
    ).toBe("attachment contents");
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(snapshot, "settings.json"), "utf8")),
    ).toEqual(originalSettings);
    const migrated = new NodeSqlite.DatabaseSync(
      NodePath.join(destination, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      expect(migrated.prepare("SELECT * FROM messages").get()?.body).toBe("full transcript");
      expect(migrated.prepare("SELECT * FROM scheduled_tasks").get()?.enabled).toBe(0);
      expect(migrated.prepare("SELECT * FROM orchestration_v2_effect_outbox").get()).toMatchObject({
        status: "cancelled",
        payload_json: "preserve payload",
      });
    } finally {
      migrated.close();
    }
    expect(live.prepare("SELECT * FROM scheduled_tasks").get()?.enabled).toBe(1);
    expect(live.prepare("SELECT * FROM orchestration_v2_effect_outbox").get()?.status).toBe(
      "pending",
    );
    expect(
      JSON.parse(await NodeFSP.readFile(NodePath.join(userdata, "settings.json"), "utf8")),
    ).toEqual(originalSettings);
    const settingsPath = NodePath.join(destination, "userdata", "settings.json");
    const settings = JSON.parse(await NodeFSP.readFile(settingsPath, "utf8"));
    expect(settings.projectSettingsOverrides.ui).toMatchObject({
      defaultWorktreeBaseBranch: "origin/GA",
      continueThreadsAfterServerUpdate: false,
    });
    expect(
      await NodeFSP.readFile(NodePath.join(destination, "userdata", "environment-id"), "utf8"),
    ).not.toBe("original-id");
    await NodeFSP.writeFile(settingsPath, '{"modifiedInT4":true}');
    expect((await migrateT4State(source, destination)).migrated).toBe(false);
    expect(await NodeFSP.readFile(settingsPath, "utf8")).toBe('{"modifiedInT4":true}');
    await expect(migrateT4State(source, NodePath.join(source, "nested"))).rejects.toThrow(
      "separate",
    );
  } finally {
    live.close();
  }
});

it("refuses symlinks that would make the copied profile reference live state", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-symlink-test-"));
  temporary.push(directory);
  const source = NodePath.join(directory, "source");
  const fs = NodeFSP;
  await fs.mkdir(source);
  await fs.symlink(directory, NodePath.join(source, "live"));
  await expect(copyStateDirectory(source, NodePath.join(directory, "copy"))).rejects.toThrow(
    "symlink",
  );
});
