import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createSanitizedRecordedBundle } from "../../scripts/build-recorded-extraction-bundle.js";
import { RecordedExtractionBundleSchema } from "../../src/ui/recordedBundle.js";
import { recordedSonnetBundleInput } from "../../src/ui/generated/recordedSonnetBundle.js";

function readJson(path: string): unknown {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parsed;
}

describe("sanitized recorded extraction bundle", () => {
  it("parses under its strict schema and preserves exact canonical identities", () => {
    const bundle = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);

    expect(bundle.sourceSnapshot.id).toBe(bundle.identity.snapshotId);
    expect(bundle.sourceSnapshot.contentHash).toBe(bundle.identity.snapshotHash);
    expect(bundle.procedureModel.id).toBe(bundle.identity.modelId);
    expect(bundle.procedureModel.sourceSnapshotId).toBe(bundle.identity.snapshotId);
    expect(bundle.buildTimeEvidence.procedureModelId).toBe(bundle.identity.modelId);
  });

  it("rebuilds deterministically from the real saved artifacts without raw Claude metadata", () => {
    const rebuilt = createSanitizedRecordedBundle({
      debugArtifact: readJson("artifacts/live-extraction-debug.json"),
      resumeArtifact: readJson("artifacts/live-stage2-resume-2026-10-17T10-00-46-689Z-2d218849.json"),
      validatedArtifact: readJson("artifacts/validated-offline-demo-2026-10-17.json"),
    });
    const committed = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);

    expect(rebuilt).toEqual(committed);
    expect(Object.keys(rebuilt).sort()).toEqual([
      "artifactKind",
      "buildTimeEvidence",
      "defaultScenario",
      "extractionGoal",
      "goalScope",
      "identity",
      "procedureModel",
      "provenance",
      "schemaVersion",
      "semanticAudit",
      "sourceSelection",
      "sourceSnapshot",
    ]);
    expect(rebuilt).not.toHaveProperty("configuration");
    expect(rebuilt).not.toHaveProperty("debugEvents");
    expect(rebuilt).not.toHaveProperty("rawResponse");
    expect(rebuilt.provenance.paidCallsDuringReplay).toBe(0);
  });
});
