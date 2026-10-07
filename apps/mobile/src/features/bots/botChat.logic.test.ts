import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  botThreadLinkTarget,
  botMarkdownThreadLinks,
  botComposerReducer,
  botComposerAtom,
  isBotSendDraftUnchanged,
  botStatusLabel,
  initialBotComposer,
} from "./botChat.logic";

const now = Date.parse("2026-10-06T12:00:00Z");

describe("bot status", () => {
  it("prioritizes work over pause and pause over activity", () => {
    const status = { working: true, paused: true, lastActivity: "2026-10-06T11:00:00Z" };
    expect(botStatusLabel(status, now)).toBe("Working…");
    expect(botStatusLabel({ ...status, working: false }, now)).toBe("Paused");
    expect(botStatusLabel({ ...status, working: false, paused: false }, now)).toBe("1h ago");
    expect(botStatusLabel({ working: false, paused: false, lastActivity: null }, now)).toBe("Idle");
  });

  it("formats recent and future activity without negative ages", () => {
    expect(
      botStatusLabel({ working: false, paused: false, lastActivity: "2026-10-06T12:01:00Z" }, now),
    ).toBe("just now");
    expect(
      botStatusLabel({ working: false, paused: false, lastActivity: "2026-10-06T11:45:00Z" }, now),
    ).toBe("15m ago");
    expect(
      botStatusLabel({ working: false, paused: false, lastActivity: "2026-10-04T12:00:00Z" }, now),
    ).toBe("2d ago");
  });
});

describe("bot command state", () => {
  const draft = initialBotComposer("environment-a:bot-a");
  const pending = botComposerReducer(draft, {
    type: "send",
    requestId: "send-1",
    hasContent: true,
  });

  it("retains a failure for retry without owning draft content", () => {
    const failed = botComposerReducer(pending, {
      type: "settled",
      scope: draft.scope,
      requestId: "send-1",
      success: false,
      error: "Disconnected",
    });
    expect(failed).toEqual({ scope: draft.scope, pendingRequestId: null, error: "Disconnected" });
    expect(
      botComposerReducer(failed, { type: "send", requestId: "send-2", hasContent: true }).error,
    ).toBeNull();
  });

  it("ignores stale completions and duplicate or empty sends", () => {
    for (const scope of ["environment-a:bot-b", "environment-b:bot-a"]) {
      expect(
        botComposerReducer(pending, {
          type: "settled",
          scope,
          requestId: "send-1",
          success: true,
          error: null,
        }),
      ).toBe(pending);
    }
    expect(
      botComposerReducer(pending, {
        type: "settled",
        scope: draft.scope,
        requestId: "old",
        success: true,
        error: null,
      }),
    ).toBe(pending);
    expect(
      botComposerReducer(pending, { type: "send", requestId: "duplicate", hasContent: true }),
    ).toBe(pending);
    expect(botComposerReducer(draft, { type: "send", requestId: "empty", hasContent: false })).toBe(
      draft,
    );
    expect(
      botComposerReducer(pending, {
        type: "settled",
        scope: draft.scope,
        requestId: "send-1",
        success: true,
        error: null,
      }),
    ).toEqual(draft);
  });
});

describe("bot thread links", () => {
  it("resolves known cross-environment targets and rejects unknown or malformed links", () => {
    expect(botThreadLinkTarget("t3-thread://v1/remote/thread%201", ["local", "remote"])).toEqual({
      environmentId: "remote",
      threadId: "thread 1",
    });
    expect(botThreadLinkTarget("https://t3.invalid/remote/mcp%3Areviewer", ["remote"])).toEqual({
      environmentId: "remote",
      threadId: "mcp:reviewer",
    });
    expect(botThreadLinkTarget("t3-thread://v1/unknown/thread", ["local"])).toBeNull();
    expect(botThreadLinkTarget("https://example.com/local/thread", ["local"])).toBeNull();
    expect(botThreadLinkTarget("t3-thread://v1/local/%ZZ", ["local"])).toBeNull();
  });

  it("renders unknown thread links as their text while retaining known and external links", () => {
    expect(
      botMarkdownThreadLinks(
        "[Unknown](https://t3.invalid/unknown/thread) [Remote](https://t3.invalid/remote/thread) [Web](https://example.com)",
        ["remote"],
      ),
    ).toBe("Unknown [Remote](https://t3.invalid/remote/thread) [Web](https://example.com)");
  });
});

describe("bot send ownership", () => {
  it("retains a pending send and its result after the chat leaves", () => {
    const registry = AtomRegistry.make();
    const atom = botComposerAtom("background-send");
    const stop = registry.subscribe(atom, () => {});
    try {
      registry.set(
        atom,
        botComposerReducer(registry.get(atom), {
          type: "send",
          requestId: "send",
          hasContent: true,
        }),
      );
      stop();
      expect(registry.get(botComposerAtom("background-send")).pendingRequestId).toBe("send");
      registry.set(
        atom,
        botComposerReducer(registry.get(atom), {
          type: "settled",
          scope: "background-send",
          requestId: "send",
          success: false,
          error: "Offline",
        }),
      );
      expect(registry.get(botComposerAtom("background-send"))).toEqual({
        scope: "background-send",
        pendingRequestId: null,
        error: "Offline",
      });
      expect(registry.get(botComposerAtom("other-chat")).pendingRequestId).toBeNull();
    } finally {
      stop();
      registry.dispose();
    }
  });

  it("clears only the sent draft and ignores upload metadata changes", () => {
    const sent = { text: "hello", attachments: [{ id: "image" }] };
    const uploaded = { id: "image", uploadedAttachmentId: "upload" };
    expect(isBotSendDraftUnchanged(sent, { ...sent, attachments: [uploaded] })).toBe(true);
    expect(isBotSendDraftUnchanged(sent, { ...sent, text: "new draft" })).toBe(false);
    expect(isBotSendDraftUnchanged(sent, { ...sent, attachments: [] })).toBe(false);
    expect(isBotSendDraftUnchanged(sent, { ...sent, attachments: [{ id: "new image" }] })).toBe(
      false,
    );
    expect(
      isBotSendDraftUnchanged(sent, { ...sent, attachments: [uploaded, { id: "new image" }] }),
    ).toBe(false);
  });
});
