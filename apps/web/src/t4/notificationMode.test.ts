import { expect, it } from "vite-plus/test";

import { hasDesktopNotifications, hasNotificationSound } from "../threadNotifications";
import { notificationModeFor } from "./notificationMode";

it.each([
  [false, false, "off"],
  [true, false, "notifications"],
  [false, true, "sound"],
  [true, true, "notifications-and-sound"],
] as const)("system %s and sound %s persist as %s", (system, sound, mode) => {
  expect(notificationModeFor({ system, sound })).toBe(mode);
  expect(hasDesktopNotifications(mode)).toBe(system);
  expect(hasNotificationSound(mode)).toBe(sound);
});
