import { squashAtomCommandFailure, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, type OpenItem, OpenItemId, ThreadId } from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  loadOpenItemNotificationMarks,
  saveOpenItemNotificationMarks,
} from "../../persistence/imperative";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import {
  type NotifiedShell,
  type OpenItemAnswerOutcome,
  type OpenItemNotificationData,
  type OpenItemNotificationTarget,
  openItemAnswerActionId,
  openItemAnswerChoices,
  openItemAnswerForAction,
  openItemAnswerOutcome,
  openItemAnswerPrecheck,
  openItemNotificationData,
  openItemNotificationId,
  openItemNotificationVersion,
  openItemOutcomeContent,
  planOpenItemNotifications,
  readOpenItemNotificationData,
} from "./openItemNotifications";

const ALERT_CHANNEL = "agent-alerts";
const RESULT_CHANNEL = "open-item-results";
const RESULT_VISIBLE_MS = 5_000;
const ANSWER_TIMEOUT_MS = 20_000;

const shown = new Map<string, OpenItemNotificationTarget>();
const handledResponses = new Set<string>();

function targetOf(data: OpenItemNotificationData): OpenItemNotificationTarget {
  return { environmentId: data.environmentId, threadId: data.threadId, itemId: data.itemId };
}

function channelTrigger(channelId: string): Notifications.NotificationTriggerInput {
  return Platform.OS === "android" ? { channelId } : null;
}

function findItem(target: OpenItemNotificationTarget): OpenItem | undefined {
  return appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .find((shell) => shell.environmentId === target.environmentId && shell.id === target.threadId)
    ?.openItems.find((item) => item.id === target.itemId);
}

function canAnswer(environmentId: string): boolean {
  return appAtomRegistry.get(
    serverEnvironment.answerOpenItem.permissionAtom(EnvironmentId.make(environmentId)),
  );
}

async function forget(notificationId: string): Promise<void> {
  shown.delete(notificationId);
  await Notifications.deleteNotificationCategoryAsync(notificationId).catch(() => false);
}

async function present(shell: NotifiedShell, item: OpenItem): Promise<void> {
  const target = { environmentId: shell.environmentId, threadId: shell.id, itemId: item.id };
  const notificationId = openItemNotificationId(target);
  const choices = canAnswer(shell.environmentId) ? openItemAnswerChoices(item) : [];
  if (choices.length > 0) {
    await Notifications.setNotificationCategoryAsync(
      notificationId,
      choices.map((choice, index) => ({
        identifier: openItemAnswerActionId(index),
        buttonTitle: choice,
        options: { opensAppToForeground: false },
      })),
    );
  } else {
    await Notifications.deleteNotificationCategoryAsync(notificationId).catch(() => false);
  }
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId,
    content: {
      title: item.title,
      body: item.detail ? `${shell.title}: ${item.detail}` : shell.title,
      data: { ...openItemNotificationData(shell, item, choices) },
      ...(choices.length > 0 ? { categoryIdentifier: notificationId } : {}),
    },
    trigger: channelTrigger(ALERT_CHANNEL),
  });
  shown.set(notificationId, target);
}

export function startOpenItemNotifications(
  isBotHomeThread: (environmentId: string, threadId: string) => boolean,
): () => void {
  let disposed = false;
  let since: Record<string, string> | null = null;
  const marks: Record<string, string> = {};
  const posted = new Set<string>();
  let pending: Promise<void> = Promise.resolve();
  let queued = false;

  const notifies = (shell: NotifiedShell) =>
    isBotHomeThread(shell.environmentId, shell.id) ||
    appAtomRegistry.get(environmentServerConfigsAtom).get(EnvironmentId.make(shell.environmentId))
      ?.settings.notifyAgentThreads !== false;

  const sync = async () => {
    if (disposed || since === null) return;
    const plan = planOpenItemNotifications({
      shells: appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
      since,
      posted,
      shown,
      notifies,
    });
    let marksChanged = false;
    const now = new Date().toISOString();
    for (const environmentId of plan.unmarkedEnvironments) {
      since[environmentId] = now;
      marks[environmentId] = now;
      marksChanged = true;
    }
    for (const { shell, item } of plan.post) {
      posted.add(openItemNotificationVersion(shell, item));
      await present(shell, item);
      if ((marks[shell.environmentId] ?? "") < item.updatedAt) {
        marks[shell.environmentId] = item.updatedAt;
        marksChanged = true;
      }
    }
    for (const notificationId of plan.clear) {
      await forget(notificationId);
      await Notifications.dismissNotificationAsync(notificationId);
    }
    if (marksChanged) await saveOpenItemNotificationMarks({ ...marks });
  };

  const schedule = () => {
    if (queued) return;
    queued = true;
    pending = pending
      .then(() => {
        queued = false;
        return sync();
      })
      .catch((cause) => {
        console.warn("Open item notifications could not sync.", cause);
      });
  };

  const prepare = async () => {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(ALERT_CHANNEL, {
        name: "Agent alerts",
        importance: Notifications.AndroidImportance.HIGH,
      });
      await Notifications.setNotificationChannelAsync(RESULT_CHANNEL, {
        name: "Open item answers",
        importance: Notifications.AndroidImportance.LOW,
      });
    }
    for (const notification of await Notifications.getPresentedNotificationsAsync()) {
      const data = readOpenItemNotificationData(notification.request.content.data);
      if (data !== null && data.kind !== "open-item-result") {
        shown.set(notification.request.identifier, targetOf(data));
      }
    }
    for (const category of await Notifications.getNotificationCategoriesAsync()) {
      if (category.identifier.startsWith("open-item:") && !shown.has(category.identifier)) {
        await Notifications.deleteNotificationCategoryAsync(category.identifier);
      }
    }
    Object.assign(marks, await loadOpenItemNotificationMarks().catch(() => ({})));
    since = { ...marks };
  };

  pending = prepare().catch((cause) => {
    console.warn("Open item notifications could not start.", cause);
  });
  schedule();
  const unsubscribeShells = appAtomRegistry.subscribe(
    environmentThreadShells.threadShellsAtom,
    schedule,
  );
  const unsubscribeConfigs = appAtomRegistry.subscribe(environmentServerConfigsAtom, schedule);
  return () => {
    disposed = true;
    unsubscribeShells();
    unsubscribeConfigs();
  };
}

async function answerItem(
  data: OpenItemNotificationData,
  answer: string,
): Promise<OpenItemAnswerOutcome> {
  const precheck = openItemAnswerPrecheck(findItem(data));
  if (precheck !== null) return precheck;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ readonly _tag: "Failure"; readonly error: Error }>((resolve) => {
    timeout = setTimeout(
      () => resolve({ _tag: "Failure", error: new Error("The server did not respond.") }),
      ANSWER_TIMEOUT_MS,
    );
  });
  const answered = runAtomCommand(
    appAtomRegistry,
    serverEnvironment.answerOpenItem,
    {
      environmentId: EnvironmentId.make(data.environmentId),
      input: {
        threadId: ThreadId.make(data.threadId),
        itemId: OpenItemId.make(data.itemId),
        answer,
        creationSource: "mobile",
      },
    },
    { reportFailure: false },
  ).then((result) =>
    result._tag === "Success"
      ? { _tag: "Success" as const, value: result.value }
      : { _tag: "Failure" as const, error: squashAtomCommandFailure(result) },
  );
  const result = await Promise.race([answered, timedOut]).finally(() => clearTimeout(timeout));
  return openItemAnswerOutcome({ answer, result, current: findItem(data) });
}

async function answerFromNotification(
  notificationId: string,
  data: OpenItemNotificationData,
  answer: string,
): Promise<void> {
  await forget(notificationId);
  const outcome = await answerItem(data, answer);
  const content = openItemOutcomeContent(data, answer, outcome);
  await Notifications.scheduleNotificationAsync({
    identifier: notificationId,
    content: { title: content.title, body: content.body, data: { ...content.data } },
    trigger: channelTrigger(RESULT_CHANNEL),
  });
  if (content.data.kind === "open-item-retry") {
    shown.set(notificationId, targetOf(data));
  } else {
    setTimeout(() => {
      void Notifications.dismissNotificationAsync(notificationId).catch(() => undefined);
    }, RESULT_VISIBLE_MS);
  }
}

export async function handleOpenItemNotificationResponse(
  response: Notifications.NotificationResponse,
  navigate: (deepLink: string) => void,
): Promise<boolean> {
  const request = response.notification.request;
  const data = readOpenItemNotificationData(request.content.data);
  if (data === null) return false;
  const responseKey = `${request.identifier}:${response.actionIdentifier}:${response.notification.date}`;
  if (handledResponses.has(responseKey)) return true;
  handledResponses.add(responseKey);
  const answer = openItemAnswerForAction(data, response.actionIdentifier);
  if (answer !== null) {
    await answerFromNotification(request.identifier, data, answer);
    return true;
  }
  navigate(data.deepLink);
  if (data.kind === "open-item-retry" && data.answer !== undefined) {
    await answerFromNotification(request.identifier, data, data.answer);
  }
  return true;
}
