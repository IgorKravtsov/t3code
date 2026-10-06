import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { managedWorktreesDirectories, resolveWorktreesDirectory } from "./worktreesDirectory.ts";

const id = ProjectId.make("UI");
it.layer(Path.layer)("worktree directories", (it) => {
  it.effect("resolves relative paths against the project and preserves absolute paths", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveWorktreesDirectory("../worktrees", "/t3/worktrees", path, "/projects/UI")).toBe(
        "/projects/worktrees",
      );
      expect(
        resolveWorktreesDirectory("/data/worktrees", "/t3/worktrees", path, "/projects/UI"),
      ).toBe("/data/worktrees");
      expect(resolveWorktreesDirectory("", "/t3/worktrees", path, "/projects/UI")).toBe(
        "/t3/worktrees",
      );
      expect(resolveWorktreesDirectory("../../", "/t3/worktrees", path, "/projects/UI")).toBeNull();
      expect(
        resolveWorktreesDirectory("D:\\worktrees", "/t3/worktrees", path, "/projects/UI"),
      ).toBeNull();
    }),
  );
  it.effect("includes project locations and previous locations in reviews and cleanup", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        managedWorktreesDirectories(
          {
            ...DEFAULT_SERVER_SETTINGS,
            worktreesDirectory: "/global/worktrees",
            previousWorktreesDirectories: ["/old/worktrees"],
            projectSettingsOverrides: { [id]: { worktreesDirectory: "../worktrees" } },
          },
          "/t3/worktrees",
          path,
          [{ id, workspaceRoot: "/projects/UI" }],
        ),
      ).toEqual(["/t3/worktrees", "/global/worktrees", "/old/worktrees", "/projects/worktrees"]);
    }),
  );
});
