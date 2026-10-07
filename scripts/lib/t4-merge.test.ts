// @effect-diagnostics nodeBuiltinImport:off - Test real SQLite transactions and event ordering on private databases.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { afterEach, expect, it } from "@effect/vitest";
import { mergeT4Databases, mergeT4Values } from "./t4-merge.ts";
import { reencryptT4Credentials } from "./t4-keyring.ts";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => NodeFSP.rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-merge-test-"));
  temporary.push(directory);
  const original = NodePath.join(directory, "baseline.sqlite");
  const db = new NodeSqlite.DatabaseSync(original);
  db.exec(`
    CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, aggregate_kind TEXT, stream_id TEXT, stream_version INTEGER, event_type TEXT, application_event_version INTEGER, payload_json TEXT, actor_kind TEXT DEFAULT 'user', command_id TEXT, UNIQUE(aggregate_kind,stream_id,stream_version));
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_command_receipts(command_id TEXT PRIMARY KEY, aggregate_kind TEXT, aggregate_id TEXT, result_sequence INTEGER);
    CREATE TABLE orchestration_v2_projection_metadata(projection_name TEXT PRIMARY KEY, last_sequence INTEGER);
    CREATE TABLE projection_turns(row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, turn_id TEXT, checkpoint_turn_count INTEGER, UNIQUE(thread_id,turn_id));
    CREATE TABLE scheduled_tasks(task_id TEXT PRIMARY KEY, enabled INTEGER, prompt TEXT);
    CREATE TABLE orchestration_v2_effect_outbox(effect_id TEXT PRIMARY KEY, thread_id TEXT, status TEXT);
    CREATE TABLE auth_sessions(session_id TEXT PRIMARY KEY, subject TEXT);
    CREATE TABLE checkpoint_diff_blobs(thread_id TEXT,from_turn_count INTEGER,to_turn_count INTEGER,diff TEXT,created_at TEXT,UNIQUE(thread_id,from_turn_count,to_turn_count));
    INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(1,'project','project','p',0,'project.created',2,'{}');
    INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(2,'thread','thread','shared',0,'thread.created',2,'{}');
    INSERT INTO projection_projects VALUES('p','Project');
    INSERT INTO orchestration_v2_projection_threads VALUES('shared','p','Original','{"lastVisitedAt":null,"title":"Original"}');
    INSERT INTO orchestration_v2_projection_messages VALUES('message','shared','{"text":"original"}');
    INSERT INTO orchestration_v2_projection_metadata VALUES('thread-projections',2);
    INSERT INTO projection_turns VALUES(1,'shared','turn',1);
    INSERT INTO auth_sessions VALUES('old','original');
  `);
  db.close();
  const source = NodePath.join(directory, "source.sqlite");
  const target = NodePath.join(directory, "target.sqlite");
  await Promise.all([NodeFSP.copyFile(original, source), NodeFSP.copyFile(original, target)]);
  return { original, source, target };
}

it("merges T3 transcript updates and new threads while retaining T4 chats, visits, and authentication", async () => {
  const paths = await fixture();
  const source = new NodeSqlite.DatabaseSync(paths.source);
  const target = new NodeSqlite.DatabaseSync(paths.target);
  source.exec(`
    INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(3,'t3-message','thread','shared',1,'message.updated',2,'{}');
    INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(4,'t3-thread','thread','new-t3',0,'thread.created',2,'{}');
    UPDATE orchestration_v2_projection_threads SET title='Updated',payload_json='{"lastVisitedAt":null,"title":"Updated"}' WHERE thread_id='shared';
    INSERT INTO orchestration_v2_projection_messages VALUES('new-message','shared','{"text":"new in T3"}');
    INSERT INTO orchestration_v2_projection_threads VALUES('new-t3','p','T3 chat','{}');
    INSERT INTO orchestration_command_receipts VALUES('t3-command','thread','shared',3);
    INSERT INTO projection_turns VALUES(2,'new-t3','t3-turn',1);
    INSERT INTO scheduled_tasks VALUES('task',1,'future work');
    INSERT INTO orchestration_v2_effect_outbox VALUES('effect','shared','pending');
    INSERT INTO auth_sessions VALUES('t3-session','t3');
  `);
  target.exec(`
    INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(3,'t4-thread','thread','new-t4',0,'thread.created',2,'{}');
    INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(4,'t4-visit','thread','shared',1,'thread.visited',2,'{}');
    INSERT INTO orchestration_v2_projection_threads VALUES('new-t4','p','T4 chat','{}');
    UPDATE orchestration_v2_projection_threads SET payload_json='{"lastVisitedAt":"today","title":"Original"}' WHERE thread_id='shared';
    INSERT INTO projection_turns VALUES(2,'new-t4','t4-turn',1);
    INSERT INTO auth_sessions VALUES('t4-session','t4');
  `);
  source.close();
  target.close();
  expect(mergeT4Databases(paths.source, paths.target, paths.original)).toMatchObject({
    importedEvents: 2,
    threads: 2,
  });
  const merged = new NodeSqlite.DatabaseSync(paths.target);
  try {
    expect(
      merged
        .prepare(
          "SELECT title,payload_json FROM orchestration_v2_projection_threads WHERE thread_id='shared'",
        )
        .get(),
    ).toEqual({ title: "Updated", payload_json: '{"lastVisitedAt":"today","title":"Updated"}' });
    expect(
      merged
        .prepare("SELECT title FROM orchestration_v2_projection_threads WHERE thread_id='new-t4'")
        .get()?.title,
    ).toBe("T4 chat");
    expect(
      merged.prepare("SELECT count(*) AS n FROM orchestration_v2_projection_messages").get()?.n,
    ).toBe(2);
    expect(
      merged
        .prepare(
          "SELECT stream_version,sequence FROM orchestration_events WHERE event_id='t3-message'",
        )
        .get(),
    ).toEqual({ stream_version: 2, sequence: 5 });
    expect(
      merged
        .prepare(
          "SELECT result_sequence FROM orchestration_command_receipts WHERE command_id='t3-command'",
        )
        .get()?.result_sequence,
    ).toBe(5);
    expect(
      merged.prepare("SELECT last_sequence FROM orchestration_v2_projection_metadata").get()
        ?.last_sequence,
    ).toBe(6);
    expect(merged.prepare("SELECT count(*) AS n FROM projection_turns").get()?.n).toBe(3);
    expect(merged.prepare("SELECT enabled FROM scheduled_tasks").get()?.enabled).toBe(0);
    expect(merged.prepare("SELECT status FROM orchestration_v2_effect_outbox").get()?.status).toBe(
      "cancelled",
    );
    expect(merged.prepare("SELECT count(*) AS n FROM auth_sessions").get()?.n).toBe(2);
  } finally {
    merged.close();
  }
  expect(mergeT4Databases(paths.source, paths.target, paths.source)).toMatchObject({
    importedEvents: 0,
    threads: 0,
    importedRows: 0,
  });
});

it("refuses independently changed histories before writing to T4", async () => {
  const paths = await fixture();
  for (const [path, id] of [
    [paths.source, "source"],
    [paths.target, "target"],
  ]) {
    const db = new NodeSqlite.DatabaseSync(path!);
    db.prepare(
      "INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(3,?,'thread','shared',1,'run.requested',2,'{}')",
    ).run(id!);
    db.close();
  }
  const before = await NodeFSP.readFile(paths.target);
  expect(() => mergeT4Databases(paths.source, paths.target, paths.original)).toThrow(
    "independently changed",
  );
  expect(await NodeFSP.readFile(paths.target)).toEqual(before);
});

it("merges project settings and connections without removing edits or new values in T4", () => {
  const baseline = {
    projects: { ui: { branch: "main", path: "" } },
    profiles: [{ connectionId: "existing", label: "Old" }],
  };
  const source = {
    projects: { ui: { branch: "main", path: "../t3" }, new: { branch: "dev" } },
    profiles: [
      { connectionId: "existing", label: "New in T3" },
      { connectionId: "t3", label: "Added in T3" },
    ],
  };
  const target = {
    projects: { ui: { branch: "origin/GA", path: "" }, custom: { branch: "local" } },
    profiles: [
      { connectionId: "existing", label: "Custom T4" },
      { connectionId: "t4", label: "Added in T4" },
    ],
  };
  expect(mergeT4Values(source, target, baseline)).toEqual({
    projects: {
      ui: { branch: "origin/GA", path: "../t3" },
      new: { branch: "dev" },
      custom: { branch: "local" },
    },
    profiles: [
      { connectionId: "existing", label: "Custom T4" },
      { connectionId: "t4", label: "Added in T4" },
      { connectionId: "t3", label: "Added in T3" },
    ],
  });
});

it("retains T4 legacy connections while importing unencrypted connection records without a keyring helper", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-credentials-test-"));
  temporary.push(directory);
  const source = NodePath.join(directory, "source");
  const target = NodePath.join(directory, "target");
  await Promise.all([source, target].map((path) => NodeFSP.mkdir(path)));
  await NodeFSP.writeFile(
    NodePath.join(source, "saved-environments.json"),
    JSON.stringify({ records: [{ environmentId: "t3", label: "T3" }] }),
  );
  await NodeFSP.writeFile(
    NodePath.join(target, "saved-environments.json"),
    JSON.stringify({ records: [{ environmentId: "t4", label: "T4" }] }),
  );
  await reencryptT4Credentials(source, target, "missing-electron", directory, { merge: true });
  expect(
    JSON.parse(
      await NodeFSP.readFile(NodePath.join(target, "saved-environments.json"), "utf8"),
    ).records.map((row: { environmentId: string }) => row.environmentId),
  ).toEqual(["t4", "t3"]);
});

it("accepts startup recovery and PR refresh without treating them as independent chat edits", async () => {
  const paths = await fixture();
  const source = new NodeSqlite.DatabaseSync(paths.source);
  const target = new NodeSqlite.DatabaseSync(paths.target);
  source.exec(
    "INSERT INTO orchestration_events(sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,application_event_version,payload_json) VALUES(3,'new-message','thread','shared',1,'message.updated',2,'{}'); INSERT INTO checkpoint_diff_blobs VALUES('shared',0,1,'diff','today');",
  );
  target.exec(
    "INSERT INTO orchestration_events VALUES(3,'recovery','thread','shared',1,'run.updated',2,'{}','server','command:runtime-reconcile:startup:shared:today'); INSERT INTO orchestration_events VALUES(4,'pr-refresh','thread','shared',2,'thread.pull-request-synced',2,'{}','server','refresh');",
  );
  source.close();
  target.close();
  expect(mergeT4Databases(paths.source, paths.target, paths.original).importedEvents).toBe(1);
  const db = new NodeSqlite.DatabaseSync(paths.target);
  expect(db.prepare("SELECT diff FROM checkpoint_diff_blobs").get()?.diff).toBe("diff");
  db.close();
});

it("sync CLI backs up and merges offline, preserves T4 settings and identity, and refuses a running T4", async () => {
  const paths = await fixture();
  const directory = NodePath.dirname(paths.source);
  const source = NodePath.join(directory, "t3");
  const target = NodePath.join(directory, "t4");
  const baseline = NodePath.join(target, "migration-source/userdata");
  await Promise.all(
    [source, target, baseline].map((path) => NodeFSP.mkdir(path, { recursive: true })),
  );
  for (const home of [source, target]) await NodeFSP.mkdir(NodePath.join(home, "userdata"));
  await Promise.all([
    NodeFSP.copyFile(paths.source, NodePath.join(source, "userdata/statev2.sqlite")),
    NodeFSP.copyFile(paths.target, NodePath.join(target, "userdata/statev2.sqlite")),
    NodeFSP.copyFile(paths.original, NodePath.join(baseline, "statev2.sqlite")),
    NodeFSP.writeFile(NodePath.join(source, "userdata/environment-id"), "t3-id"),
    NodeFSP.writeFile(NodePath.join(target, "userdata/environment-id"), "t4-id"),
    NodeFSP.writeFile(
      NodePath.join(source, "userdata/settings.json"),
      JSON.stringify({
        environmentName: "T3",
        color: "new",
        projectSettingsOverrides: { new: { continueThreadsAfterServerUpdate: true } },
      }),
    ),
    NodeFSP.writeFile(
      NodePath.join(target, "userdata/settings.json"),
      JSON.stringify({ environmentName: "My T4", color: "old" }),
    ),
    NodeFSP.writeFile(
      NodePath.join(baseline, "settings.json"),
      JSON.stringify({ environmentName: "T3", color: "old" }),
    ),
  ]);
  const cli = NodeURL.fileURLToPath(new URL("../sync-t4-local.ts", import.meta.url));
  const run = (extra: string[] = []) =>
    new Promise<string>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        process.execPath,
        [cli, "--source-home", source, "--target-home", target, ...extra],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe" },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
    });
  const before = await NodeFSP.readFile(NodePath.join(target, "userdata/settings.json"), "utf8");
  expect(await run(["--dry-run"])).toContain('"dryRun": true');
  expect(await NodeFSP.readFile(NodePath.join(target, "userdata/settings.json"), "utf8")).toBe(
    before,
  );
  expect(await run()).toContain('"merged": true');
  const settings = JSON.parse(
    await NodeFSP.readFile(NodePath.join(target, "userdata/settings.json"), "utf8"),
  );
  expect(settings).toMatchObject({
    environmentName: "My T4",
    color: "new",
    projectSettingsOverrides: {
      new: { continueThreadsAfterServerUpdate: false, worktreeCleanup: { mode: "off" } },
    },
  });
  expect(await NodeFSP.readFile(NodePath.join(target, "userdata/environment-id"), "utf8")).toBe(
    "t4-id",
  );
  const backups = await NodeFSP.readdir(NodePath.join(target, "sync-backups"));
  expect(backups).toHaveLength(2);
  expect(
    await NodeFSP.readFile(
      NodePath.join(target, "sync-backups", backups[1]!, "t4-userdata/settings.json"),
      "utf8",
    ),
  ).toBe(before);
  expect(await run()).toContain('"importedEvents": 0');
  await NodeFSP.writeFile(
    NodePath.join(target, "userdata/server-runtime.json"),
    JSON.stringify({ pid: process.pid }),
  );
  await expect(run()).rejects.toThrow("T4 is running");
});
