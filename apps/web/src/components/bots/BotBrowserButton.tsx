import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthPreviewOperateScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { GlobeIcon } from "lucide-react";

import { usePreviewAvailable } from "../../browser/previewRuntime";
import {
  readThreadPreviewState,
  setActivePreviewTab,
  useThreadPreviewState,
} from "../../previewStateStore";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentScope } from "../../state/session";
import { usePreviewSession } from "../preview/usePreviewSession";
import { Button } from "../ui/button";

export function BotBrowserButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const available = usePreviewAvailable(props.environmentId);
  const permitted = useEnvironmentScope(props.environmentId, AuthPreviewOperateScope);
  return available && permitted ? <OpenBotBrowserButton {...props} /> : null;
}

function OpenBotBrowserButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  usePreviewSession(threadRef);
  const preview = useThreadPreviewState(threadRef);
  const browserOpen = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "preview",
  );
  if (preview.activeTabId === null || browserOpen) return null;

  const openBrowser = () => {
    const tabId = readThreadPreviewState(threadRef).activeTabId;
    if (tabId === null) return;
    setActivePreviewTab(threadRef, tabId);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  return (
    <Button variant="outline" size="sm" onClick={openBrowser}>
      <GlobeIcon />
      Open browser
    </Button>
  );
}
