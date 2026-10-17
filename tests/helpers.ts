import {
  ProcedureModelSchema,
  UserStateSchema,
  hashCanonical,
  type EvidenceResult,
  type ProcedureModel,
  type SafeActionPlan,
} from "../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../src/engine/index.js";
import { validateEvidence } from "../src/evidence/index.js";
import { baseSnapshotFixture, evidenceContextFixture, plannerContextFixture } from "./fixtures/p0.js";

export function validatedArtifacts(modelInput: unknown): { model: ProcedureModel; evidence: EvidenceResult } {
  const outcome = validateEvidence(baseSnapshotFixture, modelInput, evidenceContextFixture);
  if (!outcome.ok) throw new Error(`Fixture validation failed: ${outcome.issues.join("; ")}`);
  return { model: outcome.model, evidence: outcome.evidence };
}

export function runPlan(modelInput: unknown, stateInput: unknown): SafeActionPlan {
  const { model, evidence } = validatedArtifacts(modelInput);
  const state = UserStateSchema.parse(stateInput);
  const evaluation = evaluatePolicies(model, evidence, state);
  return planActions(model, evidence, evaluation, state, {
    ...plannerContextFixture,
    userStateHash: hashCanonical(state),
  });
}

export function parseModel(modelInput: unknown): ProcedureModel {
  return ProcedureModelSchema.parse(modelInput);
}

