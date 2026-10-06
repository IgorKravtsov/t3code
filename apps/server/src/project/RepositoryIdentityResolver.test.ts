// @effect-diagnostics nodeBuiltinImport:off - realpathSync.native resolves Windows 8.3 short names, which the Effect realPath does not.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProviderError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { TestClock } from "effect/testing";

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

const layerRepositoryIdentityResolverTest = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}) =>
  Layer.effect(
    RepositoryIdentityResolver.RepositoryIdentityResolver,
    RepositoryIdentityResolver.make({
      cacheCapacity: 16,
      ...options,
    }),
  ).pipe(Layer.provide(ProcessRunner.layer));

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
        displayName: "team/repo",
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

  it.effect("refreshes the Git root only when requested", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootPath = "/repo";
    let remoteUrl = "git@github.com:T3Tools/t3code.git";
    let refinements = 0;
    let refinementFails = false;
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          return {
            stdout:
              input.command === "ssh"
                ? `hostname ${input.args.at(-1)}\n`
                : input.args.includes("rev-parse")
                  ? `${rootPath}\n`
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
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make({
        refine: (identity) => {
          refinements++;
          if (refinementFails)
            return Effect.fail(
              new SourceControlProviderError({
                provider: "forgejo",
                operation: "detectProvider",
                cwd: rootPath,
                detail: "account unavailable",
              }),
            );
          return Effect.succeed(
            identity.canonicalKey.startsWith("ssh.forge.test/")
              ? {
                  ...identity,
                  provider: "forgejo",
                  webUrl: "http://forge.test:3000/git/team/repo",
                }
              : identity,
          );
        },
      }),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const first = yield* resolver.resolve("/repo/packages/web");
      rootPath = "/repo/packages/web";
      // Longer than the one-minute cadence of the background sweeps.
      yield* TestClock.adjust(Duration.minutes(10));
      const second = yield* resolver.resolve("/repo/packages/web");

      expect(first?.canonicalKey).toBe("github.com/t3tools/t3code");
      expect(second).toEqual(first);
      expect(refinements).toBe(1);
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
        ["-G", "-l", "git", "--", "github.com"],
      ]);

      const refreshed = yield* resolver.resolve("/repo/packages/web", { refresh: true });
      expect(refreshed?.rootPath).toBe("/repo/packages/web");
      expect(yield* resolver.resolve("/repo/packages/web")).toEqual(refreshed);
      expect(calls.slice(3)).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "remote", "-v"],
        ["-G", "-l", "git", "--", "github.com"],
      ]);
      remoteUrl = "git@ssh.forge.test:team/repo.git";
      const forgejo = yield* resolver.resolve(rootPath, { refresh: true });
      expect(forgejo?.webUrl).toBe("http://forge.test:3000/git/team/repo");
      expect(forgejo?.provider).toBe("forgejo");
      expect(forgejo?.canonicalKey).toBe("ssh.forge.test/team/repo");
      expect(forgejo?.locator.remoteUrl).toBe(remoteUrl);
      expect(yield* resolver.resolve(rootPath)).toEqual(forgejo);
      expect(refinements).toBe(3);
      refinementFails = true;
      const unavailable = yield* resolver.resolve(rootPath, { refresh: true });
      expect(unavailable?.webUrl).toBeUndefined();
      expect(unavailable?.canonicalKey).toBe("ssh.forge.test/team/repo");
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("retries Git root discovery after the negative TTL", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    let rootAttempts = 0;
    const layerProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input.args);
          const rootLookup = input.args.includes("rev-parse");
          const failed = rootLookup && rootAttempts++ === 0;
          return {
            stdout:
              input.command === "ssh"
                ? "hostname github.com\n"
                : rootLookup
                  ? failed
                    ? ""
                    : "/repo\n"
                  : "origin\tgit@github.com:T3Tools/t3code.git (fetch)\n",
            stderr: failed ? "temporary Git failure" : "",
            code: ChildProcessSpawner.ExitCode(failed ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const layerResolver = Layer.effect(
      RepositoryIdentityResolver.RepositoryIdentityResolver,
      RepositoryIdentityResolver.make(),
    ).pipe(Layer.provide(layerProcessRunner));

    return Effect.gen(function* () {
      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();
      expect(yield* resolver.resolve("/repo/packages/web")).toBeNull();

      yield* TestClock.adjust(Duration.minutes(1));
      const recovered = yield* resolver.resolve("/repo/packages/web");
      expect(recovered?.rootPath).toBe("/repo");
      expect(calls).toEqual([
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo/packages/web", "rev-parse", "--show-toplevel"],
        ["-C", "/repo", "remote", "-v"],
        ["-G", "-l", "git", "--", "github.com"],
      ]);
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layerResolver)));
  });

  it.effect("normalizes equivalent GitHub remotes into a stable repository identity", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
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
      expect(identity?.displayName).toBe("t3tools/t3code");
      expect(identity?.provider).toBe("github");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
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
        expect(identity?.displayName).toBe("t3tools/t3code");
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
      expect(identity?.displayName).toBe("t3tools/t3code");
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
      expect(identity?.displayName).toBe("t3tools/platform/t3code");
      expect(identity?.owner).toBe("t3tools");
      expect(identity?.name).toBe("t3code");
    }).pipe(Effect.provide(RepositoryIdentityResolver.layer)),
  );

  it.effect(
    "keeps null identities cached across repeated resolves until the negative TTL expires",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-repository-identity-late-remote-test-",
        });

        yield* git(cwd, ["init"]);

        const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        const initialIdentity = yield* resolver.resolve(cwd);
        expect(initialIdentity).toBeNull();

        yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

        for (const _attempt of [1, 2, 3]) {
          const cachedIdentity = yield* resolver.resolve(cwd);
          expect(cachedIdentity).toBeNull();
        }

        yield* TestClock.adjust(Duration.millis(120));

        const refreshedIdentity = yield* resolver.resolve(cwd);
        expect(refreshedIdentity).not.toBeNull();
        expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
        expect(refreshedIdentity?.name).toBe("t3code");
      }).pipe(
        Effect.provide(
          Layer.merge(
            TestClock.layer(),
            layerRepositoryIdentityResolverTest({
              negativeCacheTtl: Duration.millis(50),
              positiveCacheTtl: Duration.seconds(1),
            }),
          ),
        ),
      ),
  );

  it.effect("refreshes cached identities after the positive TTL when a remote changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-repository-identity-remote-change-test-",
      });

      yield* git(cwd, ["init"]);
      yield* git(cwd, ["remote", "add", "origin", "git@github.com:T3Tools/t3code.git"]);

      const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      const initialIdentity = yield* resolver.resolve(cwd);
      expect(initialIdentity).not.toBeNull();
      expect(initialIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* git(cwd, ["remote", "set-url", "origin", "git@github.com:T3Tools/t3code-next.git"]);

      const cachedIdentity = yield* resolver.resolve(cwd);
      expect(cachedIdentity).not.toBeNull();
      expect(cachedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");

      yield* TestClock.adjust(Duration.millis(180));

      const refreshedIdentity = yield* resolver.resolve(cwd);
      expect(refreshedIdentity).not.toBeNull();
      expect(refreshedIdentity?.canonicalKey).toBe("github.com/t3tools/t3code-next");
      expect(refreshedIdentity?.displayName).toBe("t3tools/t3code-next");
      expect(refreshedIdentity?.name).toBe("t3code-next");
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          layerRepositoryIdentityResolverTest({
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.millis(100),
          }),
        ),
      ),
    ),
  );
});
