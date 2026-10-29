import { ThreadId } from "@t3tools/contracts";
import type { NotificationResponse } from "expo-notifications";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  let preferencesJson: string | null = null;
  let preferencesUpdatedAt = 0;
  let loadPreferencesFails = false;
  let savePreferencesFails = false;
  return {
    clear: () => {
      values.clear();
      preferencesJson = null;
      preferencesUpdatedAt = 0;
      loadPreferencesFails = false;
      savePreferencesFails = false;
    },
    getStoredValue: (key: string) => values.get(key) ?? null,
    getPreferencesJson: () => preferencesJson,
    setPreferencesJson: (value: string, updatedAt: number) => {
      preferencesJson = value;
      preferencesUpdatedAt = updatedAt;
    },
    setDatabaseFailures: (load: boolean, save: boolean) => {
      loadPreferencesFails = load;
      savePreferencesFails = save;
    },
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: vi.fn((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
    database: {
      closeAsync: vi.fn(() => Promise.resolve()),
      execAsync: vi.fn(() => Promise.resolve()),
      withExclusiveTransactionAsync: vi.fn(
        (run: (transaction: { execAsync: () => Promise<void> }) => Promise<void>) =>
          run({ execAsync: () => Promise.resolve() }),
      ),
      getFirstAsync: vi.fn((sql: string) => {
        if (sql.includes("PRAGMA user_version")) {
          return Promise.resolve({ user_version: 1 });
        }
        if (loadPreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        return Promise.resolve(
          preferencesJson === null
            ? null
            : { payload: preferencesJson, updatedAt: preferencesUpdatedAt },
        );
      }),
      runAsync: vi.fn((_sql: string, payload?: unknown, updatedAt?: unknown) => {
        if (savePreferencesFails) {
          return Promise.reject(new Error("database unavailable"));
        }
        if (typeof payload === "string") {
          preferencesJson = payload;
        }
        if (typeof updatedAt === "number") {
          preferencesUpdatedAt = updatedAt;
        }
        return Promise.resolve();
      }),
    },
  };
});

vi.mock("expo", () => ({
  requireOptionalNativeModule: () => null,
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: mocks.deleteItemAsync,
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("expo-sqlite", () => ({
  openDatabaseAsync: vi.fn(() => Promise.resolve(mocks.database)),
}));

vi.mock("expo-crypto", () => ({
  getRandomBytes: vi.fn(() => new Uint8Array(16)),
}));

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: {} } },
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active" },
  Platform: {
    OS: "ios",
  },
}));

import {
  loadPreferences,
  loadBotHomeThreads,
  savePreferencesPatch,
  saveBotHomeThreads,
} from "../persistence/imperative";
import {
  loadNotificationBotsForEnvironment,
  persistNotificationBots,
} from "../features/agent-awareness/notificationBotCache";
import {
  agentNotificationUrlForBots,
  routeAgentNotificationResponseOnce,
} from "../features/agent-awareness/notificationPayload";
import { consumeLastAgentNotificationResponse } from "../features/agent-awareness/notificationResponseConsumer";

describe("mobile notification bot cache", () => {
  const bots = [{ id: "bot/1", homeThreadId: ThreadId.make("home/1") }];

  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("persists a bots.list result when the query finishes loading", async () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<AsyncResult.AsyncResult<{ bots: typeof bots }>>(AsyncResult.initial());
    const cached = persistNotificationBots("env 1", source);
    const unmount = registry.mount(cached);
    expect(mocks.setItemAsync).not.toHaveBeenCalled();
    const setItem = mocks.setItemAsync.getMockImplementation()!;
    const written = new Promise<void>((resolve) => {
      mocks.setItemAsync.mockImplementationOnce((key, value) => {
        void setItem(key, value);
        resolve();
        return Promise.resolve();
      });
    });
    registry.set(source, AsyncResult.success({ bots }));
    registry.get(cached);
    await written;
    expect(mocks.setItemAsync).toHaveBeenCalledWith(
      "t3code.bot-home-threads",
      JSON.stringify({ "env 1": { "home/1": "bot/1" } }),
    );
    unmount();
    registry.dispose();
  });

  it("resolves a cold initial URL with one local read and no live list", async () => {
    await saveBotHomeThreads("env 1", bots);
    mocks.getItemAsync.mockClear();
    const lookup = await loadNotificationBotsForEnvironment(() => null);
    expect(agentNotificationUrlForBots("t3code-dev://threads/env%201/home%2F1", lookup)).toBe(
      "t3code-dev://bots/env%201/bot%2F1",
    );
    expect(mocks.getItemAsync).toHaveBeenCalledExactlyOnceWith("t3code.bot-home-threads");
  });

  it("routes a cold notification response from the persisted map before clearing it", async () => {
    await saveBotHomeThreads("env 1", bots);
    const navigate = vi.fn();
    await consumeLastAgentNotificationResponse({
      getLastResponse: () =>
        Promise.resolve({
          notification: {
            request: {
              identifier: "cold",
              content: {
                data: {
                  environmentId: "env 1",
                  threadId: "home/1",
                },
              },
            },
          },
        } as unknown as NotificationResponse),
      clearLastResponse: async () => {
        expect(navigate).toHaveBeenCalledExactlyOnceWith("/bots/env%201/bot%2F1");
      },
      handleResponse: async (response) => {
        routeAgentNotificationResponseOnce({
          handledResponseIds: new Set(),
          response,
          navigate,
          botsForEnvironment: await loadNotificationBotsForEnvironment(() => null),
        });
      },
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/bots/env%201/bot%2F1");
  });

  it("overwrites only the refreshed environment and removes deleted bots", async () => {
    await Promise.all([saveBotHomeThreads("env 1", bots), saveBotHomeThreads("other", bots)]);
    await saveBotHomeThreads("env 1", []);
    expect(await loadBotHomeThreads()).toEqual({ "env 1": {}, other: { "home/1": "bot/1" } });
    const lookup = await loadNotificationBotsForEnvironment(() => null);
    expect(agentNotificationUrlForBots("t3code-dev://threads/env%201/home%2F1", lookup)).toBe(
      "t3code-dev://threads/env%201/home%2F1",
    );
    expect(agentNotificationUrlForBots("t3code-dev://threads/other/home%2F1", lookup)).toBe(
      "t3code-dev://bots/other/bot%2F1",
    );
  });

  it("prefers a loaded live list, including an empty list, over cached bots", async () => {
    await saveBotHomeThreads("env 1", bots);
    const emptyLookup = await loadNotificationBotsForEnvironment(() => []);
    expect(agentNotificationUrlForBots("t3code://threads/env%201/home%2F1", emptyLookup)).toBe(
      "t3code://threads/env%201/home%2F1",
    );
    const liveLookup = await loadNotificationBotsForEnvironment(() => [{ ...bots[0]!, id: "new" }]);
    expect(agentNotificationUrlForBots("t3code://threads/env%201/home%2F1", liveLookup)).toBe(
      "t3code://bots/env%201/new",
    );
  });

  it("keeps thread routes when the cache or thread mapping is missing", async () => {
    const lookup = await loadNotificationBotsForEnvironment(() => null);
    expect(agentNotificationUrlForBots("t3code://threads/env/home", lookup)).toBe(
      "t3code://threads/env/home",
    );
    await saveBotHomeThreads("env 1", bots);
    const populatedLookup = await loadNotificationBotsForEnvironment(() => null);
    expect(agentNotificationUrlForBots("t3code://threads/env%201/ordinary", populatedLookup)).toBe(
      "t3code://threads/env%201/ordinary",
    );
  });

  it("falls back to the thread when local storage cannot be read", async () => {
    mocks.getItemAsync.mockRejectedValueOnce(new Error("storage unavailable"));
    const lookup = await loadNotificationBotsForEnvironment(() => null);
    expect(agentNotificationUrlForBots("t3code://threads/env/home", lookup)).toBe(
      "t3code://threads/env/home",
    );
  });
});

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    vi.clearAllMocks();
  });

  it("persists tab order locally and retains it when another preference changes", async () => {
    const navigationTabOrder = ["usage", "threads", "pullRequests"];
    const hiddenNavigationTabs = ["issues", "home"];
    await savePreferencesPatch({ navigationTabOrder, hiddenNavigationTabs });
    await savePreferencesPatch({ baseFontSize: 19 });
    await expect(loadPreferences()).resolves.toEqual({
      navigationTabOrder,
      hiddenNavigationTabs,
      baseFontSize: 19,
    });
  });

  it("ignores invalid tab-order entries without dropping other saved preferences", async () => {
    mocks.setPreferencesJson(
      JSON.stringify({
        navigationTabOrder: ["usage", null, 4, "threads"],
        hiddenNavigationTabs: ["home", null],
        baseFontSize: 18,
      }),
      1,
    );
    await expect(loadPreferences()).resolves.toEqual({
      navigationTabOrder: ["usage", "threads"],
      hiddenNavigationTabs: ["home"],
      baseFontSize: 18,
    });
  });

  it("loads legacy preferences when SQLite is unavailable", async () => {
    mocks.setDatabaseFailures(true, true);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 17 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 17 });
  });

  it("falls back to secure storage when SQLite cannot save preferences", async () => {
    mocks.setDatabaseFailures(true, true);
    await expect(savePreferencesPatch({ baseFontSize: 19 })).resolves.toEqual({ baseFontSize: 19 });
    const fallback = JSON.parse(mocks.getStoredValue("t3code.preferences.fallback") ?? "") as {
      readonly payload: string;
      readonly updatedAt: number;
    };
    expect(JSON.parse(fallback.payload)).toEqual({ baseFontSize: 19 });
    expect(fallback.updatedAt).toEqual(expect.any(Number));
  });

  it("reconciles fallback preferences after SQLite recovers", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 15 }), 10);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 19 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 19 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("ignores a stale fallback when its previous deletion failed", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync(
      "t3code.preferences.fallback",
      JSON.stringify({
        payload: JSON.stringify({ baseFontSize: 19 }),
        updatedAt: 20,
      }),
    );

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
    expect(mocks.getStoredValue("t3code.preferences.fallback")).toBeNull();
  });

  it("keeps SQLite authoritative when stale legacy preferences remain", async () => {
    mocks.setPreferencesJson(JSON.stringify({ baseFontSize: 21 }), 30);
    await mocks.setItemAsync("t3code.preferences", JSON.stringify({ baseFontSize: 19 }));

    await expect(loadPreferences()).resolves.toEqual({ baseFontSize: 21 });
    expect(JSON.parse(mocks.getPreferencesJson() ?? "")).toEqual({ baseFontSize: 21 });
  });
});
