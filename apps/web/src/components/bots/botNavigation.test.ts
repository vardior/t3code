import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseBotsSearch,
  resolveBotSelection,
  resolveThreadDestination,
  shouldSuppressThreadNotification,
} from "./botNavigation";

const bots = [
  { environmentId: EnvironmentId.make("ssh"), bot: { id: "helper" } },
  { environmentId: EnvironmentId.make("relay"), bot: { id: "helper" } },
];

describe("Bots route search", () => {
  it("accepts qualified and legacy links and drops invalid values", () => {
    expect(parseBotsSearch({ env: "ssh", bot: "helper" })).toEqual({ env: "ssh", bot: "helper" });
    expect(parseBotsSearch({ bot: "helper" })).toEqual({ bot: "helper" });
    expect(parseBotsSearch({ env: 1, bot: "  " })).toEqual({});
  });
  it("resolves legacy links across connected environments", () => {
    expect(resolveBotSelection(bots, { bot: "helper" })).toBe(bots[0]);
  });
  it("keeps identical bot ids scoped to their environment", () => {
    expect(resolveBotSelection(bots, { env: "relay", bot: "helper" })).toBe(bots[1]);
    expect(resolveBotSelection(bots, { env: "unknown", bot: "helper" })).toBeNull();
    expect(resolveBotSelection(bots, { bot: "deleted" })).toBeNull();
    expect(resolveBotSelection(bots, {})).toBeNull();
  });
});

const threadId = ThreadId.make("home");
const botEntries = bots.map((entry) => ({
  ...entry,
  bot: { ...entry.bot, homeThreadId: threadId },
}));

describe("thread destinations", () => {
  it("opens bot home threads in the matching environment", () => {
    expect(
      resolveThreadDestination(scopeThreadRef(EnvironmentId.make("relay"), threadId), botEntries),
    ).toEqual({ to: "/bots", search: { env: "relay", bot: "helper" } });
  });
  it("keeps workers and unrelated environments on their thread route", () => {
    for (const ref of [
      scopeThreadRef(EnvironmentId.make("relay"), ThreadId.make("worker")),
      scopeThreadRef(EnvironmentId.make("other"), threadId),
    ]) {
      expect(resolveThreadDestination(ref, botEntries)).toEqual({
        to: "/$environmentId/$threadId",
        params: ref,
      });
    }
  });
});

describe("bot notification suppression", () => {
  it("allows notifications while bot identity is unknown", () => {
    expect(shouldSuppressThreadNotification(false, undefined, "home")).toBe(false);
  });
  it("always notifies bot home threads", () => {
    expect(shouldSuppressThreadNotification(false, [{ homeThreadId: "home" }], "home")).toBe(false);
  });
  it("suppresses known non-bots only when agent notifications are disabled", () => {
    expect(shouldSuppressThreadNotification(false, [], "worker")).toBe(true);
    expect(shouldSuppressThreadNotification(true, [], "worker")).toBe(false);
  });
});
