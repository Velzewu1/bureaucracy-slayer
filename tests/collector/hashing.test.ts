import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashCanonical,
  hashText,
  type PageSnapshot,
  type SiteSnapshot,
} from "../../src/contracts/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashUserState,
  hashWebsiteActionFingerprint,
} from "../../src/shared/index.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  evidenceContextFixture,
  scheduledStandardStateFixture,
} from "../fixtures/p0.js";

function withCanonicalHashes(): SiteSnapshot {
  const parsed = SiteSnapshotSchema.parse(baseSnapshotFixture);
  const pages: PageSnapshot[] = parsed.pages.map((page) => {
    const blocks = page.blocks.map((block) => ({ ...block, textHash: hashEvidenceBlockText(block.text) }));
    const actions = page.actions.map((action) => ({
      ...action,
      fingerprint: hashWebsiteActionFingerprint(action),
    }));
    const pageContent = { ...page, blocks, actions };
    return { ...pageContent, contentHash: hashPageSnapshotContent(pageContent) };
  });
  const snapshotContent = { ...parsed, pages };
  return { ...snapshotContent, contentHash: hashSiteSnapshotContent(snapshotContent) };
}

describe("collector canonical hashing v1", () => {
  it("is deterministic and preserves the existing block/user-state recipes", () => {
    const text = "  Scheduled\ntransfers   may be canceled.  ";
    const state = UserStateSchema.parse(scheduledStandardStateFixture);

    expect(hashEvidenceBlockText(text)).toBe(hashEvidenceBlockText(text));
    expect(hashEvidenceBlockText(text)).toBe(hashText(text));
    expect(hashUserState(state)).toBe(hashCanonical(state));
  });

  it("normalizes evidence whitespace but changes the digest for content mutations", () => {
    expect(hashEvidenceBlockText("Transfer\n policy")).toBe(hashEvidenceBlockText("Transfer   policy"));
    expect(hashEvidenceBlockText("Transfer policy")).not.toBe(hashEvidenceBlockText("Different policy"));
  });

  it("changes action fingerprints for semantic bindings, not availability", () => {
    const action = withCanonicalHashes().pages[0]?.actions[0];
    if (action === undefined) throw new Error("Expected the fixture action");

    const original = hashWebsiteActionFingerprint(action);
    const availabilityChanged = { ...action, visible: false };
    expect(hashWebsiteActionFingerprint(action)).toBe(original);
    expect(hashWebsiteActionFingerprint({ ...action, label: `${action.label} changed` })).not.toBe(original);
    expect(hashWebsiteActionFingerprint(availabilityChanged)).toBe(original);
  });

  it("changes page hashes for page content but not capture time", () => {
    const page = withCanonicalHashes().pages[0];
    if (page === undefined) throw new Error("Expected the fixture page");

    const original = hashPageSnapshotContent(page);
    const recapturedPage = { ...page, capturedAt: "2030-01-01T00:00:00.000Z" };
    expect(hashPageSnapshotContent(page)).toBe(original);
    expect(hashPageSnapshotContent({ ...page, title: `${page.title} changed` })).not.toBe(original);
    expect(hashPageSnapshotContent(recapturedPage)).toBe(original);
  });

  it("changes site hashes when a nested page changes but not on recapture time", () => {
    const snapshot = withCanonicalHashes();
    const firstPage = snapshot.pages[0];
    if (firstPage === undefined) throw new Error("Expected the fixture page");
    const changedPages = [
      { ...firstPage, title: `${firstPage.title} changed` },
      ...snapshot.pages.slice(1),
    ];

    const original = hashSiteSnapshotContent(snapshot);
    const recapturedSnapshot = { ...snapshot, capturedAt: "2030-01-01T00:00:00.000Z" };
    expect(hashSiteSnapshotContent(snapshot)).toBe(original);
    expect(hashSiteSnapshotContent({ ...snapshot, pages: changedPages })).not.toBe(original);
    expect(hashSiteSnapshotContent(recapturedSnapshot)).toBe(original);
  });

  it("accepts collector-canonical hashes without changing validator authorization", () => {
    const snapshot = withCanonicalHashes();
    const model = ProcedureModelSchema.parse({
      ...baseProcedureModelFixture,
      sourceSnapshotHash: snapshot.contentHash,
    });
    const result = validateEvidence(snapshot, model, evidenceContextFixture);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.status).toBe("valid");
      expect(result.evidence.snapshotHash).toBe(snapshot.contentHash);
    }
  });

  it("preserves the existing opaque fixture behavior during migration", () => {
    const result = validateEvidence(baseSnapshotFixture, baseProcedureModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.status).toBe("valid");
  });
});
