import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  EvidenceResultSchema,
  ProcedureModelSchema,
  SiteSnapshotSchema,
} from "../../src/contracts/index.js";
import {
  selectFocusedSources,
  type ExtractionDebugEvent,
  type ExtractionOutcome,
} from "../../src/extractor/index.js";
import {
  assertDebugOutputAvailable,
  createLiveExtractionRecording,
  readLiveConfiguration,
  resolveDebugOutputPath,
  writeDebugRecording,
  type LiveConfigurationSummary,
} from "../../scripts/live-extraction.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  evidenceContextFixture,
} from "../fixtures/p0.js";

const temporaryDirectories: string[] = [];

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "slayer-live-extraction-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function successfulRecordingInput(): Readonly<{
  configuration: LiveConfigurationSummary;
  snapshot: ReturnType<typeof SiteSnapshotSchema.parse>;
  outcome: ExtractionOutcome;
  debugEvents: readonly ExtractionDebugEvent[];
}> {
  const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);
  const model = ProcedureModelSchema.parse(baseProcedureModelFixture);
  const focusedSourceCatalog = selectFocusedSources(
    snapshot,
    "Cancel this transfer or identify an evidenced recovery path.",
  );
  const evidence = EvidenceResultSchema.parse({
    schemaVersion: 1,
    id: evidenceContextFixture.evidenceResultId,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.contentHash,
    procedureModelId: model.id,
    checkedAt: evidenceContextFixture.checkedAt,
    status: "degraded",
    validRuleIds: model.rules.slice(1).map((rule) => rule.id),
    rejectedRuleIds: [model.rules[0]?.id ?? "rule_missing01"],
    verifiedWebsiteActionIds: snapshot.pages.flatMap((page) => page.actions.map((action) => action.id)),
    executableProcedureActionIds: [],
    issues: [
      {
        severity: "warning",
        code: "SEMANTIC_REVIEW_REQUIRED",
        message: "A required qualifier needs review.",
        ruleId: model.rules[0]?.id ?? "rule_missing01",
      },
    ],
  });
  const stage1Dto = {
    schemaVersion: 1,
    policyAnalysisId: "analysis_fresh01",
    sourceSnapshotId: snapshot.id,
    sourceSnapshotHash: snapshot.contentHash,
  };
  const stage2Dto = {
    schemaVersion: 1,
    id: "mapping_fresh001",
    sourceSnapshotId: snapshot.id,
    sourceSnapshotHash: snapshot.contentHash,
  };
  const debugEvents: readonly ExtractionDebugEvent[] = [
    { kind: "source_selection", selection: focusedSourceCatalog },
    { kind: "policy_dto", policyDto: stage1Dto },
    { kind: "stage_outcome", stage: "policy_extraction", status: "valid", issues: [] },
    { kind: "procedure_mapping_dto", procedureMappingDto: stage2Dto },
    { kind: "stage_outcome", stage: "procedure_mapping", status: "valid", issues: [] },
    { kind: "compact_dto", compactDto: { sourceSnapshotId: snapshot.id } },
    { kind: "stage_outcome", stage: "canonical_schema", status: "valid", issues: [] },
    { kind: "evidence_validation", evidence },
  ];
  const outcome: ExtractionOutcome = {
    ok: true,
    status: "review_required",
    model,
    evidence,
    attempts: 2,
    sourceSelection: focusedSourceCatalog,
  };
  const { configuration } = readLiveConfiguration(
    {
      COLLECTOR_TEST_URL: "http://127.0.0.1:5180/dashboard",
      ANTHROPIC_API_KEY: "sk-ant-test-secret",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
      ANTHROPIC_MAX_TOKENS: "16000",
      ANTHROPIC_WORKSPACE_ID: "workspace-test-secret",
      LIVE_EXTRACTION_MODE: "goal_scoped",
    },
    false,
  );
  return {
    configuration,
    snapshot,
    outcome,
    debugEvents,
  };
}

describe("live extraction CLI configuration", () => {
  it("keeps debug recording opt-in and retains the legacy default path", async () => {
    const root = await temporaryRoot();

    expect(resolveDebugOutputPath({ LIVE_EXTRACTION_DEBUG_PATH: "artifacts/new.json" }, root))
      .toBeUndefined();
    expect(resolveDebugOutputPath({ LIVE_EXTRACTION_SAVE_DEBUG: "true" }, root))
      .toBe(join(root, "artifacts", "live-extraction-debug.json"));
    expect(
      resolveDebugOutputPath(
        {
          LIVE_EXTRACTION_SAVE_DEBUG: "1",
          LIVE_EXTRACTION_DEBUG_PATH: "artifacts/fresh-sonnet.json",
        },
        root,
      ),
    ).toBe(join(root, "artifacts", "fresh-sonnet.json"));
  });

  it("fails deterministically when required configuration is missing", () => {
    expect(() =>
      readLiveConfiguration(
        {
          COLLECTOR_TEST_URL: "http://127.0.0.1:5180/dashboard",
          ANTHROPIC_MODEL: "claude-sonnet-4-5",
          ANTHROPIC_MAX_TOKENS: "16000",
        },
        false,
      ),
    ).toThrow("ANTHROPIC_API_KEY is required");
  });

  it("rejects an existing path and preserves its bytes", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "artifacts", "existing.json");
    await mkdir(join(root, "artifacts"), { recursive: true });
    await writeFile(outputPath, "historical recording\n", "utf8");

    expect(() => assertDebugOutputAvailable(outputPath)).toThrow("already exists");
    await expect(writeDebugRecording(outputPath, { replacement: true })).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("historical recording\n");
  });
});

describe("live extraction recording integrity", () => {
  it("writes complete stage artifacts, validation issues, and exact provenance without secrets", async () => {
    const root = await temporaryRoot();
    const outputPath = join(root, "artifacts", "fresh-sonnet.json");
    const input = successfulRecordingInput();
    const recording = createLiveExtractionRecording({
      createdAt: "2026-10-17T20:00:00.000Z",
      ...input,
      runtimeMs: 1_234,
    });

    await writeDebugRecording(outputPath, recording);
    const text = await readFile(outputPath, "utf8");
    const saved: unknown = JSON.parse(text);

    expect(saved).toMatchObject({
      artifactKind: "live_extraction_recording",
      recordingVersion: 1,
      recordingStatus: "complete",
      sourceSnapshot: {
        id: input.snapshot.id,
        contentHash: input.snapshot.contentHash,
      },
      focusedSourceCatalog: {
        sourceSnapshotId: input.snapshot.id,
        sourceSnapshotHash: input.snapshot.contentHash,
      },
      stage1Dto: {
        policyAnalysisId: "analysis_fresh01",
        sourceSnapshotId: input.snapshot.id,
        sourceSnapshotHash: input.snapshot.contentHash,
      },
      stage2Dto: {
        id: "mapping_fresh001",
        sourceSnapshotId: input.snapshot.id,
        sourceSnapshotHash: input.snapshot.contentHash,
      },
      canonicalModel: {
        id: input.outcome.ok ? input.outcome.model.id : "unreachable",
        sourceSnapshotId: input.snapshot.id,
        sourceSnapshotHash: input.snapshot.contentHash,
      },
      evidenceResult: {
        snapshotId: input.snapshot.id,
        snapshotHash: input.snapshot.contentHash,
        procedureModelId: input.outcome.ok ? input.outcome.model.id : "unreachable",
      },
      provenance: {
        stage1: { policyAnalysisId: "analysis_fresh01" },
        stage2: { procedureMappingId: "mapping_fresh001" },
        canonicalModel: { procedureModelId: input.outcome.ok ? input.outcome.model.id : "unreachable" },
        evidenceResult: {
          evidenceResultId: evidenceContextFixture.evidenceResultId,
          procedureModelId: input.outcome.ok ? input.outcome.model.id : "unreachable",
        },
      },
      validationIssues: {
        evidenceIssues: [{ code: "SEMANTIC_REVIEW_REQUIRED" }],
      },
    });
    expect(text).not.toContain("sk-ant-test-secret");
    expect(text).not.toContain("workspace-test-secret");
    expect(text).not.toContain("authorization");
    expect(text).not.toContain("cookie");
    expect(text).not.toContain("headers");
  });

  it("marks failed runs partial while retaining every artifact available before failure", () => {
    const input = successfulRecordingInput();
    const failedOutcome: ExtractionOutcome = {
      ok: false,
      code: "PROCEDURE_MAPPING_INVALID",
      stage: "procedure_mapping",
      modelStage: "procedure_mapping",
      message: "Stage 2 validation failed.",
      issues: ["ruleMappings: missing mapping"],
      attempts: 2,
    };
    const recording = createLiveExtractionRecording({
      createdAt: "2026-10-17T20:00:00.000Z",
      configuration: input.configuration,
      snapshot: input.snapshot,
      outcome: failedOutcome,
      debugEvents: input.debugEvents.slice(0, 5),
      runtimeMs: 1_234,
    });

    expect(recording).toMatchObject({
      recordingStatus: "partial",
      outcome: "typed_failure",
      sourceSnapshot: { id: input.snapshot.id },
      stage1Dto: { policyAnalysisId: "analysis_fresh01" },
      stage2Dto: { id: "mapping_fresh001" },
      canonicalModel: null,
      evidenceResult: null,
      validationIssues: { terminalIssues: ["ruleMappings: missing mapping"] },
    });
  });
});
