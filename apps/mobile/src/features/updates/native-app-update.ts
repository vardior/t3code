import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { AppState, Linking, Platform } from "react-native";

import { isAppUpdateCheckAvailable } from "./app-updates";

export function nativeUpdateToOffer(
  latest: unknown,
  runtimeVersion: string | null | undefined,
): string | undefined {
  if (typeof latest !== "object" || latest === null) return undefined;
  const { apk, runtimeVersion: latestRuntime } = latest as Record<string, unknown>;
  if (typeof apk !== "string" || !/^[A-Za-z0-9._-]+\.apk$/.test(apk)) return undefined;
  if (typeof latestRuntime !== "string" || !runtimeVersion) return undefined;
  return latestRuntime === runtimeVersion ? undefined : apk;
}

let offeredApk: string | undefined;

async function offerNativeAppUpdate(updatesUrl: string): Promise<void> {
  const response = await fetch(new URL("apk/latest.json", updatesUrl), { cache: "no-store" });
  if (!response.ok) return;
  const apk = nativeUpdateToOffer(await response.json(), Updates.runtimeVersion);
  if (!apk || apk === offeredApk) return;
  offeredApk = apk;
  const Dialog = await import("../../components/ui/Dialog");
  Dialog.alert(
    "App update",
    "This version needs a new install. Download it now, then tap the file to install. Your environments and threads stay.",
    [
      { style: "cancel", text: "Later" },
      {
        onPress: () => void Linking.openURL(new URL(`apk/${apk}`, updatesUrl).href),
        text: "Download",
      },
    ],
    { cancelable: true },
  );
}

export function installNativeAppUpdateOffer(): () => void {
  const updatesUrl = Constants.expoConfig?.updates?.url;
  if (Platform.OS !== "android" || !updatesUrl || !isAppUpdateCheckAvailable()) {
    return () => undefined;
  }
  const check = () => void offerNativeAppUpdate(updatesUrl).catch(() => undefined);
  check();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") check();
  });
  return () => subscription.remove();
}
