import type { EnvironmentId, OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { orchestrationEnvironment } from "../state/orchestration";

const PREVIEW_MAX_LENGTH = 180;

/** The last agent reply on the thread itself; subagent replies belong to their own task. */
export function latestAssistantMessageText(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "subagents">,
): string | null {
  const subagentNodes = new Set(projection.subagents.map((subagent) => subagent.id));
  for (let index = projection.messages.length - 1; index >= 0; index -= 1) {
    const message = projection.messages[index]!;
    if (message.role !== "assistant" || message.workflowScript === true) continue;
    if (message.nodeId !== null && subagentNodes.has(message.nodeId)) continue;
    const text = notificationPreviewText(message.text);
    if (text) return text;
  }
  return null;
}

/** OS notifications show plain text, so markdown syntax is dropped before truncating. */
export function notificationPreviewText(markdown: string, maxLength = PREVIEW_MAX_LENGTH): string {
  const text = markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?)/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

/**
 * The shell deliberately carries no message bodies, so the preview reads one bounded thread
 * window when a notification fires. A slow or failed read leaves the notification without it.
 */
export function loadThreadNotificationPreview(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): Promise<string | null> {
  return Effect.runPromise(
    AtomRegistry.getResult(
      appAtomRegistry,
      orchestrationEnvironment.v2.threadProjection({ environmentId, input: { threadId } }),
      { suspendOnWaiting: true },
    ).pipe(
      Effect.map(latestAssistantMessageText),
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}
