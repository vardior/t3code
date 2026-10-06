import type { NotificationResponse } from "expo-notifications";
import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

import {
  agentNotificationRouteForBots,
  agentNotificationUrlForBots,
  extractAgentNotificationDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

const botsForEnvironment = (environmentId: string) =>
  environmentId === "env 1" ? [{ id: "bot/1", homeThreadId: ThreadId.make("home/1") }] : null;

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeLastAgentNotificationResponse", () => {
  it("reports routing failures before clearing the response", async () => {
    const cause = new Error("notification routing unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({}, "notification-route") as NotificationResponse;
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: () => {
        throw cause;
      },
    });

    expect(clearLastResponse).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NotificationNavigationError",
        operation: "route",
        notificationId: "notification-route",
      }),
    );
  });
});

describe("extractAgentNotificationDeepLink", () => {
  it("uses explicit deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to ids when explicit deep link is not an agent thread route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });
});

describe("routeAgentNotificationResponseOnce", () => {
  it("retries a failed initial response and deduplicates it after navigation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = responseWithData({ deepLink: "/threads/env/thread" }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn().mockImplementationOnce(() => {
      throw new Error("navigation not ready");
    });
    const clearLastResponse = vi.fn(() => Promise.resolve());
    const consume = () =>
      consumeLastAgentNotificationResponse({
        getLastResponse: () => Promise.resolve(response),
        clearLastResponse,
        handleResponse: (response) =>
          routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
      });

    await consume();
    expect(handledResponseIds.size).toBe(0);
    expect(clearLastResponse).not.toHaveBeenCalled();

    await consume();
    expect(navigate).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenLastCalledWith("/threads/env/thread");
    expect(clearLastResponse).toHaveBeenCalledOnce();

    routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate });
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it("discards malformed destination ids without leaving the response pending", async () => {
    const response = responseWithData({
      environmentId: "env",
      threadId: "\ud800",
    }) as NotificationResponse;
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn();
    const clearLastResponse = vi.fn(() => Promise.resolve());

    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response),
      clearLastResponse,
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({ handledResponseIds, response, navigate }),
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(clearLastResponse).toHaveBeenCalledOnce();
    expect(handledResponseIds.has("notification-1")).toBe(true);
  });

  it("routes warm and cold bot home-thread responses to the bot chat once", async () => {
    const handledResponseIds = new Set<string>();
    const navigate = vi.fn();
    const response = responseWithData({ deepLink: "/threads/env%201/home%2F1" });
    const handleResponse = (response: unknown) =>
      routeAgentNotificationResponseOnce({
        handledResponseIds,
        response,
        navigate,
        botsForEnvironment,
      });

    handleResponse(response);
    await consumeLastAgentNotificationResponse({
      getLastResponse: () => Promise.resolve(response as NotificationResponse),
      clearLastResponse: () => Promise.resolve(),
      handleResponse,
    });

    expect(navigate).toHaveBeenCalledExactlyOnceWith("/bots/env%201/bot%2F1");
  });

  it("routes a cold-start bot notification through the last-response consumer", async () => {
    const navigate = vi.fn();
    await consumeLastAgentNotificationResponse({
      getLastResponse: () =>
        Promise.resolve(
          responseWithData({ environmentId: "env 1", threadId: "home/1" }) as NotificationResponse,
        ),
      clearLastResponse: () => Promise.resolve(),
      handleResponse: (response) =>
        routeAgentNotificationResponseOnce({
          handledResponseIds: new Set(),
          response,
          navigate,
          botsForEnvironment,
        }),
    });
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/bots/env%201/bot%2F1");
  });

  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});

describe("agentNotificationRouteForBots", () => {
  it("maps a home thread using bots from the notification's environment", () => {
    expect(agentNotificationRouteForBots("/threads/env%201/home%2F1", botsForEnvironment)).toBe(
      "/bots/env%201/bot%2F1",
    );
    expect(agentNotificationRouteForBots("/threads/other/home%2F1", botsForEnvironment)).toBe(
      "/threads/other/home%2F1",
    );
  });

  it("keeps the thread route for unknown threads and unavailable bots lists", () => {
    expect(agentNotificationRouteForBots("/threads/env%201/ordinary", botsForEnvironment)).toBe(
      "/threads/env%201/ordinary",
    );
    expect(agentNotificationRouteForBots("/threads/env%201/home%2F1", () => null)).toBe(
      "/threads/env%201/home%2F1",
    );
    expect(agentNotificationRouteForBots("/threads/env%201/home%2F1", () => [])).toBe(
      "/threads/env%201/home%2F1",
    );
  });
});

describe("agentNotificationUrlForBots", () => {
  it.each(["t3code", "t3code-dev", "t3code-preview"])(
    "maps native notification links for %s",
    (scheme) => {
      expect(
        agentNotificationUrlForBots(`${scheme}://threads/env%201/home%2F1`, botsForEnvironment),
      ).toBe(`${scheme}://bots/env%201/bot%2F1`);
    },
  );

  it.each([
    "https://example.com/threads/env%201/home%2F1",
    "t3code-dev://threads/env%201/home%2F1?x=1",
    "t3code-dev://threads/env%201/%invalid",
    "t3code-dev://threads/other/home%2F1",
    "t3code-dev://bots/env%201/bot%2F1",
    "t3code-dev://connections/new?autoConnect=1",
  ])("preserves other links: %s", (url) => {
    expect(agentNotificationUrlForBots(url, botsForEnvironment)).toBe(url);
  });
});
