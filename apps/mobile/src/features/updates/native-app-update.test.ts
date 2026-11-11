import { describe, expect, it, vi } from "vite-plus/test";

import { nativeUpdateToOffer } from "./native-app-update";

vi.mock("expo-constants", () => ({ default: {} }));
vi.mock("expo-updates", () => ({ isEnabled: true }));
vi.mock("react-native", () => ({ AppState: {}, Linking: {}, Platform: { OS: "android" } }));

describe("nativeUpdateToOffer", () => {
  it.each([
    [
      { apk: "t3code-fork-89301bf821-3609119.apk", runtimeVersion: "new" },
      "old",
      "t3code-fork-89301bf821-3609119.apk",
    ],
    [{ apk: "t3code-fork-89301bf821-3609119.apk", runtimeVersion: "old" }, "old", undefined],
    [{ apk: "../secrets.apk", runtimeVersion: "new" }, "old", undefined],
    [{ apk: "t3code-fork.apk" }, "old", undefined],
    [{ apk: "t3code-fork.apk", runtimeVersion: "new" }, null, undefined],
    ["not json", "old", undefined],
  ])("offers %j on runtime %s as %s", (latest, runtime, expected) => {
    expect(nativeUpdateToOffer(latest, runtime)).toBe(expected);
  });
});
