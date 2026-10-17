import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  EvidenceResultSchema,
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashCanonical,
} from "../src/contracts/index.js";
import { validateEvidence } from "../src/evidence/index.js";
import {
  FocusedSourceCatalogSchema,
  PolicyExtractionDTOSchema,
  ProcedureMappingDTOSchema,
  auditSemanticQualifiers,
  replayStagedExtraction,
  validateFocusedSourceCatalogBindings,
} from "../src/extractor/index.js";
import {
  RecordedExtractionBundleSchema,
  type RecordedExtractionBundle,
} from "../src/ui/recordedBundle.js";

const DebugArtifactSchema = z
  .object({
    configuration: z
      .object({
        environmentSource: z.string(),
        model: z.string().min(1),
        maxTokens: z.number(),
        modelOutputTokenLimit: z.number(),
        collectorUrl: z.string(),
        workspaceConfigured: z.boolean(),
        extractionMode: z.string(),
      })
      .strict(),
    snapshotSummary: z.unknown(),
    sourceSnapshot: SiteSnapshotSchema,
    outcome: z.string(),
    failure: z.unknown(),
    debugEvents: z.array(z.unknown()),
    pipelineSummary: z.unknown(),
  })
  .strict();

const ResumeArtifactSchema = z
  .object({
    artifactKind: z.string(),
    createdAt: z.iso.datetime(),
    provenance: z
      .object({
        stage1Source: z.literal("saved_artifact"),
        sourceArtifactLabel: z.string(),
        reusedSnapshotId: z.string(),
        reusedSnapshotHash: z.string(),
        reusedPolicyAnalysisId: z.string(),
      })
      .strict(),
    configuration: z
      .object({
        model: z.string().min(1),
        maxTokens: z.number(),
        expectedPaidCalls: z.number(),
        retries: z.number(),
      })
      .strict(),
    reusedInputs: z
      .object({
        sourceSnapshot: SiteSnapshotSchema,
        focusedSourceCatalog: FocusedSourceCatalogSchema,
        policyDto: PolicyExtractionDTOSchema,
      })
      .strict(),
    stage2Dto: ProcedureMappingDTOSchema,
    result: z.unknown(),
    debugEvents: z.array(z.unknown()),
  })
  .strict();

const ValidatedArtifactSchema = z
  .object({
    artifactKind: z.string(),
    provenance: z
      .object({
        stage1Source: z.string(),
        stage2Source: z.string(),
        sourceSnapshotId: z.string(),
        sourceSnapshotHash: z.string(),
        policyAnalysisId: z.string(),
        paidCallsDuringReplay: z.literal(0),
      })
      .strict(),
    validation: z.unknown(),
    ruleIdMapping: z.array(z.unknown()),
    procedureModel: ProcedureModelSchema,
    evidenceResult: EvidenceResultSchema,
    evaluatorPlannerScenarios: z.array(
      z
        .object({
          name: z.string().min(1),
          userState: UserStateSchema,
          evaluation: z.unknown(),
          plan: z.unknown(),
        })
        .strict(),
    ).min(1),
  })
  .strict();

export type RecordedArtifactInputs = Readonly<{
  debugArtifact: unknown;
  resumeArtifact: unknown;
  validatedArtifact: unknown;
}>;

function assertEqual(label: string, left: unknown, right: unknown): void {
  if (left !== right) throw new Error(`${label} does not match across recorded artifacts.`);
}

function assertCanonicalEqual(label: string, left: unknown, right: unknown): void {
  if (hashCanonical(left) !== hashCanonical(right)) {
    throw new Error(`${label} does not match across recorded artifacts.`);
  }
}

function isSourceSelectionEvent(
  candidate: unknown,
): candidate is Readonly<{ kind: "source_selection"; selection: unknown }> {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "kind" in candidate &&
    candidate.kind === "source_selection" &&
    "selection" in candidate
  );
}

function sourceSelectionEvent(events: readonly unknown[]): unknown {
  const event = events.find(isSourceSelectionEvent);
  if (event === undefined) {
    throw new Error("The Stage 1 artifact does not contain its source selection event.");
  }
  return event.selection;
}

export function createSanitizedRecordedBundle(
  inputs: RecordedArtifactInputs,
): RecordedExtractionBundle {
  const debug = DebugArtifactSchema.parse(inputs.debugArtifact);
  const resume = ResumeArtifactSchema.parse(inputs.resumeArtifact);
  const validated = ValidatedArtifactSchema.parse(inputs.validatedArtifact);
  const snapshot = debug.sourceSnapshot;
  const catalog = resume.reusedInputs.focusedSourceCatalog;
  const model = validated.procedureModel;

  assertCanonicalEqual("Saved source snapshot", snapshot, resume.reusedInputs.sourceSnapshot);
  assertCanonicalEqual("Focused source selection", sourceSelectionEvent(debug.debugEvents), catalog);
  assertEqual("Snapshot ID", snapshot.id, resume.provenance.reusedSnapshotId);
  assertEqual("Snapshot hash", snapshot.contentHash, resume.provenance.reusedSnapshotHash);
  assertEqual("Validated snapshot ID", snapshot.id, validated.provenance.sourceSnapshotId);
  assertEqual("Validated snapshot hash", snapshot.contentHash, validated.provenance.sourceSnapshotHash);
  assertEqual("Model name", debug.configuration.model, resume.configuration.model);
  assertEqual("Policy analysis ID", resume.provenance.reusedPolicyAnalysisId, validated.provenance.policyAnalysisId);
  assertEqual("Procedure model ID", resume.stage2Dto.id, model.id);
  assertEqual("Procedure model goal summary", resume.stage2Dto.goalSummary, model.goalSummary);

  const sourceBinding = validateFocusedSourceCatalogBindings(snapshot, catalog);
  if (!sourceBinding.ok) {
    throw new Error(`Focused source binding failed: ${sourceBinding.issues.join(" ")}`);
  }

  const replay = replayStagedExtraction(
    resume.reusedInputs.policyDto,
    resume.stage2Dto,
    snapshot,
    catalog,
  );
  if (!replay.ok) {
    throw new Error(`Recorded extraction replay failed at ${replay.stage}: ${replay.issues.join(" ")}`);
  }
  assertCanonicalEqual("Replayed canonical ProcedureModel", replay.model, model);

  const audit = auditSemanticQualifiers(snapshot, model);
  const evidenceOutcome = validateEvidence(
    snapshot,
    model,
    {
      evidenceResultId: validated.evidenceResult.id,
      checkedAt: validated.evidenceResult.checkedAt,
    },
    audit.findings.map((finding) => ({ ruleId: finding.ruleId, message: finding.message })),
  );
  if (!evidenceOutcome.ok) {
    throw new Error(`Recorded evidence validation failed at ${evidenceOutcome.stage}.`);
  }
  const evidence = evidenceOutcome.evidence;
  assertCanonicalEqual(
    "Evidence rule disposition",
    {
      status: evidence.status,
      validRuleIds: evidence.validRuleIds,
      rejectedRuleIds: evidence.rejectedRuleIds,
    },
    {
      status: validated.evidenceResult.status,
      validRuleIds: validated.evidenceResult.validRuleIds,
      rejectedRuleIds: validated.evidenceResult.rejectedRuleIds,
    },
  );

  const defaultScenario = validated.evaluatorPlannerScenarios[0];
  if (defaultScenario === undefined) throw new Error("No recorded evaluator scenario is available.");

  return RecordedExtractionBundleSchema.parse({
    schemaVersion: 1,
    artifactKind: "sanitized_recorded_sonnet_extraction",
    extractionGoal: catalog.userGoal,
    goalScope: catalog.goalScope,
    sourceSnapshot: snapshot,
    procedureModel: model,
    buildTimeEvidence: evidence,
    defaultScenario: {
      name: defaultScenario.name,
      userState: defaultScenario.userState,
    },
    sourceSelection: {
      selectionMode: catalog.selectionMode ?? "general",
      semanticCoverage: catalog.semanticCoverage ?? "not_verified",
      coverage: catalog.coverage,
      limitations: catalog.limitations,
      originalCounts: catalog.originalCounts,
      selectedCounts: catalog.selectedCounts,
      selectedPageIds: catalog.pages.map((page) => page.pageId),
    },
    identity: {
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contentHash,
      modelId: model.id,
    },
    semanticAudit: audit,
    provenance: {
      extractionType: "previously_recorded",
      modelName: resume.configuration.model,
      recordedAt: resume.createdAt,
      sourceArtifacts: [
        "artifacts/live-extraction-debug.json",
        "artifacts/live-stage2-resume-2026-10-17T10-00-46-689Z-2d218849.json",
        "artifacts/validated-offline-demo-2026-10-17.json",
      ],
      stage1Source: "saved_artifact",
      stage2Source: "saved_artifact",
      policyAnalysisId: validated.provenance.policyAnalysisId,
      paidCallsDuringReplay: validated.provenance.paidCallsDuringReplay,
    },
  });
}

async function readJson(path: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsed;
}

export async function buildRecordedExtractionBundle(): Promise<RecordedExtractionBundle> {
  const bundle = createSanitizedRecordedBundle({
    debugArtifact: await readJson("artifacts/live-extraction-debug.json"),
    resumeArtifact: await readJson(
      "artifacts/live-stage2-resume-2026-10-17T10-00-46-689Z-2d218849.json",
    ),
    validatedArtifact: await readJson("artifacts/validated-offline-demo-2026-10-17.json"),
  });
  const moduleText = [
    "// Generated by scripts/build-recorded-extraction-bundle.ts. Do not edit by hand.",
    "// Contains sanitized recorded inputs only; raw Claude envelopes are intentionally excluded.",
    `export const recordedSonnetBundleInput: unknown = ${JSON.stringify(bundle, null, 2)};`,
    "",
  ].join("\n");
  await mkdir("src/ui/generated", { recursive: true });
  await writeFile("src/ui/generated/recordedSonnetBundle.ts", moduleText, "utf8");
  return bundle;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  const bundle = await buildRecordedExtractionBundle();
  process.stdout.write(
    `Built recorded Sonnet bundle for ${bundle.identity.modelId} (${bundle.procedureModel.rules.length} rules).\n`,
  );
}
