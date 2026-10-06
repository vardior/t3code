import type { EnvironmentId } from "@t3tools/contracts";

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
>(bots: ReadonlyArray<T>, search: { readonly env?: string; readonly bot?: string }): T | null {
  if (!search.bot) return null;
  return (
    bots.find(
      (entry) =>
        entry.bot.id === search.bot &&
        (search.env === undefined || entry.environmentId === search.env),
    ) ?? null
  );
}
