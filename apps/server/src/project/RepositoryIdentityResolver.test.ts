// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const normalizePathSeparators = (value: string) => value.replaceAll("\\", "/");
const normalizeResolvedPath = (value: string) => normalizePathSeparators(value);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      command: "git",
      args: ["-C", cwd, ...args],
    });
  }).pipe(Effect.provide(ProcessRunner.layer));

it.layer(NodeServices.layer)("RepositoryIdentityResolverLive", (it) => {
  it.effect("lets OpenSSH evaluate Include and Match user with an isolated configuration", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ssh-identity-" });
      const configPath = path.join(cwd, "ssh_config");
      const includedPath = path.join(cwd, "accounts.conf");
      yield* fileSystem.writeFileString(
        configPath,
        `Include "${normalizePathSeparators(includedPath)}"\n`,
      );
      yield* fileSystem.writeFileString(
        includedPath,
        "Match originalhost tenant-alias user git\n  HostName github.com\nHost *\n  HostName gitlab.com\n",
      );
      yield* git(cwd, ["init"]);
      const runner = yield* ProcessRunner.ProcessRunner.pipe(Effect.provide(ProcessRunner.layer));
      const resolver = yield* RepositoryIdentityResolver.make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            runner.run(
              input.command === "ssh"
                ? { ...input, args: ["-F", configPath, ...input.args] }
                : input,
            ),
        }),
      );
      yield* git(cwd, ["remote", "add", "origin", "git@tenant-alias:Team/Repo.git"]);
      const github = yield* resolver.resolve(cwd);
      expect(github?.canonicalKey).toBe("github.com/team/repo");
      expect(github?.provider).toBe("github");
      expect(github?.locator.remoteUrl).toBe("git@tenant-alias:Team/Repo.git");
      yield* git(cwd, [
        "remote",
        "set-url",
        "origin",
        "ssh://other@tenant-alias:2222/Team/Repo.git",
      ]);
      const gitlab = yield* resolver.resolve(cwd, { refresh: true });
      expect(gitlab?.canonicalKey).toBe("gitlab.com/team/repo");
      expect(gitlab?.provider).toBe("gitlab");
      yield* git(cwd, ["remote", "add", "upstream", "git@tenant-alias:Upstream/Repo.git"]);
      const fork = yield* resolver.resolve(cwd, { refresh: true });
      expect(fork?.canonicalKey).toBe("github.com/upstream/repo");
      expect(fork?.origin).toEqual({
        canonicalKey: "gitlab.com/team/repo",
        displayName: "Team/Repo",
      });
      expect(fork?.locator.remoteUrl).toBe("git@tenant-alias:Upstream/Repo.git");
    }),
  );

  it.effect.each(["unavailable", "failed", "timed-out", "malformed"] as const)(
    "keeps the original identity when SSH configuration resolution is %s",
    (failure) =>
      Effect.gen(function* () {
        const remoteUrl = "git@unresolved-alias:Team/Repo.git";
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) => {
              if (input.command === "ssh" && failure === "unavailable")
                return Effect.fail(
                  new ProcessRunner.ProcessSpawnError({
                    command: "ssh",
                    argumentCount: input.args.length,
                    cause: "missing executable",
                  }),
                );
              return Effect.succeed({
                stdout:
                  input.command === "ssh"
                    ? "not a configuration\n"
                    : input.args.includes("rev-parse")
                      ? "/repo\n"
                      : `origin\t${remoteUrl} (fetch)\n`,
                stderr: "",
                code: ChildProcessSpawner.ExitCode(
                  input.command === "ssh" && failure !== "malformed" ? 1 : 0,
                ),
                timedOut: input.command === "ssh" && failure === "timed-out",
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              });
            },
          }),
        );
        const identity = yield* resolver.resolve("/repo");
        expect(identity?.canonicalKey).toBe("unresolved-alias/team/repo");
        expect(identity?.provider).toBe("unknown");
        expect(identity?.locator.remoteUrl).toBe(remoteUrl);
      }),
  );

  it.effect.each([
    {
      remoteUrl: "git@work-account:ToneMeUp/UI.git",
      args: ["-G", "-l", "git", "--", "work-account"],
    },
    {
      remoteUrl: "ssh://git@work-account:2222/ToneMeUp/UI.git",
      args: ["-G", "-l", "git", "-p", "2222", "--", "work-account"],
    },
    { remoteUrl: "work-account:ToneMeUp/UI.git", args: ["-G", "--", "work-account"] },
  ])(
    "resolves the effective SSH hostname for $remoteUrl without rewriting the Git locator",
    ({ remoteUrl, args }) =>
      Effect.gen(function* () {
        const calls: ProcessRunner.ProcessRunInput[] = [];
        const resolver = yield* RepositoryIdentityResolver.make().pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              Effect.sync(() => {
                calls.push(input);
                return {
                  stdout:
                    input.command === "ssh"
                      ? "host work-account\nhostname github.com\nuser git\n"
                      : input.args.includes("rev-parse")
                        ? "/UI\n"
                        : `origin\t${remoteUrl} (fetch)\n`,
                  stderr: "",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                };
              }),
          }),
        );
        const identity = yield* resolver.resolve("/UI");
        expect(identity?.canonicalKey).toBe("github.com/tonemeup/ui");
        expect(identity?.provider).toBe("github");
        expect(identity?.locator.remoteUrl).toBe(remoteUrl);
        expect(calls.find((call) => call.command === "ssh")).toMatchObject({ cwd: "/UI", args });
        expect(yield* resolver.resolve("/UI")).toEqual(identity);
        expect(calls.filter((call) => call.command === "ssh")).toHaveLength(1);
      }),
  );
  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      // Native realpath, since git reports the long form of a directory the
      // temp dir may name by its 8.3 short form on Windows.
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedCwd = NodeFS.realpathSync.native(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(normalizeResolvedPath(resolvedCwd));
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
      expect(yield* resolver.resolve(path.join(cwd, ".git"))).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("resolves the fetch remote of a partial clone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-partial-clone-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
      yield* git(cwd, ["remote", "set-url", "--push", "origin", "git@github.com:T3Tools/push.git"]);
      yield* git(cwd, ["config", "remote.origin.promisor", "true"]);
      yield* git(cwd, ["config", "remote.origin.partialclonefilter", "blob:none"]);

      const remotes = yield* git(cwd, ["remote", "-v"]);
      expect(remotes.stdout).toContain("(fetch) [blob:none]");

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.locator.remoteUrl).toBe("git@github.com:T3Tools/t3code.git");
      expect(identity?.locator.remoteName).toBe("origin");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns the git top-level root path when resolving from a nested workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repoRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-root-test-",
      });
      const nestedWorkspace = path.join(repoRoot, "packages", "web");

      yield* fileSystem.makeDirectory(nestedWorkspace, { recursive: true });
      yield* git(repoRoot, ["init"]);
      yield* git(repoRoot, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(nestedWorkspace);
      const resolvedIdentityRoot =
        identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);
      const resolvedRepoRoot = NodeFS.realpathSync.native(repoRoot);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
        normalizeResolvedPath(resolvedRepoRoot),
      );
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["bare clone", "dot-bare"] as const)(
    "resolves a %s to its Git directory and the same identity as a checkout",
    (layout) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const checkout = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-checkout-",
        });
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-bare-",
        });
        const bareGitDir = layout === "dot-bare" ? path.join(root, ".bare") : root;

        yield* git(checkout, ["init"]);
        yield* git(checkout, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);
        yield* git(root, ["init", "--bare", bareGitDir]);
        if (layout === "dot-bare") {
          yield* fileSystem.writeFileString(path.join(root, ".git"), "gitdir: ./.bare\n");
        }
        yield* git(root, [
          "--git-dir",
          bareGitDir,
          "remote",
          "add",
          "origin",
          "https://github.com/T3Tools/t3code.git",
        ]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const checkoutIdentity = yield* resolver.resolve(checkout);
        expect(checkoutIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        const resolvedBareGitDir = NodeFS.realpathSync.native(bareGitDir);
        const projectRoots = layout === "dot-bare" ? [root, bareGitDir] : [root];

        for (const projectRoot of projectRoots) {
          const identity = yield* resolver.resolve(projectRoot);
          const resolvedIdentityRoot =
            identity?.rootPath === undefined ? "" : NodeFS.realpathSync.native(identity.rootPath);

          expect(identity).not.toBeNull();
          expect(identity?.canonicalKey).toBe(checkoutIdentity?.canonicalKey);
          expect(normalizeResolvedPath(resolvedIdentityRoot)).toBe(
            normalizeResolvedPath(resolvedBareGitDir),
          );
        }

        yield* git(root, ["--git-dir", bareGitDir, "remote", "remove", "origin"]);
        for (const projectRoot of projectRoots) {
          expect(yield* resolver.resolve(projectRoot, { refresh: true })).toBeNull();
        }
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("returns null for non-git folders and repos without remotes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const nonGitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-non-git-",
      });
      const gitDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-no-remote-",
      });

      yield* git(gitDir, ["init"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const nonGitIdentity = yield* resolver.resolve(nonGitDir);
      const noRemoteIdentity = yield* resolver.resolve(gitDir);

      expect(nonGitIdentity).toBeNull();
      expect(noRemoteIdentity).toBeNull();
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("ignores local-path remotes such as GitButler's gb-local", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const localOnlyDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-local-remote-",
      });
      const mixedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-mixed-remote-",
      });

      yield* git(localOnlyDir, ["init"]);
      yield* git(localOnlyDir, ["remote", "add", "gb-local", "."]);
      yield* git(localOnlyDir, ["remote", "add", "backup", "/srv/git/repo.git"]);
      yield* git(localOnlyDir, ["remote", "add", "archive", "file:///srv/git/repo.git"]);
      yield* git(mixedDir, ["init"]);
      yield* git(mixedDir, ["remote", "add", "gb-local", "."]);
      yield* git(mixedDir, ["remote", "add", "mirror", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve(localOnlyDir)).toBeNull();

      const mixedIdentity = yield* resolver.resolve(mixedDir);
      expect(mixedIdentity?.locator.remoteName).toBe("mirror");
      expect(mixedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect.each(["add", "replace"] as const)(
    "refreshes the primary upstream after %s before cache expiry",
    (change) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-upstream-test-",
        });

        yield* git(cwd, ["init"]);
        yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code.git"]);
        if (change === "replace") {
          yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/previous.git"]);
        }

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity?.canonicalKey).toBe(
          change === "add" ? "github.com/julius/t3code" : "github.com/t3tools/previous",
        );

        yield* git(cwd, [
          "remote",
          change === "add" ? "add" : "set-url",
          "upstream",
          "git@github.com:T3Tools/t3code.git",
        ]);
        expect(yield* resolver.resolve(cwd)).toEqual(initialIdentity);
        const identity = yield* resolver.resolve(cwd, { refresh: true });

        expect(identity).not.toBeNull();
        expect(identity?.locator.remoteName).toBe("upstream");
        expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(identity?.displayName).toBe("T3Tools/t3code");
        expect(yield* resolver.resolve(cwd)).toEqual(identity);
      }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("reports a fork's own remote as origin next to the upstream identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-fork-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:julius/t3code-fork.git"]);
      yield* git(cwd, ["remote", "add", "upstream", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(identity?.displayName).toBe("T3Tools/t3code");
      expect(identity?.origin).toEqual({
        canonicalKey: "github.com/julius/t3code-fork",
        displayName: "julius/t3code-fork",
      });
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect("uses the last remote path segment as the repository name for nested groups", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-nested-group-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@gitlab.com:T3Tools/platform/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const identity = yield* resolver.resolve(cwd);

      expect(identity).not.toBeNull();
      expect(identity?.canonicalKey).toBe("gitlab.com/t3tools/platform/t3code");
      expect(identity?.displayName).toBe("T3Tools/platform/t3code");
      expect(identity?.owner).toBe("T3Tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );
});
