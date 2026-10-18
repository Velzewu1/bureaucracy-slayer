import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashCanonical,
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

const RECORDING = "artifacts/live-e2e-A1-2026-10-18T08-46-30-180Z.json";
const CITATION_ONLY_ACTION_IDS = [
  "action_09c41f5cbc77bff37926",
  "action_429f25dd1b451aaf551a",
  "action_e46e0c99da0017a3a8a0",
] as const;
const CITATION_ONLY_ACTION_ID_SET = new Set<string>(CITATION_ONLY_ACTION_IDS);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function savedEvent(
  artifact: Readonly<Record<string, unknown>>,
  kind: "source_selection" | "policy_dto" | "procedure_mapping_dto",
): Readonly<Record<string, unknown>> {
  const events = artifact["debugEvents"];
  if (!Array.isArray(events)) throw new TypeError("Saved A1 diagnostic has no debugEvents array.");
  const event = [...events]
    .reverse()
    .find((candidate) => isRecord(candidate) && candidate["kind"] === kind);
  if (!isRecord(event)) throw new TypeError(`Saved A1 diagnostic has no ${kind} event.`);
  return event;
}

describe("recorded live A1 citation action closure", () => {
  it.runIf(existsSync(RECORDING))(
    "replays citation-only help links without fabricating procedure actions",
    () => {
      const input: unknown = JSON.parse(readFileSync(RECORDING, "utf8"));
      if (!isRecord(input)) throw new TypeError("Saved A1 diagnostic root is invalid.");

      const snapshot = SiteSnapshotSchema.parse(input["snapshot"]);
      const catalog = validateFocusedSourceCatalogBindings(
        snapshot,
        savedEvent(input, "source_selection")["selection"],
      );
      expect(catalog.ok).toBe(true);
      if (!catalog.ok) return;

      const policy = analyzePolicyExtraction(
        savedEvent(input, "policy_dto")["policyDto"],
        catalog.value,
      );
      expect(policy.ok).toBe(true);
      if (!policy.ok) return;
      expect(policy.normalizations).toEqual([]);

      const mapping = validateProcedureMapping(
        savedEvent(input, "procedure_mapping_dto")["procedureMappingDto"],
        policy.value,
        catalog.value,
      );
      expect(mapping.ok).toBe(true);
      if (!mapping.ok) return;

      const mappedOpenAction = mapping.value.actions.find(
        (action) => action.id === "proc_open_transfer_details",
      );
      expect(mappedOpenAction).toMatchObject({
        kind: "navigate",
        label: "Open transfer details",
        websiteActionId: "action_01308461afa4dd6f2e9f",
      });
      const observedActions = snapshot.pages.flatMap((page) => page.actions);
      expect(observedActions.find(
        (action) => action.id === mappedOpenAction?.websiteActionId,
      )).toMatchObject({
        pageId: "page_44413a422562ce6a9bd0",
        kind: "link",
        label: "Canceling a transfer",
        targetUrl: "http://127.0.0.1:5280/help/transfers",
      });
      expect(observedActions.find(
        (action) => action.id === "action_6a53922d08c48a8420c5",
      )).toMatchObject({
        kind: "link",
        label: "View details for Transfer to Alex Morgan",
        targetUrl: "http://127.0.0.1:5280/transfers/tx-001",
      });
      expect(observedActions.find(
        (action) => action.id === "action_e4030ed3d3cd65f58ffe",
      )).toMatchObject({
        pageId: "page_44413a422562ce6a9bd0",
        kind: "button",
        label: "Cancel transfer",
      });

      const referencedActionIds = policy.value.rules
        .flatMap((rule) => rule.citations)
        .flatMap((citation) => citation.websiteActionIds)
        .filter((id) => CITATION_ONLY_ACTION_ID_SET.has(id));
      expect(referencedActionIds).toHaveLength(4);
      expect([...new Set(referencedActionIds)].sort()).toEqual(CITATION_ONLY_ACTION_IDS);

      const converted = replayStagedExtraction(
        policy.value,
        mapping.value,
        snapshot,
        catalog.value,
      );
      expect(converted.ok).toBe(true);
      if (!converted.ok) return;
      expect(ProcedureModelSchema.safeParse(converted.model).success).toBe(true);
      expect(converted.model.actions).toHaveLength(mapping.value.actions.length);
      expect(converted.model.actions.some((action) =>
        action.websiteActionId !== undefined &&
        CITATION_ONLY_ACTION_ID_SET.has(action.websiteActionId)))
        .toBe(false);
      expect(converted.model.rules
        .flatMap((rule) => rule.citations)
        .flatMap((citation) => citation.actionIds)
        .filter((id) => CITATION_ONLY_ACTION_ID_SET.has(id)))
        .toHaveLength(4);

      const audit = auditSemanticQualifiers(snapshot, converted.model);
      expect(audit).toEqual({ findings: [], reviewRequiredRuleIds: [] });
      const validation = validateEvidence(
        snapshot,
        converted.model,
        {
          evidenceResultId: "evidence_livea1replay0001",
          checkedAt: "2026-10-18T08:46:30.180Z",
        },
        audit.findings,
      );
      expect(validation.ok).toBe(true);
      if (!validation.ok) return;
      expect(validation.evidence).toMatchObject({
        status: "valid",
        rejectedRuleIds: [],
        issues: [],
      });

      const state = UserStateSchema.parse({
        schemaVersion: 1,
        revision: 1,
        facts: {
          transfer_status: "Scheduled",
          transfer_type: "standard",
          processing_started: false,
          transfer_submitted: false,
        },
      });
      const evaluation = evaluatePolicies(converted.model, validation.evidence, state);
      const plan = planActions(
        converted.model,
        validation.evidence,
        evaluation,
        state,
        {
          planId: "plan_livea1replay0001",
          generatedAt: "2026-10-18T08:46:30.180Z",
          userStateHash: hashCanonical(state),
        },
      );
      const rejectedRuleIds = new Set(validation.evidence.rejectedRuleIds);
      expect(evaluation.decisions.find((decision) => decision.actionId === "proc_cancel_transfer"))
        .toMatchObject({ status: "allowed", reasonCodes: ["PERMITTED"] });
      expect(evaluation.decisions.find(
        (decision) => decision.actionId === "proc_open_transfer_details",
      )).toMatchObject({ status: "forbidden", reasonCodes: ["NOT_PERMITTED"] });
      expect(plan).toMatchObject({ status: "blocked", reasonCodes: ["NOT_PERMITTED"], steps: [] });
      expect(plan.steps.flatMap((step) => step.citationRuleIds)
        .some((ruleId) => rejectedRuleIds.has(ruleId)))
        .toBe(false);
      expect(plan.steps.every((step) => step.autoExecutable === false)).toBe(true);

      // This is an explicitly synthetic Stage 2 correction used only to compare route semantics.
      // It does not mutate or replace the recorded Sonnet response.
      const correctedMappingInput = {
        ...structuredClone(mapping.value),
        actions: mapping.value.actions
          .filter((action) => action.id !== "proc_open_transfer_details")
          .map((action) => ({
            ...action,
            prerequisiteActionIds: action.prerequisiteActionIds.filter(
              (prerequisiteId) => prerequisiteId !== "proc_open_transfer_details",
            ),
          })),
      };
      const correctedMapping = validateProcedureMapping(
        correctedMappingInput,
        policy.value,
        catalog.value,
      );
      expect(correctedMapping.ok).toBe(true);
      if (!correctedMapping.ok) return;

      const corrected = replayStagedExtraction(
        policy.value,
        correctedMapping.value,
        snapshot,
        catalog.value,
      );
      expect(corrected.ok).toBe(true);
      if (!corrected.ok) return;
      expect(corrected.model.rules).toEqual(converted.model.rules);
      expect(corrected.model.actions.some(
        (action) => action.id === "proc_open_transfer_details",
      )).toBe(false);

      const correctedAudit = auditSemanticQualifiers(snapshot, corrected.model);
      expect(correctedAudit).toEqual({ findings: [], reviewRequiredRuleIds: [] });
      const correctedValidation = validateEvidence(
        snapshot,
        corrected.model,
        {
          evidenceResultId: "evidence_livea1synthetic1",
          checkedAt: "2026-10-18T08:46:30.180Z",
        },
        correctedAudit.findings,
      );
      expect(correctedValidation.ok).toBe(true);
      if (!correctedValidation.ok) return;

      const correctedEvaluation = evaluatePolicies(
        corrected.model,
        correctedValidation.evidence,
        state,
      );
      const correctedPlan = planActions(
        corrected.model,
        correctedValidation.evidence,
        correctedEvaluation,
        state,
        {
          planId: "plan_livea1synthetic01",
          generatedAt: "2026-10-18T08:46:30.180Z",
          userStateHash: hashCanonical(state),
        },
      );
      expect(correctedEvaluation.decisions.find(
        (decision) => decision.actionId === "proc_cancel_transfer",
      )).toMatchObject({ status: "allowed", reasonCodes: ["PERMITTED"] });
      expect(correctedPlan).toMatchObject({
        status: "ready",
        reasonCodes: ["ROUTE_READY"],
        warnings: [],
      });
      expect(correctedPlan.steps.map((step) => step.procedureActionId))
        .toEqual(["proc_cancel_transfer"]);
      expect(correctedPlan.steps.every((step) => step.autoExecutable === false)).toBe(true);
    },
  );
});
