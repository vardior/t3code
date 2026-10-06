import type { EnvironmentId } from "@t3tools/contracts";

import { prepareTurnAttachments } from "../lib/attachmentUpload";
import {
  flushComposerDrafts,
  getComposerDraftSnapshot,
  setComposerDraftAttachmentUpload,
} from "./use-composer-drafts";

export function prepareComposerDraftAttachments(input: {
  readonly draftKey: string;
  readonly environmentId: EnvironmentId;
  readonly supportsImageUploads: boolean;
}) {
  return prepareTurnAttachments({
    environmentId: input.environmentId,
    attachments: getComposerDraftSnapshot(input.draftKey).attachments,
    supportsImageUploads: input.supportsImageUploads,
    persistUploadedReferences: async (attachments) => {
      let retained = true;
      for (const attachment of attachments) {
        retained = setComposerDraftAttachmentUpload(input.draftKey, attachment) && retained;
      }
      if (!retained) return "abandon";
      await flushComposerDrafts();
      return "persisted";
    },
  });
}
