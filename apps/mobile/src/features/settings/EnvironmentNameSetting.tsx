import { useState } from "react";
import { View } from "react-native";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";

import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function EnvironmentNameSetting(props: {
  readonly environmentId: EnvironmentId;
  readonly config: ServerConfig | null;
  readonly allowed: boolean;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = props.config?.environment.capabilities.environmentName === true;
  const disabled = !props.allowed || !supported || saving;
  const name = draft ?? props.config?.settings.environmentName ?? "";
  async function save(value: string) {
    if (disabled) return;
    setSaving(true);
    setError(null);
    try {
      const result = await update({
        environmentId: props.environmentId,
        input: { patch: { environmentName: value.trim() } },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename environment.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection title="Environment name">
      <View className="gap-3 p-4">
        <ConnectionFormField
          label="Name"
          value={name}
          placeholder={props.config?.environment.label ?? "My laptop"}
          maxLength={200}
          editable={!disabled}
          onChangeText={setDraft}
        />
        <Text className="text-sm text-foreground-muted">
          {!supported
            ? "Connect to an updated server to rename this environment."
            : !props.allowed
              ? "Your session cannot change this environment's settings."
              : "Shared by all clients connected to this machine. Leave empty to use its detected name."}
        </Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="checkmark"
        label="Save name"
        disabled={disabled}
        loading={saving}
        onPress={() => {
          void save(name);
        }}
      />
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Use detected name"
        disabled={disabled || !props.config?.settings.environmentName}
        onPress={() => {
          void save("");
        }}
      />
    </SettingsSection>
  );
}
