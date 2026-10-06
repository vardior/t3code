import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { parseBotsSearch, resolveBotSelection } from "./botNavigation";

const bots = [
  { environmentId: EnvironmentId.make("ssh"), bot: { id: "helper" } },
  { environmentId: EnvironmentId.make("relay"), bot: { id: "helper" } },
];

describe("Bots route search", () => {
  it("accepts qualified and legacy links and drops invalid values", () => {
    expect(parseBotsSearch({ env: "ssh", bot: "helper" })).toEqual({ env: "ssh", bot: "helper" });
    expect(parseBotsSearch({ bot: "helper" })).toEqual({ bot: "helper" });
    expect(parseBotsSearch({ env: 1, bot: "  " })).toEqual({});
  });
  it("resolves legacy links across connected environments", () => {
    expect(resolveBotSelection(bots, { bot: "helper" })).toBe(bots[0]);
  });
  it("keeps identical bot ids scoped to their environment", () => {
    expect(resolveBotSelection(bots, { env: "relay", bot: "helper" })).toBe(bots[1]);
    expect(resolveBotSelection(bots, { env: "unknown", bot: "helper" })).toBeNull();
    expect(resolveBotSelection(bots, { bot: "deleted" })).toBeNull();
    expect(resolveBotSelection(bots, {})).toBeNull();
  });
});
