import { describe, expect, it } from "@effect/vitest";
import {
  OPEN_ITEM_MAX_OPEN_PER_THREAD,
  OPEN_ITEM_MAX_RESOLVED_PER_THREAD,
  OpenItemId,
  ThreadId,
  type OpenItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { planOpenItemChange } from "./OpenItems.ts";

const threadId = ThreadId.make("thread-open-items");
const itemId = OpenItemId.make("item-1");
const thread = (openItems: ReadonlyArray<OpenItem> = []) => ({
  id: threadId,
  openItems,
  archivedAt: null,
  deletedAt: null,
});
const openItem = (id: string, overrides: Partial<OpenItem> = {}): OpenItem => ({
  id: OpenItemId.make(id),
  threadId,
  title: `Item ${id}`,
  status: "open",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  resolvedAt: null,
  ...overrides,
});
const accepted = (plan: ReturnType<typeof planOpenItemChange>) => {
  if (!plan.ok) throw new Error(`rejected: ${plan.reason}`);
  return plan;
};

describe("planOpenItemChange", () => {
  it("adds an open item stamped with the thread and time", () => {
    const plan = accepted(
      planOpenItemChange(
        thread(),
        {
          type: "add",
          itemId,
          content: { title: "Ship it?", options: ["Yes", "No"], recommended: "Yes" },
        },
        "2026-10-07T10:00:00.000Z",
      ),
    );
    expect(plan.item).toEqual({
      id: itemId,
      threadId,
      title: "Ship it?",
      options: ["Yes", "No"],
      recommended: "Yes",
      status: "open",
      createdAt: "2026-10-07T10:00:00.000Z",
      updatedAt: "2026-10-07T10:00:00.000Z",
      resolvedAt: null,
    });
    expect(plan.items).toEqual([plan.item]);
  });

  it("caps open items per thread", () => {
    const full = Array.from({ length: OPEN_ITEM_MAX_OPEN_PER_THREAD }, (_, index) =>
      openItem(`open-${index}`),
    );
    expect(
      planOpenItemChange(
        thread(full),
        { type: "add", itemId, content: { title: "One more" } },
        "2026-10-07T10:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "too_many_open" });
  });

  it("updates fields, clears nulls, and keeps recommended among options", () => {
    const existing = openItem("item-1", {
      detail: "Old detail",
      options: ["A", "B"],
      recommended: "A",
    });
    const plan = accepted(
      planOpenItemChange(
        thread([existing]),
        {
          type: "update",
          itemId,
          patch: { title: "New title", detail: null, options: ["B", "C"], recommended: "C" },
        },
        "2026-10-07T11:00:00.000Z",
      ),
    );
    const { detail: _detail, ...withoutDetail } = existing;
    expect(plan.item).toStrictEqual({
      ...withoutDetail,
      title: "New title",
      options: ["B", "C"],
      recommended: "C",
      updatedAt: "2026-10-07T11:00:00.000Z",
    });
    expect(
      planOpenItemChange(
        thread([existing]),
        { type: "update", itemId, patch: { options: ["B"] } },
        "2026-10-07T11:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "invalid_recommended" });
  });

  it("resolves an open item once and reopens it without its answer", () => {
    const answered = accepted(
      planOpenItemChange(
        thread([openItem("item-1")]),
        { type: "resolve", itemId, status: "answered", answer: "Yes" },
        "2026-10-07T12:00:00.000Z",
      ),
    );
    expect(answered.item).toMatchObject({
      status: "answered",
      answer: "Yes",
      resolvedAt: "2026-10-07T12:00:00.000Z",
    });
    expect(
      planOpenItemChange(
        thread(answered.items),
        { type: "resolve", itemId, status: "dropped" },
        "2026-10-07T12:01:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "not_open" });
    expect(
      planOpenItemChange(
        thread(answered.items),
        { type: "update", itemId, patch: { title: "Too late" } },
        "2026-10-07T12:01:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "not_open" });

    const reopened = accepted(
      planOpenItemChange(
        thread(answered.items),
        { type: "reopen", itemId },
        "2026-10-07T13:00:00.000Z",
      ),
    );
    expect(reopened.item.status).toBe("open");
    expect(reopened.item.resolvedAt).toBeNull();
    expect("answer" in reopened.item).toBe(false);
    expect(
      planOpenItemChange(
        thread(reopened.items),
        { type: "reopen", itemId },
        "2026-10-07T13:01:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "not_resolved" });
  });

  it("keeps only the most recently resolved items", () => {
    const resolved = Array.from({ length: OPEN_ITEM_MAX_RESOLVED_PER_THREAD }, (_, index) =>
      openItem(`done-${index}`, {
        status: "dropped",
        resolvedAt: `2026-10-01T0${index}:00:00.000Z`,
      }),
    );
    const plan = accepted(
      planOpenItemChange(
        thread([...resolved, openItem("item-1")]),
        { type: "resolve", itemId, status: "dropped" },
        "2026-10-07T00:00:00.000Z",
      ),
    );
    expect(plan.items.map((item) => item.id)).toEqual([
      ...resolved.slice(1).map((item) => item.id),
      itemId,
    ]);
  });

  it("rejects changes on archived threads and unknown items", () => {
    expect(
      planOpenItemChange(
        { ...thread(), archivedAt: DateTime.nowUnsafe() },
        { type: "add", itemId, content: { title: "Archived" } },
        "2026-10-07T00:00:00.000Z",
      ),
    ).toEqual({ ok: false, reason: "thread_unavailable" });
    expect(
      planOpenItemChange(thread(), { type: "reopen", itemId }, "2026-10-07T00:00:00.000Z"),
    ).toEqual({ ok: false, reason: "not_found" });
  });
});
