import { useFocusEffect } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";
import { AppState } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useBots(environmentId: EnvironmentId) {
  const query = useEnvironmentQuery(serverEnvironment.bots.list({ environmentId, input: {} }));
  const refresh = query.refresh;
  useFocusEffect(
    useCallback(() => {
      refresh();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => subscription.remove();
    }, [refresh]),
  );
  return query;
}

export function useBotRunSettlement(working: boolean, refresh: () => void) {
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) refresh();
    wasWorking.current = working;
  }, [working, refresh]);
}
