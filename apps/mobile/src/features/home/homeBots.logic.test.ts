import { BotSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { homeBotsState } from "./homeBots.logic";

const refresh = () => {};
const environmentId = EnvironmentId.make("environment-a");

describe("home bots query state", () => {
  it("keeps loading and genuinely empty queries hidden", () => {
    for (const data of [null, { bots: [] }]) {
      expect(homeBotsState([{ environmentId, data, error: null, refresh }])).toEqual({
        bots: [],
        errors: [],
      });
    }
  });

  it("preserves a failed environment and its retry alongside successful queries", () => {
    const bot = BotSummary.make({
      id: "bot-a",
      name: "Assistant",
      homeThreadId: ThreadId.make("thread-a"),
      scheduledTaskIds: [],
      paused: false,
      charter: null,
      workers: [],
      slackDms: [],
    });
    const otherEnvironmentId = EnvironmentId.make("environment-b");
    const state = homeBotsState([
      { environmentId, data: null, error: "Disconnected", refresh },
      {
        environmentId: otherEnvironmentId,
        data: { bots: [bot] },
        error: null,
        refresh,
      },
    ]);
    expect(state.bots).toEqual([{ environmentId: otherEnvironmentId, bot, refresh }]);
    expect(state.errors).toEqual([{ environmentId, error: "Disconnected", refresh }]);
    expect(state.errors[0]?.refresh).toBe(refresh);
  });
});
