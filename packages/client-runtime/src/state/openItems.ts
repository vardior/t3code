import type { OpenItem } from "@t3tools/contracts";

export interface OpenItemGroups {
  readonly open: ReadonlyArray<OpenItem>;
  readonly resolved: ReadonlyArray<OpenItem>;
}

const EMPTY_GROUPS: OpenItemGroups = { open: [], resolved: [] };

export function groupOpenItems(items: ReadonlyArray<OpenItem>): OpenItemGroups {
  if (items.length === 0) return EMPTY_GROUPS;
  return {
    open: items
      .filter((item) => item.status === "open")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    resolved: items
      .filter((item) => item.status !== "open")
      .sort((left, right) => (right.resolvedAt ?? "").localeCompare(left.resolvedAt ?? "")),
  };
}

export function countOpenItems(items: ReadonlyArray<OpenItem> | undefined): number {
  let count = 0;
  for (const item of items ?? []) if (item.status === "open") count += 1;
  return count;
}

export function openItemIds(items: ReadonlyArray<OpenItem>): ReadonlySet<string> {
  return new Set(items.flatMap((item) => (item.status === "open" ? [item.id] : [])));
}

export function hasUnseenOpenItem(
  seen: ReadonlySet<string>,
  items: ReadonlyArray<OpenItem>,
): boolean {
  return items.some((item) => item.status === "open" && !seen.has(item.id));
}

const RECENTLY_RESOLVED_MS = 24 * 60 * 60 * 1000;

export function hasRecentlyResolvedOpenItem(
  items: ReadonlyArray<OpenItem> | undefined,
  nowMs: number,
): boolean {
  return (items ?? []).some(
    (item) =>
      item.resolvedAt !== null && nowMs - Date.parse(item.resolvedAt) < RECENTLY_RESOLVED_MS,
  );
}
