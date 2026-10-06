import * as Dialog from "../components/ui/Dialog";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS, type ServerConfig } from "@t3tools/contracts";
import { useCallback } from "react";

import { pickComposerMedia } from "../lib/composerImages";
import {
  appendComposerDraftAttachments,
  captureComposerDraftInsertion,
  countComposerDraftAttachmentsAfterSelection,
  removeComposerDraftAttachment,
} from "./use-composer-drafts";

export function useComposerMediaAttachments({
  getDraftKey,
  serverConfig,
  imagesOnly = false,
  appendReference = true,
}: {
  readonly getDraftKey: () => string | null;
  readonly serverConfig: ServerConfig | null;
  readonly imagesOnly?: boolean;
  readonly appendReference?: boolean;
}) {
  const onPickDraftMedia = useCallback(async () => {
    const threadKey = getDraftKey();
    if (threadKey === null) return;
    const insertion = captureComposerDraftInsertion(threadKey);
    const capabilities = serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: countComposerDraftAttachmentsAfterSelection(threadKey, insertion),
      maxVideoBytes:
        !imagesOnly && capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments, {
      appendReference,
      insertion,
    });
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Dialog.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [appendReference, getDraftKey, imagesOnly, serverConfig]);

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      const draftKey = getDraftKey();
      if (draftKey !== null) removeComposerDraftAttachment(draftKey, imageId);
    },
    [getDraftKey],
  );

  return { onPickDraftMedia, onRemoveDraftImage };
}
