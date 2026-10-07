// @effect-diagnostics nodeBuiltinImport:off - Fork-only git plumbing for the T4 upstream updater.
import * as NodeChildProcess from "node:child_process";

/** Written by scripts/build-t4-local.ts next to T4's userdata; absent in every other build. */
export interface T4SourceConfig {
  readonly repository: string;
  readonly branch: string;
  readonly builtCommit: string;
  /** Where build-t4-local.ts keeps source worktrees. */
  readonly buildRoot: string;
  readonly node: string;
  readonly path: string;
}

export interface T4Commit {
  readonly sha: string;
  readonly subject: string;
}

export type T4UpstreamInspection =
  | { readonly kind: "up-to-date"; readonly base: string }
  | {
      /** Upstream main has commits the fork lacks. `tree` is null when merging conflicts. */
      readonly kind: "merge";
      readonly base: string;
      readonly upstream: string;
      readonly tree: string | null;
      readonly conflicts: ReadonlyArray<string>;
      readonly commits: ReadonlyArray<T4Commit>;
      readonly totalCommits: number;
    }
  | {
      /**
       * The fork branch moved past the installed build, e.g. merged on another machine.
       * `conflicts` lists upstream files that still need reconciling by hand.
       */
      readonly kind: "rebuild";
      readonly base: string;
      readonly conflicts: ReadonlyArray<string>;
      readonly commits: ReadonlyArray<T4Commit>;
      readonly totalCommits: number;
    };

const UPSTREAM_REMOTE = "upstream";
const UPSTREAM_BRANCH = "main";
const FORK_REMOTE = "origin";
const MAX_LISTED_COMMITS = 100;

export async function git(
  repository: string,
  args: ReadonlyArray<string>,
  options: { readonly allowedExitCodes?: ReadonlyArray<number> } = {},
): Promise<{ readonly stdout: string; readonly code: number }> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", repository, ...args],
      // Never wait for a credential prompt from a background check.
      { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        if (code === 0 || options.allowedExitCodes?.includes(code)) {
          resolve({ stdout, code });
          return;
        }
        reject(new Error(`git ${args.join(" ")} failed: ${stderr.trim() || error?.message}`));
      },
    );
  });
}

const revParse = async (repository: string, ref: string) =>
  (
    await git(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      allowedExitCodes: [1],
    })
  ).stdout.trim() || null;

const isAncestor = async (repository: string, ancestor: string, descendant: string) =>
  (
    await git(repository, ["merge-base", "--is-ancestor", ancestor, descendant], {
      allowedExitCodes: [1],
    })
  ).code === 0;

async function listCommits(repository: string, range: string) {
  const total = Number(
    (await git(repository, ["rev-list", "--count", "--no-merges", range])).stdout.trim(),
  );
  const { stdout } = await git(repository, [
    "log",
    "--no-merges",
    `--max-count=${MAX_LISTED_COMMITS}`,
    "--format=%H%x09%s",
    range,
  ]);
  const commits = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    });
  return { commits, totalCommits: total };
}

/** The newest of the local fork branch and its pushed copy; diverged copies need a person. */
async function resolveForkBase(repository: string, branch: string) {
  const local = await revParse(repository, `refs/heads/${branch}`);
  const remote = await revParse(repository, `refs/remotes/${FORK_REMOTE}/${branch}`);
  if (!local && !remote) throw new Error(`Branch ${branch} does not exist in ${repository}.`);
  if (!local || !remote || local === remote) return (local ?? remote)!;
  if (await isAncestor(repository, local, remote)) return remote;
  if (await isAncestor(repository, remote, local)) return local;
  throw new Error(
    `${branch} and ${FORK_REMOTE}/${branch} have diverged. Reconcile them before updating T4.`,
  );
}

export async function fetchRemotes(repository: string, branch: string) {
  await git(repository, ["fetch", "--quiet", FORK_REMOTE, branch]);
  await git(repository, ["fetch", "--quiet", UPSTREAM_REMOTE, UPSTREAM_BRANCH]);
}

async function listForkCommits(
  config: Pick<T4SourceConfig, "repository" | "builtCommit">,
  base: string,
) {
  const known = await revParse(config.repository, config.builtCommit);
  const range =
    known && (await isAncestor(config.repository, known, base)) ? `${known}..${base}` : base;
  return listCommits(config.repository, range);
}

/** Decides what an update would do without touching any ref, index, or working tree. */
export async function inspectUpstream(
  config: Pick<T4SourceConfig, "repository" | "branch" | "builtCommit">,
): Promise<T4UpstreamInspection> {
  const { repository, branch } = config;
  const base = await resolveForkBase(repository, branch);
  const upstream = await revParse(repository, `refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`);
  if (!upstream) throw new Error(`${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} has not been fetched.`);

  if (!(await isAncestor(repository, upstream, base))) {
    const merge = await git(
      repository,
      ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, upstream],
      { allowedExitCodes: [1] },
    );
    const [tree = "", ...conflicts] = new Set(merge.stdout.split("\n").filter(Boolean));
    // A conflicting upstream must not block installing fork commits made since this build.
    if (merge.code !== 0 && base !== config.builtCommit)
      return { kind: "rebuild", base, conflicts, ...(await listForkCommits(config, base)) };
    return {
      kind: "merge",
      base,
      upstream,
      tree: merge.code === 0 ? tree : null,
      conflicts: merge.code === 0 ? [] : conflicts,
      ...(await listCommits(repository, `${base}..${upstream}`)),
    };
  }
  if (base !== config.builtCommit)
    return { kind: "rebuild", base, conflicts: [], ...(await listForkCommits(config, base)) };
  return { kind: "up-to-date", base };
}

/** Creates the merge commit from a conflict-free merge-tree result; no ref moves yet. */
export async function createMergeCommit(
  repository: string,
  branch: string,
  inspection: Extract<T4UpstreamInspection, { kind: "merge" }>,
) {
  if (!inspection.tree) throw new Error("Upstream changes conflict with the fork.");
  const message = `Merge ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} into ${branch}`;
  return (
    await git(repository, [
      "commit-tree",
      inspection.tree,
      "-p",
      inspection.base,
      "-p",
      inspection.upstream,
      "-m",
      message,
    ])
  ).stdout.trim();
}

/**
 * Pushes the built commit to the fork, then fast-forwards the local branch. A checked-out
 * branch moves through its worktree so that checkout stays clean. Returns why the local
 * branch could not follow; the pushed branch is already authoritative by then.
 */
export async function publishBranch(
  repository: string,
  branch: string,
  commit: string,
): Promise<string | null> {
  await git(repository, [
    // After any configured helper, fall back to the GitHub CLI login for HTTPS remotes.
    "-c",
    "credential.https://github.com.helper=!gh auth git-credential",
    "push",
    "--quiet",
    FORK_REMOTE,
    `${commit}:refs/heads/${branch}`,
  ]);
  try {
    const { stdout } = await git(repository, ["worktree", "list", "--porcelain"]);
    const checkout = stdout
      .split("\n\n")
      .find((entry) => entry.split("\n").includes(`branch refs/heads/${branch}`))
      ?.match(/^worktree (.+)$/m)?.[1];
    if (checkout) {
      await git(checkout, ["merge", "--quiet", "--ff-only", commit]);
      return null;
    }
    const local = await revParse(repository, `refs/heads/${branch}`);
    await git(repository, [
      "update-ref",
      `refs/heads/${branch}`,
      commit,
      ...(local ? [local] : []),
    ]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
