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
    },
  );
});
