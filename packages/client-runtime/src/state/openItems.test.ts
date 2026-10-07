import { OpenItemId, ThreadId, type OpenItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { countOpenItems, groupOpenItems, hasUnseenOpenItem, openItemIds } from "./openItems.ts";

const item = (id: string, status: OpenItem["status"], at: string): OpenItem => ({
  id: OpenItemId.make(id),
  threadId: ThreadId.make("thread"),
  title: id,
  status,
  createdAt: at,
  updatedAt: at,
  resolvedAt: status === "open" ? null : at,
});

describe("open items", () => {
  const items = [
    item("later", "open", "2026-10-07T11:00:00.000Z"),
    item("old-answer", "answered", "2026-10-07T08:00:00.000Z"),
    item("earlier", "open", "2026-10-07T10:00:00.000Z"),
    item("new-drop", "dropped", "2026-10-07T12:00:00.000Z"),
  ];

  it("lists open items oldest first and resolved items newest first", () => {
    const groups = groupOpenItems(items);
    expect(groups.open.map((entry) => entry.id)).toEqual(["earlier", "later"]);
    expect(groups.resolved.map((entry) => entry.id)).toEqual(["new-drop", "old-answer"]);
    expect(countOpenItems(items)).toBe(2);
    expect(countOpenItems(undefined)).toBe(0);
  });

  it("notices an open item that was not open before", () => {
    const seen = openItemIds(items);
    expect(hasUnseenOpenItem(seen, items)).toBe(false);
    expect(
      hasUnseenOpenItem(seen, [...items, item("fresh", "open", "2026-10-07T13:00:00.000Z")]),
    ).toBe(true);
    expect(
      hasUnseenOpenItem(seen, [
        ...items.filter((entry) => entry.id !== "old-answer"),
        item("old-answer", "open", "2026-10-07T08:00:00.000Z"),
      ]),
    ).toBe(true);
  });
});
