import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { notificationModeFor } from "../../t4/notificationMode";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const system = hasDesktopNotifications(mode);
  const sound = hasNotificationSound(mode);

  return (
    <>
      <SettingsRow
        {...searchableSetting("thread-notifications")}
        description={
          permissionMessage ??
          "Operating system notifications with the thread name and its last message when a thread finishes, fails, or needs input or approval. Applies to this device while T3 Code is open."
        }
        control={
          <Switch
            checked={system}
            disabled={requesting}
            aria-label="System notifications"
            onCheckedChange={async (checked) => {
              setPermissionMessage(null);
              if (checked) {
                if (typeof Notification === "undefined" || !window.isSecureContext) {
                  setPermissionMessage(
                    "System notifications need a supported browser over HTTPS, or the desktop app.",
                  );
                  return;
                }
                setRequesting(true);
                const permission = await settlePromise(() => Notification.requestPermission());
                setRequesting(false);
                if (permission._tag === "Failure") {
                  setPermissionMessage("System notifications are unavailable in this browser.");
                  return;
                }
                if (permission.value !== "granted") {
                  setPermissionMessage(
                    "Allow notifications in your browser or system settings, then turn this on again.",
                  );
                  return;
                }
              }
              updateSettings({ notificationMode: notificationModeFor({ system: checked, sound }) });
            }}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("notification-sound")}
        description="Play a sound when a thread finishes, fails, or needs input or approval."
        control={
          <Switch
            checked={sound}
            aria-label="Notification sound"
            onCheckedChange={(checked) => {
              if (checked) unlockNotificationAudio();
              updateSettings({ notificationMode: notificationModeFor({ system, sound: checked }) });
            }}
          />
        }
      />
    </>
  );
}
