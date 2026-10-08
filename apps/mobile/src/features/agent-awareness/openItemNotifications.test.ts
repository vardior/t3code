import { OpenItemError, OpenItemId, ThreadId, type OpenItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type NotifiedShell,
  openItemAnswerActionId,
  openItemAnswerChoices,
  openItemAnswerForAction,
  openItemAnswerOutcome,
  openItemAnswerPrecheck,
  openItemNotificationData,
  openItemNotificationId,
  openItemOutcomeContent,
  planOpenItemNotifications,
  readOpenItemNotificationData,
} from "./openItemNotifications";

function item(overrides: Partial<OpenItem> = {}): OpenItem {
  return {
    id: OpenItemId.make("item-1"),
    threadId: ThreadId.make("thread-1"),
    title: "Ship the release?",
    options: ["Later", "Ship it", "Cancel", "Ask Theo"],
    recommended: "Ship it",
    status: "open",
    createdAt: "2026-10-08T10:00:00.000Z",
    updatedAt: "2026-10-08T10:00:00.000Z",
    resolvedAt: null,
    ...overrides,
  };
}

function shell(openItems: ReadonlyArray<OpenItem>, overrides: Partial<NotifiedShell> = {}) {
  return {
    environmentId: "env-1",
    id: ThreadId.make("thread-1"),
    title: "Release bot",
    archivedAt: null,
    openItems,
    ...overrides,
  } as NotifiedShell;
}

const shownFor = (itemId: string) =>
  new Map([
    [
      openItemNotificationId({ environmentId: "env-1", threadId: "thread-1", itemId }),
      { environmentId: "env-1", threadId: "thread-1", itemId },
    ],
  ]);

describe("openItemAnswerChoices", () => {
  it("puts the recommended option first and keeps at most three", () => {
    expect(openItemAnswerChoices(item())).toEqual(["Ship it", "Later", "Cancel"]);
  });

  it("offers no buttons for an item without options", () => {
    expect(openItemAnswerChoices(item({ options: undefined, recommended: undefined }))).toEqual([]);
  });
});

describe("openItemAnswerForAction", () => {
  const data = openItemNotificationData(shell([item()]), item(), openItemAnswerChoices(item()));

  it("maps an action button back to the option it showed", () => {
    expect(openItemAnswerForAction(data, openItemAnswerActionId(1))).toBe("Later");
  });

  it("ignores the default tap and unknown buttons", () => {
    expect(openItemAnswerForAction(data, "expo.modules.notifications.actions.DEFAULT")).toBeNull();
    expect(openItemAnswerForAction(data, openItemAnswerActionId(5))).toBeNull();
  });

  it("round-trips through notification data without carrying credentials", () => {
    expect(readOpenItemNotificationData(JSON.parse(JSON.stringify(data)))).toEqual(data);
    expect(Object.keys(data).sort()).toEqual(
      ["choices", "deepLink", "environmentId", "itemId", "kind", "threadId", "title"].sort(),
    );
    expect(readOpenItemNotificationData({ deepLink: "/threads/a/b" })).toBeNull();
  });
});

describe("planOpenItemNotifications", () => {
  const base = {
    since: { "env-1": "2026-10-08T09:00:00.000Z" },
    posted: new Set<string>(),
    shown: new Map(),
    notifies: () => true,
  };

  it("posts open items changed after the mark and not yet posted in this version", () => {
    const fresh = item();
    const old = item({ id: OpenItemId.make("item-0"), updatedAt: "2026-10-08T08:00:00.000Z" });
    const plan = planOpenItemNotifications({ ...base, shells: [shell([fresh, old])] });
    expect(plan.post.map((entry) => entry.item.id)).toEqual(["item-1"]);
    expect(
      planOpenItemNotifications({
        ...base,
        shells: [shell([fresh])],
        posted: new Set(["env-1:item-1:2026-10-08T10:00:00.000Z"]),
      }).post,
    ).toEqual([]);
  });

  it("posts an updated item again so it replaces the earlier notification", () => {
    const updated = item({ updatedAt: "2026-10-08T11:00:00.000Z" });
    const plan = planOpenItemNotifications({
      ...base,
      shells: [shell([updated])],
      posted: new Set(["env-1:item-1:2026-10-08T10:00:00.000Z"]),
    });
    expect(plan.post).toHaveLength(1);
  });

  it("starts an environment without a mark silently", () => {
    const plan = planOpenItemNotifications({ ...base, since: {}, shells: [shell([item()])] });
    expect(plan.post).toEqual([]);
    expect(plan.unmarkedEnvironments).toEqual(["env-1"]);
  });

  it("skips archived threads and threads that should not notify", () => {
    expect(
      planOpenItemNotifications({
        ...base,
        shells: [shell([item()], { archivedAt: "2026-10-08T10:30:00.000Z" })],
      }).post,
    ).toEqual([]);
    expect(
      planOpenItemNotifications({ ...base, notifies: () => false, shells: [shell([item()])] }).post,
    ).toEqual([]);
  });

  it("clears notifications for items resolved or removed elsewhere", () => {
    const answered = item({ status: "answered", answer: "Ship it" });
    expect(
      planOpenItemNotifications({ ...base, shown: shownFor("item-1"), shells: [shell([answered])] })
        .clear,
    ).toHaveLength(1);
    expect(
      planOpenItemNotifications({ ...base, shown: shownFor("item-1"), shells: [shell([])] }).clear,
    ).toHaveLength(1);
  });

  it("keeps notifications while their environment has no loaded threads", () => {
    expect(
      planOpenItemNotifications({ ...base, shown: shownFor("item-1"), shells: [] }).clear,
    ).toEqual([]);
    expect(
      planOpenItemNotifications({ ...base, shown: shownFor("item-1"), shells: [shell([item()])] })
        .clear,
    ).toEqual([]);
  });
});

describe("open item answer outcomes", () => {
  const data = openItemNotificationData(shell([item()]), item(), openItemAnswerChoices(item()));

  it("confirms a successful answer", () => {
    const outcome = openItemAnswerOutcome({
      answer: "Ship it",
      result: { _tag: "Success", value: item({ status: "answered", answer: "Ship it" }) },
      current: item(),
    });
    expect(openItemOutcomeContent(data, "Ship it", outcome)).toMatchObject({
      title: "Answered: Ship it",
      data: { kind: "open-item-result", choices: [] },
    });
  });

  it("reports an item already answered elsewhere instead of failing", () => {
    const answered = item({ status: "answered", answer: "Later" });
    const precheck = openItemAnswerPrecheck(answered);
    expect(precheck).toEqual({ type: "already-resolved", status: "answered", answer: "Later" });
    const raced = openItemAnswerOutcome({
      answer: "Ship it",
      result: { _tag: "Failure", error: new OpenItemError({ reason: "not_open" }) },
      current: item({ status: "dropped" }),
    });
    expect(openItemOutcomeContent(data, "Ship it", raced).title).toBe("Already dropped");
    expect(openItemAnswerPrecheck(item())).toBeNull();
  });

  it("reports a deleted item as gone", () => {
    const outcome = openItemAnswerOutcome({
      answer: "Ship it",
      result: { _tag: "Failure", error: new OpenItemError({ reason: "not_found" }) },
      current: undefined,
    });
    expect(outcome).toEqual({ type: "gone" });
  });

  it("turns other failures into a retry notification that keeps the chosen answer", () => {
    const outcome = openItemAnswerOutcome({
      answer: "Ship it",
      result: { _tag: "Failure", error: new Error("Environment env-1 is offline.") },
      current: item(),
    });
    const content = openItemOutcomeContent(data, "Ship it", outcome);
    expect(content.title).toBe("Couldn't answer: Ship it");
    expect(content.body).toContain("Environment env-1 is offline.");
    expect(content.data).toMatchObject({ kind: "open-item-retry", answer: "Ship it" });
  });
});
