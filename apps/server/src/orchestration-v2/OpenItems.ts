import {
  OPEN_ITEM_MAX_OPEN_PER_THREAD,
  OPEN_ITEM_MAX_RESOLVED_PER_THREAD,
  type IsoDateTime,
  type OpenItem,
  type OpenItemContent,
  type OpenItemFailureReason,
  type OpenItemId,
  type OpenItemPatch,
  type OpenItemResolvedStatus,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";

export type OpenItemChange =
  | { readonly type: "add"; readonly itemId: OpenItemId; readonly content: OpenItemContent }
  | { readonly type: "update"; readonly itemId: OpenItemId; readonly patch: OpenItemPatch }
  | {
      readonly type: "resolve";
      readonly itemId: OpenItemId;
      readonly status: OpenItemResolvedStatus;
      readonly answer?: string | undefined;
    }
  | { readonly type: "reopen"; readonly itemId: OpenItemId };

export type OpenItemPlan =
  | { readonly ok: true; readonly items: ReadonlyArray<OpenItem>; readonly item: OpenItem }
  | { readonly ok: false; readonly reason: OpenItemFailureReason };

type OpenItemThread = Pick<
  OrchestrationV2AppThread,
  "id" | "openItems" | "archivedAt" | "deletedAt"
>;

const rejected = (reason: OpenItemFailureReason): OpenItemPlan => ({ ok: false, reason });

function withOptional<K extends "detail" | "options" | "recommended" | "defaultOnSilence">(
  item: OpenItem,
  key: K,
  value: OpenItem[K] | null | undefined,
): OpenItem {
  if (value === undefined) return item;
  const { [key]: _previous, ...rest } = item;
  return (value === null ? rest : { ...rest, [key]: value }) as OpenItem;
}

function keepRecentResolved(items: ReadonlyArray<OpenItem>): ReadonlyArray<OpenItem> {
  const kept = new Set(
    items
      .filter((item) => item.status !== "open")
      .toSorted((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? ""))
      .slice(0, OPEN_ITEM_MAX_RESOLVED_PER_THREAD),
  );
  return items.filter((item) => item.status === "open" || kept.has(item));
}

export function planOpenItemChange(
  thread: OpenItemThread,
  change: OpenItemChange,
  now: IsoDateTime,
): OpenItemPlan {
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    return rejected("thread_unavailable");
  }
  const items = thread.openItems ?? [];
  const existing = items.find((item) => item.id === change.itemId);

  if (change.type === "add") {
    if (existing !== undefined) return { ok: true, items, item: existing };
    if (items.filter((item) => item.status === "open").length >= OPEN_ITEM_MAX_OPEN_PER_THREAD) {
      return rejected("too_many_open");
    }
    const item: OpenItem = {
      ...change.content,
      id: change.itemId,
      threadId: thread.id,
      status: "open",
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    };
    return { ok: true, items: [...items, item], item };
  }

  if (existing === undefined) return rejected("not_found");

  let item: OpenItem;
  switch (change.type) {
    case "update": {
      if (existing.status !== "open") return rejected("not_open");
      item = {
        ...existing,
        ...(change.patch.title === undefined ? {} : { title: change.patch.title }),
      };
      item = withOptional(item, "detail", change.patch.detail);
      item = withOptional(item, "options", change.patch.options);
      item = withOptional(item, "recommended", change.patch.recommended);
      item = withOptional(item, "defaultOnSilence", change.patch.defaultOnSilence);
      if (item.recommended !== undefined && !(item.options ?? []).includes(item.recommended)) {
        return rejected("invalid_recommended");
      }
      item = { ...item, updatedAt: now };
      break;
    }
    case "resolve": {
      if (existing.status !== "open") return rejected("not_open");
      const { answer: _previous, ...rest } = existing;
      item = {
        ...rest,
        ...(change.answer === undefined ? {} : { answer: change.answer }),
        status: change.status,
        updatedAt: now,
        resolvedAt: now,
      };
      break;
    }
    case "reopen": {
      if (existing.status === "open") return rejected("not_resolved");
      if (
        items.filter((entry) => entry.status === "open").length >= OPEN_ITEM_MAX_OPEN_PER_THREAD
      ) {
        return rejected("too_many_open");
      }
      const { answer: _answer, ...rest } = existing;
      item = { ...rest, status: "open", updatedAt: now, resolvedAt: null };
      break;
    }
  }
  return {
    ok: true,
    items: keepRecentResolved(items.map((entry) => (entry === existing ? item : entry))),
    item,
  };
}
