// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Fork-only Electron main helper; it shells out to git and a detached build outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { T4UpstreamState } from "@t3tools/contracts";
import { app, BrowserWindow, ipcMain } from "electron";

import {
  T4_UPSTREAM_CHECK_CHANNEL,
  T4_UPSTREAM_GET_STATE_CHANNEL,
  T4_UPSTREAM_STATE_CHANNEL,
  T4_UPSTREAM_UPDATE_CHANNEL,
} from "./t4UpstreamChannels.ts";
import {
  createMergeCommit,
  fetchRemotes,
  git,
  inspectUpstream,
  publishBranch,
  type T4SourceConfig,
  type T4UpstreamInspection,
} from "./t4UpstreamGit.ts";

const STARTUP_CHECK_DELAY_MS = 15_000;
const CHECK_HOURS = [9, 18];

/** The next 09:00 or 18:00 in local time after `now`. */
export function nextScheduledCheck(now: Date): Date {
  for (const dayOffset of [0, 1]) {
    for (const hour of CHECK_HOURS) {
      const slot = new Date(now);
      slot.setDate(now.getDate() + dayOffset);
      slot.setHours(hour, 0, 0, 0);
      if (slot > now) return slot;
    }
  }
  throw new Error("unreachable");
}

export function stateFromInspection(
  branch: string,
  inspection: T4UpstreamInspection,
  checkedAt: string,
): T4UpstreamState {
  const base = { branch, checkedAt, message: null, logPath: null };
  if (inspection.kind === "up-to-date") {
    return {
      ...base,
      status: "up-to-date",
      kind: null,
      commits: [],
      totalCommits: 0,
      conflicts: [],
    };
  }
  return {
    ...base,
    status: inspection.kind === "merge" && inspection.tree === null ? "conflicts" : "available",
    kind: inspection.kind,
    commits: inspection.commits,
    totalCommits: inspection.totalCommits,
    conflicts: inspection.conflicts,
  };
}

function readConfig(path: string): T4SourceConfig | null {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8")) as T4SourceConfig;
  } catch {
    return null;
  }
}

/** The build runs with the toolchain recorded at install time, outside this app's T3/T4 context. */
function buildEnvironment(config: T4SourceConfig): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: config.path };
  for (const key of Object.keys(environment))
    if (/^(T3CODE_|T3_|ELECTRON_)/.test(key)) delete environment[key];
  return environment;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Checks the fork against upstream T3 main at startup and at 09:00/18:00, and on request
 * merges, rebuilds, and relaunches. Inert unless scripts/build-t4-local.ts installed this app.
 */
export function startT4UpstreamSync(baseDir: string) {
  const config = readConfig(NodePath.join(baseDir, "t4-source.json"));
  const logPath = NodePath.join(baseDir, "t4-update.log");
  let busy = false;
  let state: T4UpstreamState = {
    status: config ? "idle" : "disabled",
    kind: null,
    branch: config?.branch ?? null,
    commits: [],
    totalCommits: 0,
    conflicts: [],
    checkedAt: null,
    message: null,
    logPath: null,
  };
  const setState = (next: T4UpstreamState) => {
    state = next;
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(T4_UPSTREAM_STATE_CHANNEL, state);
  };
  const progress = (message: string) =>
    setState({ ...state, status: "updating", message, logPath });

  const inspect = async (source: T4SourceConfig) => {
    await fetchRemotes(source.repository, source.branch);
    const inspection = await inspectUpstream(source);
    setState(stateFromInspection(source.branch, inspection, new Date().toISOString()));
    return inspection;
  };

  const check = async () => {
    if (!config || busy) return state;
    busy = true;
    setState({ ...state, status: "checking", message: null });
    try {
      await inspect(config);
    } catch (error) {
      setState({ ...state, status: "error", message: errorMessage(error) });
    } finally {
      busy = false;
    }
    return state;
  };

  const runBuildScript = async (source: string, args: ReadonlyArray<string>, log: number) =>
    new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(
        config!.node,
        [NodePath.join(source, "scripts", "build-t4-local.ts"), "--in-place", ...args],
        { cwd: source, env: buildEnvironment(config!), stdio: ["ignore", "pipe", "pipe"] },
      );
      let lastReport = 0;
      const onOutput = (chunk: Buffer) => {
        NodeFS.writeSync(log, chunk);
        const line = chunk.toString().trim().split("\n").pop()?.trim();
        if (line && Date.now() - lastReport > 2000) {
          lastReport = Date.now();
          progress(`Building T4: ${line.slice(0, 160)}`);
        }
      };
      child.stdout.on("data", onOutput);
      child.stderr.on("data", onOutput);
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`The T4 build failed. See ${logPath}.`)),
      );
    });

  const update = async () => {
    if (!config || busy) return state;
    busy = true;
    let source: string | null = null;
    const log = NodeFS.openSync(logPath, "w");
    try {
      progress("Fetching T3 and fork changes…");
      const inspection = await inspect(config);
      if (inspection.kind === "up-to-date" || state.status === "conflicts") return state;
      const target =
        inspection.kind === "merge"
          ? await createMergeCommit(config.repository, config.branch, inspection)
          : inspection.base;

      progress("Preparing source…");
      await NodeFSP.mkdir(config.buildRoot, { recursive: true, mode: 0o700 });
      source = await NodeFSP.mkdtemp(NodePath.join(config.buildRoot, "source-"));
      await git(config.repository, ["worktree", "add", "--detach", source, target]);
      progress("Building T4…");
      await runBuildScript(source, ["--prepare-only", "--no-migrate"], log);

      progress(`Pushing ${config.branch}…`);
      const localBranchProblem = await publishBranch(config.repository, config.branch, target);
      if (localBranchProblem)
        NodeFS.writeSync(
          log,
          `Pushed ${target}; local ${config.branch} not moved: ${localBranchProblem}\n`,
        );

      progress("Restarting T4…");
      // Installs over this app once it exits, then launches the new build.
      NodeChildProcess.spawn(
        config.node,
        [
          NodePath.join(source, "scripts", "build-t4-local.ts"),
          "--in-place",
          "--install-prepared",
          "--wait-pid",
          String(process.pid),
          "--launch",
        ],
        { cwd: source, env: buildEnvironment(config), detached: true, stdio: ["ignore", log, log] },
      ).unref();
      source = null;
      app.quit();
      return state;
    } catch (error) {
      setState({ ...state, status: "error", message: errorMessage(error), logPath });
      return state;
    } finally {
      NodeFS.closeSync(log);
      if (source) {
        await git(config.repository, ["worktree", "remove", "--force", source]).catch(() => {});
        await NodeFSP.rm(source, { recursive: true, force: true });
      }
      if (state.status !== "updating") busy = false;
    }
  };

  ipcMain.handle(T4_UPSTREAM_GET_STATE_CHANNEL, () => state);
  ipcMain.handle(T4_UPSTREAM_CHECK_CHANNEL, () => check());
  ipcMain.handle(T4_UPSTREAM_UPDATE_CHANNEL, () => update());
  if (!config) return;

  const scheduleNext = () => {
    const delay = nextScheduledCheck(new Date()).getTime() - Date.now();
    setTimeout(() => void check().finally(scheduleNext), delay);
  };
  setTimeout(() => void check(), STARTUP_CHECK_DELAY_MS);
  scheduleNext();
}
