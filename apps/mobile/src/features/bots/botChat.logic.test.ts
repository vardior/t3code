import { describe, expect, it } from "vite-plus/test";

import { botComposerReducer, botStatusLabel, initialBotComposer } from "./botChat.logic";

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

describe("bot text submission", () => {
  const draft = botComposerReducer(initialBotComposer("environment-a:bot-a"), {
    type: "edit",
    text: "  Check the bots  ",
  });
  const pending = botComposerReducer(draft, { type: "send", requestId: "send-1" });

  it("retains the draft on command failure and allows retry", () => {
    const failed = botComposerReducer(pending, {
      type: "settled",
      scope: draft.scope,
      requestId: "send-1",
      success: false,
      error: "Disconnected",
    });
    expect(failed).toMatchObject({
      text: draft.text,
      pendingRequestId: null,
      error: "Disconnected",
    });
    expect(botComposerReducer(failed, { type: "send", requestId: "send-2" })).toMatchObject({
      text: draft.text,
      pendingRequestId: "send-2",
      error: null,
    });
  });

  it("clears the draft only after the queued command succeeds", () => {
    expect(
      botComposerReducer(pending, {
        type: "settled",
        scope: draft.scope,
        requestId: "send-1",
        success: true,
        error: null,
      }),
    ).toMatchObject({ text: "", pendingRequestId: null, error: null });
  });

  it("ignores completion from another bot, environment, or request", () => {
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
        requestId: "older-send",
        success: true,
        error: null,
      }),
    ).toBe(pending);
  });

  it("blocks duplicate sends and draft replacement during submission", () => {
    expect(botComposerReducer(pending, { type: "send", requestId: "send-2" })).toBe(pending);
    expect(botComposerReducer(pending, { type: "edit", text: "another draft" })).toBe(pending);
    const empty = initialBotComposer(draft.scope);
    expect(botComposerReducer(empty, { type: "send", requestId: "empty" })).toBe(empty);
  });
});
