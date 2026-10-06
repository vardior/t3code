import type { BotListResult, EnvironmentId } from "@t3tools/contracts";

type EnvironmentBotQueryData = {
  readonly environmentId: EnvironmentId;
  readonly data: BotListResult | null;
  readonly supported: boolean;
};

export function retainEnvironmentBotQueries<T extends EnvironmentBotQueryData>(
  queries: ReadonlyArray<T>,
  previous: ReadonlyArray<EnvironmentBotQueryData>,
) {
  const previousById = new Map(previous.map((query) => [query.environmentId, query]));
  return queries.map((query) => {
    if (query.data !== null) return query;
    const retained = previousById.get(query.environmentId);
    return retained
      ? { ...query, data: retained.data, supported: query.supported || retained.supported }
      : query;
  });
}
