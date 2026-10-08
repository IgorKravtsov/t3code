import { useRef } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { SettingsSection } from "./SettingsSection";
import type { ServerSettingsPatch } from "@t3tools/contracts";

export function WorktreeDefaultsSettings(props: {
  baseBranch: string | null;
  directory: string | null;
  disabled: boolean;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  return (
    <SettingsSection title="New worktrees">
      <WorktreeTextSetting
        label="Default worktree base branch"
        description="Base ref for threads that start in a new worktree, such as origin/GA. Current checkout threads keep the checkout's branch. Empty uses the repository default. An explicitly selected branch takes priority."
        value={props.baseBranch}
        disabled={props.disabled}
        onChange={(value) => props.onChange({ defaultWorktreeBaseBranch: value })}
      />
      <WorktreeTextSetting
        label="Worktree location"
        description="Folder on the selected machine. Use ../worktrees relative to the project, or an absolute path. Empty uses the T3 home folder. Existing worktrees stay where they are."
        value={props.directory}
        disabled={props.disabled}
        onChange={(value) => props.onChange({ worktreesDirectory: value })}
      />
    </SettingsSection>
  );
}

function WorktreeTextSetting(props: {
  label: string;
  description: string;
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const edited = useRef(false);
  return (
    <View className="gap-2 px-4 py-3">
      <Text className="text-base text-foreground">{props.label}</Text>
      <Text className="text-sm text-foreground-muted">{props.description}</Text>
      <AppTextInput
        key={props.value}
        accessibilityLabel={props.label}
        defaultValue={props.value ?? ""}
        placeholder={props.value === null ? "Mixed" : "Default"}
        editable={!props.disabled}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onChangeText={() => {
          edited.current = true;
        }}
        onEndEditing={(event) => {
          const value = event.nativeEvent.text.trim();
          if (!props.disabled && edited.current && value !== props.value) props.onChange(value);
          edited.current = false;
        }}
      />
    </View>
  );
}
