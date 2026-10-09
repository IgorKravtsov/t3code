import type { ProjectId, ProjectSettingsOverrides } from "@t3tools/contracts";
import type * as Path from "effect/Path";

import { expandHomePathWith } from "@t3tools/provider-core/server/pathExpansion";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting, or `defaultDir` (`<T3 home>/worktrees`) when it is empty. Null when
 * a relative setting has no project root, the path belongs to another platform, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  workspaceRoot?: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePathWith(setting, path);
  if (
    !path.isAbsolute(expanded) &&
    (workspaceRoot === undefined || /^[a-z]:[\\/]/i.test(expanded) || expanded.startsWith("\\\\"))
  )
    return null;
  const resolved =
    workspaceRoot === undefined ? path.resolve(expanded) : path.resolve(workspaceRoot, expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

/** Every directory that holds T3-managed worktrees on this machine. */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
    readonly projectSettingsOverrides?: Readonly<Record<ProjectId, ProjectSettingsOverrides>>;
  },
  defaultDir: string,
  path: Path.Path,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }> = [],
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path);
    if (directory !== null) directories.add(directory);
  }
  for (const project of projects) {
    const setting =
      settings.projectSettingsOverrides?.[project.id]?.worktreesDirectory ??
      settings.worktreesDirectory;
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, project.workspaceRoot);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}
