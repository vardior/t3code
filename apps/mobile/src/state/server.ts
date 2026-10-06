import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import {
  createOutdatedServerDescriptionCommand,
  createOutdatedServerUpdateCommand,
} from "@t3tools/client-runtime/state/outdatedServerUpdate";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { persistNotificationBots } from "../features/agent-awareness/notificationBotCache";
import { environmentSession } from "./session";

const serverAtoms = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
  usageLimitSources: true,
  usageLimitsCommand: true,
  providerCatalogsOnDemand: true,
});
const botListAtom = Atom.family((environmentId: EnvironmentId) =>
  persistNotificationBots(environmentId, serverAtoms.bots.list({ environmentId, input: {} })),
);
export const serverEnvironment = {
  ...serverAtoms,
  bots: {
    ...serverAtoms.bots,
    list: (target: Parameters<typeof serverAtoms.bots.list>[0]) =>
      botListAtom(target.environmentId),
  },
};
export const describeOutdatedServer = createOutdatedServerDescriptionCommand(connectionAtomRuntime);
export const updateOutdatedServer = createOutdatedServerUpdateCommand(connectionAtomRuntime);
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
