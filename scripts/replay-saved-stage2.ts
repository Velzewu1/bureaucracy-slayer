import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashCanonical,
  type JsonScalar,
} from "../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../src/engine/index.js";
import { validateEvidence } from "../src/evidence/index.js";
import {
  analyzePolicyExtraction,
  convertStagedExtraction,
  validateFocusedSourceCatalogBindings,
  validateProcedureMapping,
} from "../src/extractor/index.js";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_STAGE1 = "artifacts/live-extraction-debug.json";
const DEFAULT_STAGE2 =
  "artifacts/live-stage2-resume-2026-10-17T10-00-46-689Z-2d218849.json";
const DEFAULT_OUTPUT = "artifacts/validated-offline-demo-2026-10-17.json";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function savedEvent(
  artifact: Readonly<Record<string, unknown>>,
  kind: "source_selection" | "policy_dto",
): Readonly<Record<string, unknown>> {
  const events = artifact["debugEvents"];
  if (!Array.isArray(events)) throw new Error("Stage 1 artifact has no debugEvents array.");
  const event = [...events]
    .reverse()
    .find((candidate) => isRecord(candidate) && candidate["kind"] === kind);
  if (!isRecord(event)) throw new Error(`Stage 1 artifact has no ${kind} event.`);
  return event;
}

function demoScenarios(): readonly Readonly<{
  name: string;
  facts: Readonly<Record<string, JsonScalar>>;
}>[] {
  return [
    {
      name: "scheduled_not_started",
      facts: {
        transfer_status: "scheduled",
        processing_started: false,
        initiated_by_user: true,
        transfer_type: "scheduled",
      },
    },
    {
      name: "completed_self_initiated",
      facts: {
        transfer_status: "completed",
        processing_started: true,
        initiated_by_user: true,
        transfer_type: "scheduled",
      },
    },
    {
      name: "completed_not_self_initiated",
      facts: {
        transfer_status: "completed",
        processing_started: true,
        initiated_by_user: false,
        transfer_type: "scheduled",
      },
    },
    {
      name: "instant_completed_self_initiated",
      facts: {
        transfer_status: "completed",
        processing_started: true,
        initiated_by_user: true,
        transfer_type: "instant",
      },
    },
  ];
}

export async function replaySavedStage2(
  stage1PathInput = DEFAULT_STAGE1,
  stage2PathInput = DEFAULT_STAGE2,
): Promise<Readonly<Record<string, unknown>>> {
  const stage1Path = resolve(PROJECT_ROOT, stage1PathInput);
  const stage2Path = resolve(PROJECT_ROOT, stage2PathInput);
  const stage1Input: unknown = JSON.parse(await readFile(stage1Path, "utf8"));
  const stage2Input: unknown = JSON.parse(await readFile(stage2Path, "utf8"));
  if (!isRecord(stage1Input) || !isRecord(stage2Input)) {
    throw new Error("Both saved artifact roots must be objects.");
  }

  const snapshot = SiteSnapshotSchema.parse(stage1Input["sourceSnapshot"]);
  const catalog = validateFocusedSourceCatalogBindings(
    snapshot,
    savedEvent(stage1Input, "source_selection")["selection"],
  );
  if (!catalog.ok) throw new Error(`Focused-source validation failed: ${catalog.issues.join("; ")}`);

  const policy = analyzePolicyExtraction(
    savedEvent(stage1Input, "policy_dto")["policyDto"],
    catalog.value,
  );
  if (!policy.ok) throw new Error(`Stage 1 validation failed: ${policy.issues.join("; ")}`);
  if (policy.normalizations.length > 0) {
    throw new Error("Stage 1 replay unexpectedly requires normalization.");
  }

  const mapping = validateProcedureMapping(stage2Input["stage2Dto"], policy.value, catalog.value);
  if (!mapping.ok) throw new Error(`Stage 2 validation failed: ${mapping.issues.join("; ")}`);
  const converted = convertStagedExtraction(policy.value, mapping.value, snapshot, catalog.value);
  if (!converted.ok) {
    throw new Error(`Canonical conversion failed at ${converted.stage}: ${converted.issues.join("; ")}`);
  }
  const unexpectedNormalizations = converted.normalizations.filter(
    (item) => item.code !== "CANONICAL_RULE_ID_NORMALIZED",
  );
  if (unexpectedNormalizations.length > 0) {
    throw new Error("Replay required an unexpected non-rule-ID normalization.");
  }
  const model = ProcedureModelSchema.parse(converted.model);
  const checkedAt = typeof stage2Input["createdAt"] === "string"
    ? stage2Input["createdAt"]
    : model.extractedAt;
  const evidence = validateEvidence(snapshot, model, {
    evidenceResultId: "evidence_offlinedemo01",
    checkedAt,
  });
  if (!evidence.ok) throw new Error(`Evidence validation failed: ${evidence.issues.join("; ")}`);

  const scenarioResults = demoScenarios().map((scenario, index) => {
    const state = UserStateSchema.parse({ schemaVersion: 1, revision: index + 1, facts: scenario.facts });
    const evaluation = evaluatePolicies(model, evidence.evidence, state);
    const plan = planActions(model, evidence.evidence, evaluation, state, {
      planId: `plan_offlinedemo0${index + 1}`,
      generatedAt: checkedAt,
      userStateHash: hashCanonical(state),
    });
    return { name: scenario.name, userState: state, evaluation, plan };
  });

  return Object.freeze({
    artifactKind: "validated_offline_demo_from_saved_stage1_and_stage2",
    provenance: {
      stage1Source: basename(stage1Path),
      stage2Source: basename(stage2Path),
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      policyAnalysisId: policy.value.policyAnalysisId,
      paidCallsDuringReplay: 0,
    },
    validation: {
      stage1: "valid",
      stage1Normalizations: policy.normalizations,
      stage2: "valid",
      canonicalSchema: "valid",
      evidence: evidence.evidence.status,
    },
    ruleIdMapping: converted.normalizations.filter(
      (item) => item.code === "CANONICAL_RULE_ID_NORMALIZED",
    ),
    procedureModel: model,
    evidenceResult: evidence.evidence,
    evaluatorPlannerScenarios: scenarioResults,
  });
}

async function main(): Promise<void> {
  const stage1Path = process.argv[2] ?? DEFAULT_STAGE1;
  const stage2Path = process.argv[3] ?? DEFAULT_STAGE2;
  const outputPath = resolve(PROJECT_ROOT, process.argv[4] ?? DEFAULT_OUTPUT);
  const artifact = await replaySavedStage2(stage1Path, stage2Path);
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ outputPath, validation: artifact["validation"] }, null, 2)}\n`);
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Offline replay failed."}\n`);
    process.exitCode = 1;
  });
}
