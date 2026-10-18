import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashCanonical,
  type PolicyCondition,
  type ProcedureModel,
  type SiteSnapshot,
} from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import { auditSemanticQualifiers } from "../../src/extractor/index.js";

const A3_RECORDING = "artifacts/live-a3-unauthorized-2026-10-18T09-46-05-378Z.json";
const A2_RECORDING = "artifacts/live-a2-recovery-2026-10-18T09-36-55-015Z.json";
const FIXED_AT = "2026-10-18T09:50:00.000Z";

type SavedLiveArtifact = Readonly<{
  snapshot: SiteSnapshot;
  model: ProcedureModel;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadSavedArtifact(path: string): SavedLiveArtifact {
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(input) || !isRecord(input["outcome"])) {
    throw new TypeError(`Saved live artifact ${path} is invalid.`);
  }
  return {
    snapshot: SiteSnapshotSchema.parse(input["snapshot"]),
    model: ProcedureModelSchema.parse(input["outcome"]["model"]),
  };
}

function validated(
  snapshot: SiteSnapshot,
  model: ProcedureModel,
  evidenceResultId: string,
) {
  const semanticAudit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    { evidenceResultId, checkedAt: FIXED_AT },
    semanticAudit.findings.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
    })),
  );
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new TypeError(validation.issues.join("; "));
  return { semanticAudit, evidence: validation.evidence };
}

function decide(
  snapshot: SiteSnapshot,
  model: ProcedureModel,
  facts: Readonly<Record<string, string | number | boolean>>,
  revision: number,
  suffix: string,
) {
  const { semanticAudit, evidence } = validated(
    snapshot,
    model,
    `evidence_synthetic_${suffix}`,
  );
  const state = UserStateSchema.parse({ schemaVersion: 1, revision, facts });
  const evaluation = evaluatePolicies(model, evidence, state);
  const plan = planActions(model, evidence, evaluation, state, {
    planId: `plan_synthetic_${suffix}`,
    generatedAt: FIXED_AT,
    userStateHash: hashCanonical(state),
  });
  return { semanticAudit, evidence, evaluation, plan };
}

function requireCondition(
  model: ProcedureModel,
  ruleId: string,
  requirement: PolicyCondition,
): ProcedureModel["rules"][number] {
  const rule = model.rules.find((candidate) => candidate.id === ruleId);
  if (rule?.effect !== "require_action") {
    throw new TypeError(`Expected ${ruleId} to be a require_action rule.`);
  }
  const { requiredActionId: _requiredActionId, ...base } = rule;
  return { ...base, effect: "require_condition", requirement };
}

function correctedA3Model(original: ProcedureModel): ProcedureModel {
  const removedActionIds = new Set([
    "act_identify_transfer",
    "act_provide_date_first_noticed",
    "act_state_account_secured",
  ]);
  const replacements = new Map<string, ProcedureModel["rules"][number]>([
    [
      "rule_require_identify_transfer",
      requireCondition(original, "rule_require_identify_transfer", {
        kind: "any",
        conditions: [
          { kind: "fact", fact: "transfer_reference_available", op: "eq", value: true },
          {
            kind: "all",
            conditions: [
              { kind: "fact", fact: "transfer_date_available", op: "eq", value: true },
              { kind: "fact", fact: "transfer_amount_available", op: "eq", value: true },
            ],
          },
        ],
      }),
    ],
    [
      "rule_require_date_first_noticed",
      requireCondition(original, "rule_require_date_first_noticed", {
        kind: "fact",
        fact: "first_notice_date_available",
        op: "eq",
        value: true,
      }),
    ],
    [
      "rule_require_account_secured_status",
      requireCondition(original, "rule_require_account_secured_status", {
        kind: "any",
        conditions: [
          { kind: "fact", fact: "account_secured", op: "eq", value: true },
          { kind: "fact", fact: "account_secured", op: "eq", value: false },
        ],
      }),
    ],
  ]);

  return ProcedureModelSchema.parse({
    ...structuredClone(original),
    id: "procedure_synthetic_a3_information_requirements",
    factDefinitions: [
      ...original.factDefinitions,
      {
        key: "transfer_reference_available",
        label: "Transfer reference number is available",
        type: "boolean",
        sensitive: false,
      },
      {
        key: "transfer_date_available",
        label: "Transfer date is available",
        type: "boolean",
        sensitive: false,
      },
      {
        key: "transfer_amount_available",
        label: "Transfer amount is available",
        type: "boolean",
        sensitive: false,
      },
      {
        key: "first_notice_date_available",
        label: "Date first noticed is available",
        type: "boolean",
        sensitive: false,
      },
      {
        key: "account_secured",
        label: "Account has been secured",
        type: "boolean",
        sensitive: false,
      },
    ],
    actions: original.actions.filter((action) => !removedActionIds.has(action.id)),
    rules: original.rules.map((rule) => replacements.get(rule.id) ?? rule),
  });
}

function correctedA2Model(original: ProcedureModel): ProcedureModel {
  const removedActionIds = new Set([
    "proc_provide_reference_number",
    "proc_provide_recipient_information",
    "proc_provide_description_and_email",
  ]);
  const replacements = new Map<string, ProcedureModel["rules"][number]>([
    [
      "rule_require_action_reference_number",
      requireCondition(original, "rule_require_action_reference_number", {
        kind: "fact",
        fact: "recovery_reference_available",
        op: "eq",
        value: true,
      }),
    ],
    [
      "rule_require_action_recipient_information",
      requireCondition(original, "rule_require_action_recipient_information", {
        kind: "all",
        conditions: [
          { kind: "fact", fact: "recipient_name_available", op: "eq", value: true },
          { kind: "fact", fact: "recipient_bank_available", op: "eq", value: true },
          { kind: "fact", fact: "recipient_account_last_four_available", op: "eq", value: true },
        ],
      }),
    ],
    [
      "rule_require_action_description_and_email",
      requireCondition(original, "rule_require_action_description_and_email", {
        kind: "all",
        conditions: [
          { kind: "fact", fact: "recovery_description_available", op: "eq", value: true },
          { kind: "fact", fact: "contact_email_available", op: "eq", value: true },
        ],
      }),
    ],
  ]);

  return ProcedureModelSchema.parse({
    ...structuredClone(original),
    id: "procedure_synthetic_a2_information_requirements",
    factDefinitions: [
      ...original.factDefinitions,
      ...[
        ["recovery_reference_available", "Transaction reference number is available"],
        ["recipient_name_available", "Recipient name is available"],
        ["recipient_bank_available", "Recipient bank is available"],
        ["recipient_account_last_four_available", "Recipient account last four digits are available"],
        ["recovery_description_available", "Description of what happened is available"],
        ["contact_email_available", "Contact email is available"],
      ].map(([key, label]) => ({ key, label, type: "boolean", sensitive: false })),
    ],
    actions: original.actions
      .filter((action) => !removedActionIds.has(action.id))
      .map((action) => ({
        ...action,
        prerequisiteActionIds: action.prerequisiteActionIds.filter(
          (actionId) => !removedActionIds.has(actionId),
        ),
      })),
    rules: original.rules.map((rule) => replacements.get(rule.id) ?? rule),
  });
}

describe("saved live information-requirement modeling", () => {
  it.runIf(existsSync(A3_RECORDING))(
    "keeps original A3 blocked but makes the fact-modeled synthetic variant ready only with required information",
    () => {
      const { snapshot, model: original } = loadSavedArtifact(A3_RECORDING);
      const originalResult = decide(
        snapshot,
        original,
        {
          user_started_transfer: false,
          user_gave_permission_to_start: false,
        },
        1,
        "a3_original01",
      );
      expect(originalResult.semanticAudit.findings).toEqual([]);
      expect(originalResult.evidence.status).toBe("valid");
      expect(originalResult.evaluation.decisions.find(
        (decision) => decision.actionId === "act_submit_unauthorized_report",
      )).toMatchObject({ status: "allowed", reasonCodes: ["PERMITTED"] });
      for (const actionId of [
        "act_identify_transfer",
        "act_provide_date_first_noticed",
        "act_state_account_secured",
      ]) {
        expect(originalResult.evaluation.decisions.find(
          (decision) => decision.actionId === actionId,
        )).toMatchObject({ status: "forbidden", reasonCodes: ["NOT_PERMITTED"] });
      }
      expect(originalResult.plan).toMatchObject({
        status: "blocked",
        reasonCodes: ["NOT_PERMITTED"],
        steps: [],
      });

      // Synthetic variant only: the saved Sonnet artifact remains unchanged.
      const corrected = correctedA3Model(original);
      expect(ProcedureModelSchema.safeParse(corrected).success).toBe(true);
      expect(corrected.actions.some((action) => action.kind === "user_task")).toBe(false);
      expect(corrected.rules.filter((rule) => rule.effect === "require_condition")).toHaveLength(3);
      for (const ruleId of [
        "rule_require_identify_transfer",
        "rule_require_date_first_noticed",
        "rule_require_account_secured_status",
      ]) {
        expect(corrected.rules.find((rule) => rule.id === ruleId)?.citations)
          .toEqual(original.rules.find((rule) => rule.id === ruleId)?.citations);
      }

      const missing = decide(
        snapshot,
        corrected,
        {
          user_started_transfer: false,
          user_gave_permission_to_start: false,
        },
        2,
        "a3_missing001",
      );
      expect(missing.plan.status).toBe("needs_information");
      expect(missing.plan.steps).toEqual([]);
      expect(missing.plan.missingFacts).toEqual(expect.arrayContaining([
        "account_secured",
        "first_notice_date_available",
        "transfer_reference_available",
      ]));

      const referencePath = decide(
        snapshot,
        corrected,
        {
          user_started_transfer: false,
          user_gave_permission_to_start: false,
          transfer_reference_available: true,
          first_notice_date_available: true,
          account_secured: false,
        },
        3,
        "a3_reference1",
      );
      expect(referencePath.plan.status).toBe("ready");
      expect(referencePath.plan.steps.map((step) => step.procedureActionId))
        .toEqual(["act_submit_unauthorized_report"]);
      expect(referencePath.plan.steps.every((step) =>
        step.requiresUserConfirmation && step.autoExecutable === false))
        .toBe(true);
      expect(referencePath.plan.steps[0]?.citationRuleIds).toEqual(expect.arrayContaining([
        "rule_permit_submit_unauthorized_report",
        "rule_require_identify_transfer",
        "rule_require_date_first_noticed",
        "rule_require_account_secured_status",
      ]));
      expect(referencePath.evaluation.decisions.find(
        (decision) => decision.actionId === "act_submit_mistaken_report",
      )).toMatchObject({ status: "forbidden", reasonCodes: ["PROHIBITED"] });
      expect(referencePath.evaluation.decisions.find(
        (decision) => decision.actionId === "act_submit_recovery_request",
      )).toMatchObject({ status: "forbidden", reasonCodes: ["PROHIBITED"] });

      const dateAndAmountPath = decide(
        snapshot,
        corrected,
        {
          user_started_transfer: false,
          user_gave_permission_to_start: false,
          transfer_reference_available: false,
          transfer_date_available: true,
          transfer_amount_available: true,
          first_notice_date_available: true,
          account_secured: true,
        },
        4,
        "a3_dateamount",
      );
      expect(dateAndAmountPath.plan.status).toBe("ready");

      const selfStarted = decide(
        snapshot,
        corrected,
        {
          user_started_transfer: true,
          user_gave_permission_to_start: false,
          transfer_reference_available: true,
          first_notice_date_available: true,
          account_secured: true,
        },
        5,
        "a3_selfstart1",
      );
      expect(selfStarted.evaluation.decisions.find(
        (decision) => decision.actionId === "act_submit_unauthorized_report",
      )).toMatchObject({ status: "forbidden", reasonCodes: ["PROHIBITED"] });
      expect(selfStarted.plan.status).toBe("blocked");
    },
  );

  it.runIf(existsSync(A2_RECORDING))(
    "keeps A2 under semantic review after converting information tasks to conditions",
    () => {
      const { snapshot, model: original } = loadSavedArtifact(A2_RECORDING);
      const corrected = correctedA2Model(original);
      expect(ProcedureModelSchema.safeParse(corrected).success).toBe(true);
      const result = decide(
        snapshot,
        corrected,
        {
          transfer_status: "completed",
          transfer_initiated_by_user: true,
          recovery_reference_available: true,
          recipient_name_available: true,
          recipient_bank_available: true,
          recipient_account_last_four_available: true,
          recovery_description_available: true,
          contact_email_available: true,
        },
        1,
        "a2_corrected1",
      );

      expect(result.semanticAudit.reviewRequiredRuleIds)
        .toContain("rule_permit_recovery_request");
      expect(result.evidence.rejectedRuleIds).toContain("rule_permit_recovery_request");
      expect(result.evaluation.decisions.find(
        (decision) => decision.actionId === "proc_submit_recovery_request",
      )).toMatchObject({ status: "review", reasonCodes: ["EVIDENCE_REJECTED"] });
      expect(result.plan).toMatchObject({
        status: "review_required",
        steps: [],
      });
      expect(result.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
    },
  );
});
