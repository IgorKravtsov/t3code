// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Tests write throwaway settings files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { syncT3SettingsIntoT4 } from "./t4SettingsSync.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

function write(path: string, value: unknown) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, JSON.stringify(value));
}
const read = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8"));

function setup() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4-settings-"));
  directories.push(root);
  const t3 = NodePath.join(root, "t3", "userdata");
  const t4 = NodePath.join(root, "t4");
  write(NodePath.join(t4, "t4-source.json"), {});
  write(NodePath.join(t4, "migration-source", "userdata", "client-settings.json"), {
    confirmQuit: "hold",
    fontSizeInterface: 17,
  });
  write(NodePath.join(t4, "userdata", "client-settings.json"), {
    confirmQuit: "hold",
    fontSizeInterface: 20,
  });
  write(NodePath.join(t3, "client-settings.json"), {
    confirmQuit: "direct",
    fontSizeInterface: 17,
  });
  return { t3, t4 };
}

describe("syncT3SettingsIntoT4", () => {
  it("applies settings changed in T3 since the snapshot and keeps T4 edits", () => {
    const { t3, t4 } = setup();
    expect(syncT3SettingsIntoT4(t4, t3)).toEqual(["client-settings.json"]);
    expect(read(NodePath.join(t4, "userdata", "client-settings.json"))).toEqual({
      confirmQuit: "direct",
      fontSizeInterface: 20,
    });

    // The applied T3 values become the baseline, so a later T4 edit sticks.
    write(NodePath.join(t4, "userdata", "client-settings.json"), {
      confirmQuit: "hold",
      fontSizeInterface: 20,
    });
    expect(syncT3SettingsIntoT4(t4, t3)).toEqual([]);
    expect(read(NodePath.join(t4, "userdata", "client-settings.json")).confirmQuit).toBe("hold");
  });

  it("never lets T4 resume threads T3 also owns", () => {
    const { t3, t4 } = setup();
    write(NodePath.join(t3, "settings.json"), {
      continueThreadsAfterServerUpdate: true,
      autoResumeLimitedThreads: true,
      projectSettingsOverrides: { ui: { continueThreadsAfterServerUpdate: true } },
    });
    syncT3SettingsIntoT4(t4, t3);
    expect(read(NodePath.join(t4, "userdata", "settings.json"))).toEqual({
      continueThreadsAfterServerUpdate: false,
      autoResumeLimitedThreads: false,
      projectSettingsOverrides: { ui: { continueThreadsAfterServerUpdate: false } },
    });
  });

  it("does nothing outside an installed T4 build", () => {
    const { t3, t4 } = setup();
    NodeFS.rmSync(NodePath.join(t4, "t4-source.json"));
    expect(syncT3SettingsIntoT4(t4, t3)).toEqual([]);
    expect(read(NodePath.join(t4, "userdata", "client-settings.json")).confirmQuit).toBe("hold");
  });
});
