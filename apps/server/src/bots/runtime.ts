import * as Layer from "effect/Layer";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as BotAutoCompaction from "./BotAutoCompaction.ts";
import * as BotRouter from "./BotRouter.ts";
import * as BotService from "./BotService.ts";

export const layer = BotService.layer;

export const routerLayer = BotRouter.layer;

export const workerLive = BotAutoCompaction.workerLive.pipe(
  Layer.provideMerge(BotAutoCompaction.layer),
  Layer.provide(layer),
  Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
);
