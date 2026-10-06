import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileStorage from "./mobile-storage";

export type { Preferences } from "./mobile-preferences";
export type { AgentAwarenessRegistrationRecord, RecentThreadShortcut } from "./mobile-storage";
export { MobilePreferencesLoadError, MobilePreferencesSaveError } from "./mobile-preferences";
export {
  MobileDeviceIdGenerationError,
  MobileStorageDecodeError,
  MobileStorageEncodeError,
} from "./mobile-storage";
export { MobileSecureStorageError } from "./mobile-secure-storage";

const runStorage = <A, E>(
  use: (storage: MobileStorage.MobileStorage["Service"]) => Effect.Effect<A, E>,
) => runtime.runPromise(MobileStorage.MobileStorage.pipe(Effect.flatMap(use)));

const runPreferences = <A, E>(
  use: (store: MobilePreferences.MobilePreferencesStore["Service"]) => Effect.Effect<A, E>,
) => runtime.runPromise(MobilePreferences.MobilePreferencesStore.pipe(Effect.flatMap(use)));
export const loadBotHomeThreads = () => runStorage((storage) => storage.loadBotHomeThreads);
export const saveBotHomeThreads = (
  environmentId: string,
  bots: Parameters<MobileStorage.MobileStorage["Service"]["saveBotHomeThreads"]>[1],
) => runStorage((storage) => storage.saveBotHomeThreads(environmentId, bots));

export const loadPreferences = () => runPreferences((store) => store.load);
export const savePreferencesPatch = (patch: Partial<MobilePreferences.Preferences>) =>
  runPreferences((store) => store.savePatch(patch));
export const updatePreferences = (
  transform: (current: MobilePreferences.Preferences) => Partial<MobilePreferences.Preferences>,
) => runPreferences((store) => store.update(transform));

export const loadOrCreateAgentAwarenessDeviceId = () =>
  runStorage((storage) => storage.loadOrCreateAgentAwarenessDeviceId);
export const loadAgentAwarenessDeviceId = () =>
  runStorage((storage) => storage.loadAgentAwarenessDeviceId);
export const loadAgentAwarenessRegistrationRecord = () =>
  runStorage((storage) => storage.loadAgentAwarenessRegistrationRecord);
export const saveAgentAwarenessRegistrationRecord = (
  record: MobileStorage.AgentAwarenessRegistrationRecord,
) => runStorage((storage) => storage.saveAgentAwarenessRegistrationRecord(record));
export const clearAgentAwarenessRegistrationRecord = () =>
  runStorage((storage) => storage.clearAgentAwarenessRegistrationRecord);

export const loadRecentThreadShortcuts = () =>
  runStorage((storage) => storage.loadRecentThreadShortcuts);
export const saveRecentThreadShortcuts = (
  threads: ReadonlyArray<MobileStorage.RecentThreadShortcut>,
) => runStorage((storage) => storage.saveRecentThreadShortcuts(threads));

export const loadOpenItemNotificationMarks = () =>
  runStorage((storage) => storage.loadOpenItemNotificationMarks);
export const saveOpenItemNotificationMarks = (marks: Readonly<Record<string, string>>) =>
  runStorage((storage) => storage.saveOpenItemNotificationMarks(marks));
