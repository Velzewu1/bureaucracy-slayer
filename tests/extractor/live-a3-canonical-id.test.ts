import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashCanonical,
  type EvidenceResult,
  type ProcedureModel,
} from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import {
  analyzePolicyExtraction,
  auditSemanticQualifiers,
  replayStagedExtraction,
  validateFocusedSourceCatalogBindings,
  validateProcedureMapping,
} from "../../src/extractor/index.js";

const RECORDING = "artifacts/live-a3-information-rerun-2026-10-18T10-13-12-569Z.json";
const A1_RECORDING = "artifacts/live-a1-prerequisite-repair-2026-10-18T09-29-07-709Z.json";
const A2_RECORDING = "artifacts/live-a2-recovery-2026-10-18T09-36-55-015Z.json";
const FIXED_AT = "2026-10-18T10:13:12.569Z";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function event(
  artifact: Readonly<Record<string, unknown>>,
  kind: "source_selection" | "policy_dto" | "procedure_mapping_dto",
): Readonly<Record<string, unknown>> {
  const events = artifact["debugEvents"];
  if (!Array.isArray(events)) throw new TypeError("Saved A3 artifact has no debug events.");
  const found = [...events].reverse().find(
    (candidate) => isRecord(candidate) && candidate["kind"] === kind,
  );
  if (!isRecord(found)) throw new TypeError(`Saved A3 artifact has no ${kind} event.`);
  return found;
}

function decide(
  model: ProcedureModel,
  evidence: EvidenceResult,
  facts: Readonly<Record<string, string | number | boolean>>,
  revision: number,
  suffix: string,
) {
  const state = UserStateSchema.parse({ schemaVersion: 1, revision, facts });
  const evaluation = evaluatePolicies(model, evidence, state);
  const plan = planActions(model, evidence, evaluation, state, {
    planId: `plan_${suffix}`,
    generatedAt: FIXED_AT,
    userStateHash: hashCanonical(state),
  });
  return { evaluation, plan };
}

describe("recorded Live A3 canonical model identity", () => {
  it.runIf(existsSync(RECORDING))(
    "replays the untouched staged DTO through audit, evidence, and the five-state matrix",
    () => {
      const input: unknown = JSON.parse(readFileSync(RECORDING, "utf8"));
      if (!isRecord(input)) throw new TypeError("Saved A3 artifact root is invalid.");
      const snapshot = SiteSnapshotSchema.parse(input["snapshot"]);
      const catalog = validateFocusedSourceCatalogBindings(
        snapshot,
        event(input, "source_selection")["selection"],
      );
      expect(catalog.ok).toBe(true);
      if (!catalog.ok) return;

      const policy = analyzePolicyExtraction(
        event(input, "policy_dto")["policyDto"],
        catalog.value,
      );
      expect(policy.ok).toBe(true);
      if (!policy.ok) return;
      const rawMapping = event(input, "procedure_mapping_dto")["procedureMappingDto"];
      expect(isRecord(rawMapping) ? rawMapping["id"] : undefined)
        .toBe("stage2_unauthorized_transfer_report");
      const mapping = validateProcedureMapping(rawMapping, policy.value, catalog.value);
      expect(mapping.ok).toBe(true);
      if (!mapping.ok) return;

      const first = replayStagedExtraction(policy.value, mapping.value, snapshot, catalog.value);
      const second = replayStagedExtraction(policy.value, mapping.value, snapshot, catalog.value);
      expect(first).toEqual(second);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(mapping.value.id).toBe("stage2_unauthorized_transfer_report");
      expect(first.model.id).toMatch(/^procedure_[a-f0-9]{64}$/u);
      expect(first.normalizations).toContainEqual({
        code: "CANONICAL_PROCEDURE_MODEL_ID_ASSIGNED",
        originalProcedureModelId: "stage2_unauthorized_transfer_report",
        canonicalProcedureModelId: first.model.id,
      });
      expect(ProcedureModelSchema.safeParse(first.model).success).toBe(true);
      expect(first.model).toMatchObject({
        sourceSnapshotId: snapshot.id,
        sourceSnapshotHash: snapshot.contentHash,
        goalActionIds: ["proc_submit_unauthorized_report"],
      });
      expect(first.model.actions).toEqual([
        expect.objectContaining({
          id: "proc_submit_unauthorized_report",
          websiteActionId: "action_5473c00dc9a38bf3f2f7",
          prerequisiteActionIds: [],
          terminal: true,
        }),
      ]);
      expect(first.model.actions.some((action) => action.kind === "user_task")).toBe(false);
      expect(first.model.actions.some((action) => /mistaken|recover/iu.test(action.label))).toBe(false);
      expect(first.model.rules.filter((rule) => rule.effect === "require_condition")).toHaveLength(3);
      expect(first.model.rules.some((rule) => rule.effect === "require_action")).toBe(false);

      const audit = auditSemanticQualifiers(snapshot, first.model);
      expect(audit).toEqual({ findings: [], reviewRequiredRuleIds: [] });
      const validation = validateEvidence(
        snapshot,
        first.model,
        { evidenceResultId: "evidence_livea3canonical01", checkedAt: FIXED_AT },
        audit.findings,
      );
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      expect(validation.evidence).toMatchObject({
        status: "valid",
        snapshotId: snapshot.id,
        snapshotHash: snapshot.contentHash,
        procedureModelId: first.model.id,
        rejectedRuleIds: [],
        issues: [],
      });
      expect(validation.evidence.validRuleIds).toHaveLength(5);

      const unauthorized = {
        user_started_transfer: false,
        user_gave_permission_to_start: false,
      } as const;
      const missing = decide(
        first.model,
        validation.evidence,
        unauthorized,
        1,
        "livea3missing01",
      );
      expect(missing.plan).toMatchObject({ status: "needs_information", steps: [] });

      const reference = decide(
        first.model,
        validation.evidence,
        {
          ...unauthorized,
          reference_number_available: true,
          first_noticed_date_supplied: true,
          account_secured: true,
        },
        2,
        "livea3reference1",
      );
      expect(reference.plan.status).toBe("ready");

      const dateAndAmount = decide(
        first.model,
        validation.evidence,
        {
          ...unauthorized,
          reference_number_available: false,
          transfer_date_available: true,
          transfer_amount_available: true,
          first_noticed_date_supplied: true,
          account_secured: true,
        },
        3,
        "livea3dateamount",
      );
      expect(dateAndAmount.plan.status).toBe("ready");

      const notSecured = decide(
        first.model,
        validation.evidence,
        {
          ...unauthorized,
          reference_number_available: true,
          first_noticed_date_supplied: true,
          account_secured: false,
        },
        4,
        "livea3notsecured",
      );
      expect(notSecured.plan.status).toBe("ready");

      const authorized = decide(
        first.model,
        validation.evidence,
        {
          user_started_transfer: false,
          user_gave_permission_to_start: true,
          reference_number_available: true,
          first_noticed_date_supplied: true,
          account_secured: true,
        },
        5,
        "livea3authorized",
      );
      expect(authorized.evaluation.decisions[0]).toMatchObject({
        actionId: "proc_submit_unauthorized_report",
        status: "forbidden",
        reasonCodes: ["NOT_PERMITTED"],
      });
      expect(authorized.plan).toMatchObject({ status: "blocked", steps: [] });

      for (const result of [reference, dateAndAmount, notSecured]) {
        expect(result.plan.steps.map((step) => step.procedureActionId))
          .toEqual(["proc_submit_unauthorized_report"]);
        expect(result.plan.steps.every((step) =>
          step.requiresUserConfirmation && step.autoExecutable === false)).toBe(true);
      }
    },
  );
});

describe("recorded Northstar regression outcomes", () => {
  function loadCompletedRecording(path: string): Readonly<{
    snapshot: ReturnType<typeof SiteSnapshotSchema.parse>;
    model: ReturnType<typeof ProcedureModelSchema.parse>;
  }> {
    const input: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(input) || !isRecord(input["outcome"])) {
      throw new TypeError(`Saved recording ${path} is invalid.`);
    }
    return {
      snapshot: SiteSnapshotSchema.parse(input["snapshot"]),
      model: ProcedureModelSchema.parse(input["outcome"]["model"]),
    };
  }

  it.runIf(existsSync(A1_RECORDING))("keeps the repaired recorded A1 route ready", () => {
    const { snapshot, model } = loadCompletedRecording(A1_RECORDING);
    const audit = auditSemanticQualifiers(snapshot, model);
    expect(audit.findings).toEqual([]);
    const validation = validateEvidence(
      snapshot,
      model,
      { evidenceResultId: "evidence_livea1regress01", checkedAt: FIXED_AT },
      audit.findings,
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    const result = decide(
      model,
      validation.evidence,
      { transfer_status: "scheduled", transfer_type: "standard", processing_started: false },
      1,
      "livea1regress01",
    );
    expect(result.plan.status).toBe("ready");
    expect(result.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
  });

  it.runIf(existsSync(A2_RECORDING))("keeps the recorded A2 permit under review", () => {
    const { snapshot, model } = loadCompletedRecording(A2_RECORDING);
    const audit = auditSemanticQualifiers(snapshot, model);
    expect(audit.reviewRequiredRuleIds).toContain("rule_permit_recovery_request");
    const validation = validateEvidence(
      snapshot,
      model,
      { evidenceResultId: "evidence_livea2regress01", checkedAt: FIXED_AT },
      audit.findings,
    );
    expect(validation.ok).toBe(true);
    if (!validation.ok) return;
    expect(validation.evidence.rejectedRuleIds).toContain("rule_permit_recovery_request");
    const result = decide(
      model,
      validation.evidence,
      { transfer_status: "completed", transfer_initiated_by_user: true },
      1,
      "livea2regress01",
    );
    expect(result.plan.status).toBe("review_required");
    expect(result.plan.steps).toEqual([]);
  });
});
