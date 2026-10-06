import * as Notifications from "expo-notifications";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";

import { setAndroidThreadOnScreen } from "./androidNotifications";
import { foregroundNotificationBehavior } from "./foregroundNotificationBehavior";
import { loadNotificationBotsForEnvironment } from "./notificationBotCache";
import { handleOpenItemNotificationResponse, startOpenItemNotifications } from "./openItemNotifier";
import {
  agentNotificationRouteForBots,
  agentNotificationUrlForBots,
  botRouteOnScreen,
  routeAgentNotificationResponseOnce,
  threadDeepLinkOnScreen,
} from "./notificationPayload";
import { consumeLastAgentNotificationResponse } from "./notificationResponseConsumer";

function botsForEnvironment(environmentId: string) {
  const result = appAtomRegistry.get(
    serverEnvironment.bots.list({ environmentId: EnvironmentId.make(environmentId), input: {} }),
  );
  return Option.getOrNull(AsyncResult.value(result))?.bots ?? null;
}

export function resolveAgentNotificationUrl(url: string): string {
  return agentNotificationUrlForBots(url, botsForEnvironment);
}

export async function resolveInitialAgentNotificationUrl(url: string): Promise<string> {
  return agentNotificationUrlForBots(
    url,
    await loadNotificationBotsForEnvironment(botsForEnvironment),
  );
}

let pathnameOnScreen = "";

function deepLinkOnScreen(): string | null {
  const botRoute = botRouteOnScreen(pathnameOnScreen);
  return threadDeepLinkOnScreen(
    pathnameOnScreen,
    botRoute ? botsForEnvironment(botRoute.environmentId) : null,
  );
}

/** Called with the workspace pathname on every root navigation state change. */
export function setAgentNotificationPathname(pathname: string): void {
  pathnameOnScreen = pathname;
  setAndroidThreadOnScreen(deepLinkOnScreen());
}

/**
 * App-lifetime notification routing: foreground presentation suppresses the
 * thread already on screen, and taps (including the cold-start tap) open the
 * notification's deep link through `navigate`.
 */
export function installAgentNotificationNavigation(navigate: (href: string) => void): () => void {
  const handledResponseIds = new Set<string>();
  Notifications.setNotificationHandler({
    handleNotification: (notification) =>
      Promise.resolve(foregroundNotificationBehavior(notification, deepLinkOnScreen())),
  });

  let stopOpenItems: (() => void) | null = null;
  let disposed = false;
  void loadNotificationBotsForEnvironment(botsForEnvironment).then((notificationBots) => {
    if (disposed) return;
    stopOpenItems = startOpenItemNotifications((environmentId, threadId) =>
      notificationBots(environmentId).some((bot) => bot.homeThreadId === threadId),
    );
  });

  const handleResponse = async (response: Notifications.NotificationResponse): Promise<void> => {
    const notificationBots = await loadNotificationBotsForEnvironment(botsForEnvironment);
    const handled = await handleOpenItemNotificationResponse(response, (deepLink) =>
      navigate(agentNotificationRouteForBots(deepLink, notificationBots)),
    );
    if (handled) return;
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate,
      botsForEnvironment: notificationBots,
    });
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  void consumeLastAgentNotificationResponse({
    getLastResponse: () => Notifications.getLastNotificationResponseAsync(),
    clearLastResponse: () => Notifications.clearLastNotificationResponseAsync(),
    handleResponse,
  });

  return () => {
    disposed = true;
    stopOpenItems?.();
    subscription.remove();
    Notifications.setNotificationHandler(null);
  };
}
