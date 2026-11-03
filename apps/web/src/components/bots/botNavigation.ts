import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

export function parseBotsSearch(raw: Record<string, unknown>): { env?: string; bot?: string } {
  return {
    ...(typeof raw.env === "string" && raw.env.trim() ? { env: raw.env } : {}),
    ...(typeof raw.bot === "string" && raw.bot.trim() ? { bot: raw.bot } : {}),
  };
}

export function resolveBotSelection<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly bot: { readonly id: string };
  },
>(
  bots: ReadonlyArray<T>,
  search: { readonly env?: string | undefined; readonly bot?: string | undefined },
): T | null {
  if (!search.bot) return null;
  return (
    bots.find(
      (entry) =>
        entry.bot.id === search.bot &&
        (search.env === undefined || entry.environmentId === search.env),
    ) ?? null
  );
}

export function resolveThreadDestination(
  threadRef: ScopedThreadRef,
  bots: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly bot: { readonly id: string; readonly homeThreadId: string };
  }>,
) {
  const entry = bots.find(
    ({ environmentId, bot }) =>
      environmentId === threadRef.environmentId && bot.homeThreadId === threadRef.threadId,
  );
  return entry
    ? { to: "/bots" as const, search: { env: entry.environmentId, bot: entry.bot.id } }
    : { to: "/$environmentId/$threadId" as const, params: threadRef };
}

export function shouldSuppressThreadNotification(
  notifyAgentThreads: boolean,
  bots: ReadonlyArray<{ readonly homeThreadId: string }> | undefined,
  threadId: string,
) {
  return (
    !notifyAgentThreads && bots !== undefined && !bots.some((bot) => bot.homeThreadId === threadId)
  );
}

export function parseBotsSidebarSearch(raw: Record<string, unknown>): { sidebar?: "bots" } {
  return raw.sidebar === "bots" ? { sidebar: "bots" } : {};
}

export function isBotsSidebarLocation(location: {
  readonly pathname: string;
  readonly search: Record<string, unknown>;
}) {
  return (
    location.pathname === "/bots" || parseBotsSidebarSearch(location.search).sidebar === "bots"
  );
}

export function pinnedThreadDestination(threadRef: ScopedThreadRef) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: threadRef,
    search: { sidebar: "bots" as const },
  };
}
