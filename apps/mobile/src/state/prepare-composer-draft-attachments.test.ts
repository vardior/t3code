import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  snapshot: vi.fn(),
  stamp: vi.fn(),
  flush: vi.fn(),
}));
vi.mock("../lib/attachmentUpload", () => ({ prepareTurnAttachments: mocks.prepare }));
vi.mock("./use-composer-drafts", () => ({
  getComposerDraftSnapshot: mocks.snapshot,
  setComposerDraftAttachmentUpload: mocks.stamp,
  flushComposerDrafts: mocks.flush,
}));

import { prepareComposerDraftAttachments } from "./prepare-composer-draft-attachments";

const environmentId = EnvironmentId.make("environment");
const local = { id: "image", type: "image", name: "photo.jpg" };
const uploaded = { ...local, uploadedAttachmentId: "upload", uploadEnvironmentId: environmentId };
const input = { draftKey: "environment:bot-chat-home", environmentId, supportsImageUploads: true };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.snapshot.mockReturnValue({ attachments: [local] });
  mocks.stamp.mockReturnValue(true);
  mocks.prepare.mockImplementation(async (options) => ({
    status: await options.persistUploadedReferences([uploaded]),
  }));
});

describe("prepare composer draft attachments", () => {
  it("persists uploaded references before returning so a failed send can reuse them", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    mocks.flush.mockImplementation(() => {
      started.resolve();
      return gate.promise;
    });
    let settled = false;
    const preparation = prepareComposerDraftAttachments(input).then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    expect(settled).toBe(false);
    expect(mocks.stamp).toHaveBeenCalledWith(input.draftKey, uploaded);
    gate.resolve();
    expect(await preparation).toEqual({ status: "persisted" });
    expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({
      environmentId,
      attachments: [local],
      supportsImageUploads: true,
    });
  });

  it("abandons newly uploaded bytes when the draft has discarded an attachment", async () => {
    mocks.stamp.mockReturnValue(false);
    expect(await prepareComposerDraftAttachments(input)).toEqual({ status: "abandon" });
    expect(mocks.flush).not.toHaveBeenCalled();
  });

  it("propagates persistence failure so upload preparation releases the new uploads", async () => {
    mocks.flush.mockRejectedValue(new Error("Disk full"));
    await expect(prepareComposerDraftAttachments(input)).rejects.toThrow("Disk full");
  });
});
