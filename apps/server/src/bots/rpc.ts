import {
  type BotGetInput,
  type BotListInput,
  type BotSetPausedInput,
  WS_METHODS,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";

import type * as BotService from "./BotService.ts";

export const makeHandlers = (bots: Context.Service.Shape<typeof BotService.BotService>) => ({
  [WS_METHODS.botsGet]: (input: BotGetInput) => bots.get(input),
  [WS_METHODS.botsList]: (_input: BotListInput) => bots.list(),
  [WS_METHODS.botsSetPaused]: (input: BotSetPausedInput) => bots.setPaused(input),
});
