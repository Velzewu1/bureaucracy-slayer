import { ProcedureModelSchema, SiteSnapshotSchema } from "../src/contracts/index.js";
import { validateEvidence } from "../src/evidence/index.js";
import { auditSemanticQualifiers } from "../src/extractor/index.js";
import {
  LiveExtractionArtifactSchema,
  type LiveExtractionArtifact,
} from "../src/orchestration/live-extraction-contract.js";
import {
  LIVE_EXTRACTION_GOAL,
} from "../src/orchestration/live-extraction-pipeline.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  evidenceContextFixture,
} from "./fixtures/p0.js";

export const LIVE_EXTRACTION_TEST_PORTAL_URL = "http://127.0.0.1:5180/dashboard";

export function liveExtractionArtifact(): LiveExtractionArtifact {
  const snapshot = SiteSnapshotSchema.parse({
    ...baseSnapshotFixture,
    rootUrl: LIVE_EXTRACTION_TEST_PORTAL_URL,
  });
  const model = ProcedureModelSchema.parse(baseProcedureModelFixture);
  const audit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    evidenceContextFixture,
    audit.findings,
  );
  if (!validation.ok) throw new Error("Live extraction test fixture failed evidence validation.");
  const counts = {
    pages: snapshot.pages.length,
    blocks: snapshot.pages.reduce((count, page) => count + page.blocks.length, 0),
    actions: snapshot.pages.reduce((count, page) => count + page.actions.length, 0),
  };
  return LiveExtractionArtifactSchema.parse({
    schemaVersion: 1,
    artifactKind: "live_sonnet_extraction",
    goal: LIVE_EXTRACTION_GOAL,
    portalUrl: LIVE_EXTRACTION_TEST_PORTAL_URL,
    sourceSnapshot: snapshot,
    procedureModel: validation.model,
    evidence: validation.evidence,
    sourceSelection: {
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      userGoal: LIVE_EXTRACTION_GOAL,
      selectionMode: "goal_scoped",
      semanticCoverage: "not_verified",
      coverage: "complete",
      limitations: [],
      originalCounts: counts,
      selectedCounts: counts,
      selectedPageIds: snapshot.pages.map((page) => page.id),
    },
    semanticAudit: audit,
    provenance: {
      extractionType: "live",
      modelName: "claude-sonnet-test",
      completedAt: "2026-10-17T12:00:00.000Z",
    },
  });
}

export type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}>;

export function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred resolve was unavailable.");
      resolvePromise(value);
    },
    reject: (error) => {
      if (rejectPromise === undefined) throw new Error("Deferred reject was unavailable.");
      rejectPromise(error);
    },
  };
}

export async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
