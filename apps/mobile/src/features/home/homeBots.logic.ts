import type { BotSummary, EnvironmentId } from "@t3tools/contracts";

export function homeBotsState(
  queries: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly data: { readonly bots: ReadonlyArray<BotSummary> } | null;
    readonly error: string | null;
    readonly refresh: () => void;
  }>,
) {
  return {
    bots: queries.flatMap(
      ({ environmentId, data, refresh }) =>
        data?.bots.map((bot) => ({ environmentId, bot, refresh })) ?? [],
    ),
    errors: queries.flatMap(({ environmentId, error, refresh }) =>
      error === null ? [] : [{ environmentId, error, refresh }],
    ),
  };
}
