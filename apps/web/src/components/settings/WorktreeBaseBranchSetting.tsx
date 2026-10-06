import { useRef } from "react";
import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function WorktreeBaseBranchSetting() {
  const { connectedEnvironments, targets } = useSettingsScope();
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
  return (
    <SettingsRow
      {...searchableSetting("worktree-base-branch")}
      description="Base ref for new worktrees, such as origin/GA. Leave empty to use the repository's default branch. An explicitly selected branch takes priority."
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
      }
    />
  );
}
