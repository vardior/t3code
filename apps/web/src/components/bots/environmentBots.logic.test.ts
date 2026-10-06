import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { retainEnvironmentBotQueries } from "./environmentBots.logic";

const environmentId = EnvironmentId.make("laptop");
const bot = {
  id: "helper",
  name: "Helper",
  homeThreadId: ThreadId.make("home"),
  scheduledTaskIds: [],
  paused: false,
};
const previous = [{ environmentId, supported: true, data: { bots: [bot] } }];

describe("environment bot retention", () => {
  it("keeps the last list and capability while a known environment reconnects", () => {
    const reconnecting = { environmentId, supported: false, data: null, isLoading: true };
    const retained = retainEnvironmentBotQueries([reconnecting], previous);
    expect(retained).toEqual([{ ...reconnecting, supported: true, data: previous[0]!.data }]);
    expect(retained[0]!.data).toBe(previous[0]!.data);
    expect(retainEnvironmentBotQueries([reconnecting], retained)[0]!.data).toBe(previous[0]!.data);
  });

  it("accepts a fresh empty list or revoked bot support", () => {
    for (const supported of [true, false]) {
      const fresh = { environmentId, supported, data: { bots: [] } };
      expect(retainEnvironmentBotQueries([fresh], previous)[0]).toBe(fresh);
    }
  });

  it("drops removed environments and never borrows another environment's list", () => {
    expect(retainEnvironmentBotQueries([], previous)).toEqual([]);
    const unknown = { environmentId: EnvironmentId.make("other"), supported: false, data: null };
    expect(retainEnvironmentBotQueries([unknown], previous)).toEqual([unknown]);
  });
});
