import { describe, expect, it } from "vite-plus/test";

import { botNeedsYou, botVisitWatermark } from "./botConversation.ts";

const reply = { lastReply: { text: "Can you review this?", at: "2026-10-07T10:00:00.000Z" } };
const shell = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  lastVisitedAt: "2026-10-07T10:01:00.000Z",
};

describe("botNeedsYou", () => {
  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "needs the owner for %s even without an unread reply",
    (request) => {
      expect(botNeedsYou(reply, { ...shell, [request]: true })).toBe(true);
      expect(botNeedsYou({ lastReply: null }, { ...shell, [request]: true })).toBe(true);
    },
  );

  it("needs the owner when the latest reply is newer than the visit", () => {
    expect(botNeedsYou(reply, { ...shell, lastVisitedAt: "2026-10-07T09:59:00.000Z" })).toBe(true);
  });

  it.each([reply.lastReply.at, shell.lastVisitedAt])(
    "does not need the owner after a visit at %s",
    (lastVisitedAt) => {
      expect(botNeedsYou(reply, { ...shell, lastVisitedAt })).toBe(false);
    },
  );

  it.each([{}, { lastReply: null }])("does not flag a bot without a reply", (bot) => {
    expect(botNeedsYou(bot, shell)).toBe(false);
  });

  it.each([null, "invalid"])(
    "treats a reply as unread without a valid visit (%s)",
    (lastVisitedAt) => {
      expect(botNeedsYou(reply, { ...shell, lastVisitedAt })).toBe(true);
    },
  );

  it("treats a reply as unread when the visit watermark is omitted", () => {
    expect(botNeedsYou(reply, { hasPendingApprovals: false, hasPendingUserInput: false })).toBe(
      true,
    );
  });

  it("treats a reply as unread before its home thread shell arrives", () => {
    expect(botNeedsYou(reply, undefined)).toBe(true);
    expect(botNeedsYou(reply, null)).toBe(true);
    expect(botNeedsYou({}, null)).toBe(false);
  });

  it("ignores a reply with an invalid timestamp", () => {
    expect(botNeedsYou({ lastReply: { text: "Hello", at: "invalid" } }, shell)).toBe(false);
  });
});

describe("botVisitWatermark", () => {
  it("visits at the latest reply when the thread timestamp lags", () => {
    expect(botVisitWatermark("2026-10-07T09:00:00.000Z", "2026-10-07T10:00:00.000Z")).toBe(
      "2026-10-07T10:00:00.000Z",
    );
    expect(
      botNeedsYou(reply, {
        ...shell,
        lastVisitedAt: botVisitWatermark("2026-10-07T09:00:00.000Z", reply.lastReply.at),
      }),
    ).toBe(false);
  });

  it("keeps the thread timestamp when it is newer or there is no reply", () => {
    expect(botVisitWatermark("2026-10-07T11:00:00.000Z", "2026-10-07T10:00:00.000Z")).toBe(
      "2026-10-07T11:00:00.000Z",
    );
    expect(botVisitWatermark("2026-10-07T11:00:00.000Z", undefined)).toBe(
      "2026-10-07T11:00:00.000Z",
    );
    expect(botVisitWatermark(null, "2026-10-07T10:00:00.000Z")).toBeNull();
  });
});
