// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Tests build throwaway git repositories on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createMergeCommit,
  fetchRemotes,
  git,
  inspectUpstream,
  publishBranch,
} from "./t4UpstreamGit.ts";
import { nextScheduledCheck } from "./T4UpstreamSync.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => NodeFSP.rm(d, { recursive: true, force: true })),
  );
});

async function commit(repository: string, file: string, content: string, message: string) {
  await NodeFSP.writeFile(NodePath.join(repository, file), content);
  await git(repository, ["add", file]);
  await git(repository, ["commit", "--quiet", "-m", message]);
  return (await git(repository, ["rev-parse", "HEAD"])).stdout.trim();
}

/** upstream (bare, main) and origin (bare, t4-code fork) cloned into a local checkout. */
async function setup() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t4-upstream-"));
  directories.push(root);
  const seed = NodePath.join(root, "seed");
  await NodeFSP.mkdir(seed);
  await git(seed, ["init", "--quiet", "-b", "main"]);
  await git(seed, ["config", "user.email", "t4@example.com"]);
  await git(seed, ["config", "user.name", "T4"]);
  await commit(seed, "shared.txt", "a\nb\nc\n", "initial");
  for (const name of ["upstream.git", "origin.git"])
    await git(root, ["clone", "--quiet", "--bare", seed, name]);
  await git(seed, ["push", "--quiet", NodePath.join(root, "origin.git"), "main:t4-code"]);

  const local = NodePath.join(root, "local");
  await git(root, ["clone", "--quiet", "-b", "t4-code", NodePath.join(root, "origin.git"), local]);
  await git(local, ["remote", "add", "upstream", NodePath.join(root, "upstream.git")]);
  await git(local, ["config", "user.email", "t4@example.com"]);
  await git(local, ["config", "user.name", "T4"]);
  const built = (await git(local, ["rev-parse", "HEAD"])).stdout.trim();

  const upstreamCommit = async (file: string, content: string, message: string) => {
    await git(seed, ["checkout", "--quiet", "main"]);
    await commit(seed, file, content, message);
    await git(seed, ["push", "--quiet", NodePath.join(root, "upstream.git"), "main"]);
  };
  const config = { repository: local, branch: "t4-code", builtCommit: built };
  return { root, local, config, upstreamCommit };
}

describe("inspectUpstream", () => {
  it("reports new upstream commits that merge cleanly, then merges and publishes them", async () => {
    const { root, local, config, upstreamCommit } = await setup();
    await commit(local, "fork.txt", "fork\n", "feat(t4): fork change");
    await git(local, ["push", "--quiet", "origin", "t4-code"]);
    await upstreamCommit("upstream.txt", "new\n", "feat: upstream change");

    await fetchRemotes(local, "t4-code");
    const inspection = await inspectUpstream(config);
    expect(inspection).toMatchObject({
      kind: "merge",
      conflicts: [],
      totalCommits: 1,
      commits: [{ subject: "feat: upstream change" }],
    });
    if (inspection.kind !== "merge") throw new Error("expected merge");

    const merged = await createMergeCommit(local, "t4-code", inspection);
    await publishBranch(local, "t4-code", merged);
    expect((await git(local, ["rev-parse", "HEAD"])).stdout.trim()).toBe(merged);
    expect((await git(local, ["status", "--porcelain"])).stdout).toBe("");
    expect(
      (await git(NodePath.join(root, "origin.git"), ["rev-parse", "t4-code"])).stdout.trim(),
    ).toBe(merged);
    await expect(inspectUpstream({ ...config, builtCommit: merged })).resolves.toMatchObject({
      kind: "up-to-date",
    });
  });

  it("lists conflicting files without producing a tree", async () => {
    const { local, config, upstreamCommit } = await setup();
    const built = await commit(local, "shared.txt", "a\nfork\nc\n", "feat(t4): edit shared");
    await upstreamCommit("shared.txt", "a\nupstream\nc\n", "feat: edit shared");

    await fetchRemotes(local, "t4-code");
    await expect(inspectUpstream({ ...config, builtCommit: built })).resolves.toMatchObject({
      kind: "merge",
      tree: null,
      conflicts: ["shared.txt"],
    });
  });

  it("offers a rebuild when the fork branch moved past the installed build", async () => {
    const { local, config } = await setup();
    await commit(local, "fork.txt", "fork\n", "fix(t4): merged on another machine");
    await git(local, ["push", "--quiet", "origin", "t4-code"]);
    await git(local, ["reset", "--quiet", "--hard", config.builtCommit]);

    await fetchRemotes(local, "t4-code");
    await expect(inspectUpstream(config)).resolves.toMatchObject({
      kind: "rebuild",
      totalCommits: 1,
      commits: [{ subject: "fix(t4): merged on another machine" }],
    });
  });

  it("still offers fork commits while upstream conflicts", async () => {
    const { local, config, upstreamCommit } = await setup();
    await commit(local, "shared.txt", "a\nfork\nc\n", "fix(t4): edit shared");
    await git(local, ["push", "--quiet", "origin", "t4-code"]);
    await upstreamCommit("shared.txt", "a\nupstream\nc\n", "feat: edit shared");

    await fetchRemotes(local, "t4-code");
    await expect(inspectUpstream(config)).resolves.toMatchObject({
      kind: "rebuild",
      conflicts: ["shared.txt"],
      commits: [{ subject: "fix(t4): edit shared" }],
    });
  });

  it("refuses to choose between diverged local and pushed branches", async () => {
    const { local, config } = await setup();
    await commit(local, "a.txt", "a\n", "pushed");
    await git(local, ["push", "--quiet", "origin", "t4-code"]);
    await git(local, ["reset", "--quiet", "--hard", config.builtCommit]);
    await commit(local, "b.txt", "b\n", "local only");

    await fetchRemotes(local, "t4-code");
    await expect(inspectUpstream(config)).rejects.toThrow(/diverged/);
  });
});

describe("nextScheduledCheck", () => {
  it("picks 09:00 and 18:00 local time", () => {
    const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
    expect(nextScheduledCheck(at(7, 8, 30))).toEqual(at(7, 9));
    expect(nextScheduledCheck(at(7, 9))).toEqual(at(7, 18));
    expect(nextScheduledCheck(at(7, 20))).toEqual(at(8, 9));
  });
});
