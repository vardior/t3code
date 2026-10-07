import { describe, expect, it } from "vite-plus/test";

import { botThreadLinkTarget, botMarkdownThreadLinks, botStatusLabel } from "./botChat.logic";

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
