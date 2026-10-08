import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useRef } from "react";
import { Input } from "../ui/input";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function WorktreeBaseBranchSetting() {
  const { connectedEnvironments, targets, target: representative, scope } = useSettingsScope();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["defaultWorktreeBaseBranch"]);
  const edited = useRef(false);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeDefaults !== true,
    )
  )
    return null;
  // A project scope has a repository to list refs from; the representative
  // member supplies them. Environment scopes keep a free-text field.
  const member =
    scope.kind === "project" || scope.kind === "checkout"
      ? (scope.members.find(
          (candidate) =>
            candidate.environmentId === representative?.environmentId &&
            candidate.id === representative.projectId,
        ) ?? null)
      : null;
  // The base ref only seeds new worktrees, so call it out when every selected
  // target starts new threads in the current checkout instead.
  const startsInCurrentCheckout =
    targets.length > 0 &&
    targets.every(
      (target) =>
        resolveProjectSettings(target.settings, null, null, null).settings.defaultThreadEnvMode ===
        "local",
    );
  return (
    <SettingsRow
      {...searchableSetting("worktree-base-branch")}
      description="Base ref for threads that start in a new worktree, such as origin/GA. Leave empty to use the repository's default branch. An explicitly selected branch takes priority."
      status={
        startsInCurrentCheckout
          ? "New threads start in the current checkout and keep its branch. This applies only when you pick New worktree."
          : undefined
      }
      serverScoped
      settingKeys={["defaultWorktreeBaseBranch"]}
      resetAction={
        mixed || settings.defaultWorktreeBaseBranch !== "" ? (
          <SettingResetButton
            label="worktree base branch"
            onClick={() => update({ defaultWorktreeBaseBranch: "" })}
          />
        ) : null
      }
      control={
        member ? (
          <WorktreeBaseBranchPicker
            aria-label="Default worktree base branch"
            environmentId={member.environmentId}
            cwd={member.workspaceRoot}
            value={mixed ? "" : settings.defaultWorktreeBaseBranch}
            placeholder={mixed ? "Mixed" : "Repository default"}
            onValueChange={(value) => update({ defaultWorktreeBaseBranch: value })}
          />
        ) : (
          <Input
            key={`${targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",")}:${mixed}:${settings.defaultWorktreeBaseBranch}`}
            aria-label="Default worktree base branch"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={mixed ? "Mixed" : "Repository default"}
            defaultValue={mixed ? "" : settings.defaultWorktreeBaseBranch}
            onChange={() => {
              edited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (edited.current && (mixed || value !== settings.defaultWorktreeBaseBranch))
                update({ defaultWorktreeBaseBranch: value });
              edited.current = false;
            }}
          />
        )
      }
    />
  );
}
