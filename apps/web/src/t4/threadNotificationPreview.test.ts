import { describe, expect, it } from "vite-plus/test";

import { latestAssistantMessageText, notificationPreviewText } from "./threadNotificationPreview";

function message(text: string, overrides: Record<string, unknown> = {}) {
  return { role: "assistant", text, nodeId: null, ...overrides } as never;
}

describe("latestAssistantMessageText", () => {
  it("picks the newest thread reply, skipping subagents, users and empty text", () => {
    expect(
      latestAssistantMessageText({
        subagents: [{ id: "sub" }] as never,
        messages: [
          message("Fixed the **login** bug."),
          message("   "),
          message("subagent report", { nodeId: "sub" }),
          message("script", { workflowScript: true }),
          message("thanks", { role: "user" }),
        ],
      }),
    ).toBe("Fixed the login bug.");
  });

  it("returns null without an agent reply", () => {
    expect(
      latestAssistantMessageText({ subagents: [], messages: [message("hi", { role: "user" })] }),
    ).toBeNull();
  });
});

describe("notificationPreviewText", () => {
  it("flattens markdown into one line", () => {
    expect(
      notificationPreviewText(
        "## Done\n\n- [x] Updated `auth.ts`\n> see [the PR](https://x.test/1)\n```ts\nconst a = 1;\n```",
      ),
    ).toBe("Done Updated auth.ts see the PR const a = 1;");
  });

  it("truncates long text with an ellipsis", () => {
    const preview = notificationPreviewText("word ".repeat(100), 20);
    expect(preview).toBe("word word word word…");
    expect(preview.length).toBeLessThanOrEqual(20);
  });
});
