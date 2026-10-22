import type { ClientSettings } from "@t3tools/contracts/settings";

type NotificationMode = ClientSettings["notificationMode"];

/**
 * T4 shows system notifications and sound as separate switches. Both still persist in the
 * shared `notificationMode`, so settings stay compatible with T3 and settings sync.
 */
export function notificationModeFor(input: {
  readonly system: boolean;
  readonly sound: boolean;
}): NotificationMode {
  if (input.system) return input.sound ? "notifications-and-sound" : "notifications";
  return input.sound ? "sound" : "off";
}
