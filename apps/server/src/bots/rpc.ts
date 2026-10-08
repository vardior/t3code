import {
  type BotGetInput,
  type BotReorderInput,
  type BotListInput,
  type BotRouteInput,
  type BotSetPausedInput,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";

import type * as BotRouter from "./BotRouter.ts";
import type * as BotService from "./BotService.ts";

export const makeHandlers = (
  bots: Context.Service.Shape<typeof BotService.BotService>,
  router: Context.Service.Shape<typeof BotRouter.BotRouter>,
) => ({
  [WS_METHODS.botsSubscribeChanges]: (_input: BotListInput) => bots.streamChanges,
  [WS_METHODS.botsGet]: (input: BotGetInput) => bots.get(input),
  [WS_METHODS.botsList]: (_input: BotListInput) => bots.list(),
  [WS_METHODS.botsReorder]: (input: BotReorderInput) => bots.reorderBots(input.names),
  [WS_METHODS.botsRoute]: (input: BotRouteInput) => router.route(input.text),
  [WS_METHODS.botsSetPaused]: (input: BotSetPausedInput) => bots.setPaused(input),
  [WS_METHODS.botsMorning]: (_input: BotListInput) => bots.morning(),
});
