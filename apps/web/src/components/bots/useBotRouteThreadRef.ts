import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { parseBotsSearch } from "./botNavigation";

export function useBotRouteThreadRef(): ScopedThreadRef | null {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const selection = useLocation({
    select: (location) => {
      if (location.pathname !== "/bots") return null;
      const search = parseBotsSearch(location.search as Record<string, unknown>);
      return search.bot ? `${search.env ?? ""}\0${search.bot}` : null;
    },
  });
  return useMemo(() => {
    if (selection === null) return null;
    const [env, botId] = selection.split("\0");
    const environmentId = env ? EnvironmentId.make(env) : primaryEnvironmentId;
    if (!environmentId) return null;
    const result = appAtomRegistry.get(serverEnvironment.bots.list({ environmentId, input: {} }));
    const bot = (Option.getOrNull(AsyncResult.value(result))?.bots ?? []).find(
      (entry) => entry.id === botId,
    );
    return bot ? { environmentId, threadId: ThreadId.make(bot.homeThreadId) } : null;
  }, [primaryEnvironmentId, selection]);
}
