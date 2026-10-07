import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { resolveThreadDestination } from "./botNavigation";

export function useThreadDestination() {
  return useCallback((threadRef: ScopedThreadRef) => {
    const result = appAtomRegistry.get(
      serverEnvironment.bots.list({ environmentId: threadRef.environmentId, input: {} }),
    );
    const bots = Option.getOrNull(AsyncResult.value(result))?.bots ?? [];
    return resolveThreadDestination(
      threadRef,
      bots.map((bot) => ({ environmentId: threadRef.environmentId, bot })),
    );
  }, []);
}
