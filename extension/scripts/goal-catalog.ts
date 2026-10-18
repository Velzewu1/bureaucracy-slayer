import { hashCanonical, UserStateSchema, type JsonScalar, type UserState } from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import {
  LIVE_DEMO_CANCELLATION_GOAL,
  LIVE_TEST_UNAUTHORIZED_GOAL,
  NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL,
  createGoalSpecificLiveArtifactFixture,
} from "../../tests/integration/live-extraction/contract-fixtures.js";
import type { GuidanceEnvelope } from "../src/envelope.js";
import { OFFLINE_PROVENANCE } from "../src/goals.js";
import { buildGuidanceEnvelope } from "./envelope-builder.js";

/**
 * Build-time only. Seals one envelope per exact goal and answer combination
 * by running the existing validator, evaluator, and planner. The extension
 * runtime only looks these envelopes up.
 */

const fixedClock = "2026-10-17T00:00:00.000Z";
const VALID_FOR_MS = 15 * 60 * 1000;

const GOALS = [
  { goal: LIVE_DEMO_CANCELLATION_GOAL, sessionId: "demo-goal-cancel" },
  { goal: NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL, sessionId: "demo-goal-recovery" },
  { goal: LIVE_TEST_UNAUTHORIZED_GOAL, sessionId: "demo-goal-unauthorized" },
] as const;

export type CatalogQuestion = Readonly<{
  id: string;
  label: string;
  options: readonly Readonly<{ id: string; label: string }>[];
}>;

export type CatalogOutcome = Readonly<{
  answers: Readonly<Record<string, string>>;
  envelope: GuidanceEnvelope;
}>;

export type CatalogEntry = Readonly<{
  goal: string;
  sessionId: string;
  questions: readonly CatalogQuestion[];
  outcomes: readonly CatalogOutcome[];
}>;

type QuestionSpec = Readonly<{
  id: string;
  label: string;
  factKey: string;
  options: readonly Readonly<{ id: string; label: string; value: JsonScalar }>[];
}>;

type PartialAnswer = Readonly<{
  answers: Readonly<Record<string, string>>;
  facts: Readonly<Record<string, JsonScalar>>;
}>;

export async function buildGoalCatalog(): Promise<readonly CatalogEntry[]> {
  const entries: CatalogEntry[] = [];
  for (const spec of GOALS) {
    const artifact = createGoalSpecificLiveArtifactFixture(spec.goal);
    if (artifact === undefined) throw new Error(`No grounded fixture for the offline goal catalog: ${spec.goal}`);
    const questions = questionSpecs(artifact.procedureModel.factDefinitions);
    const partials = combinations(questions);
    const outcomes: CatalogOutcome[] = [];
    for (const [index, partial] of partials.entries()) {
      const state = userState(partial.facts, index + 1);
      const evaluation = evaluatePolicies(artifact.procedureModel, artifact.evidence, state);
      const plan = planActions(artifact.procedureModel, artifact.evidence, evaluation, state, {
        planId: `plan_${spec.sessionId}_${index.toString(16).padStart(4, "0")}`,
        generatedAt: fixedClock,
        userStateHash: hashCanonical(state),
      });
      outcomes.push({
        answers: partial.answers,
        envelope: await buildGuidanceEnvelope({
          snapshot: artifact.sourceSnapshot,
          model: artifact.procedureModel,
          evidence: artifact.evidence,
          plan,
          goal: spec.goal,
          sessionId: spec.sessionId,
          sequence: 1,
          validForMs: VALID_FOR_MS,
          sourceLabel: OFFLINE_PROVENANCE,
        }),
      });
    }
    entries.push({
      goal: spec.goal,
      sessionId: spec.sessionId,
      questions: questions.map((question) => ({
        id: question.id,
        label: question.label,
        options: question.options.map((option) => ({ id: option.id, label: option.label })),
      })),
      outcomes,
    });
  }
  return entries;
}

function questionSpecs(
  definitions: ReadonlyArray<{
    key: string;
    label: string;
    type: string;
    allowedValues?: readonly JsonScalar[] | undefined;
  }>,
): readonly QuestionSpec[] {
  return definitions.map((definition, index) => {
    const values =
      definition.allowedValues !== undefined
        ? definition.allowedValues
        : definition.type === "boolean"
          ? ([true, false] as const)
          : [];
    if (values.length === 0) throw new Error(`Offline catalog cannot offer choices for ${definition.label}.`);
    return {
      id: `q${index + 1}`,
      label: definition.label,
      factKey: definition.key,
      options: values.map((value, optionIndex) => ({
        id: `o${optionIndex + 1}`,
        label: optionLabel(value),
        value,
      })),
    };
  });
}

function combinations(questions: readonly QuestionSpec[]): readonly PartialAnswer[] {
  let partials: readonly PartialAnswer[] = [{ answers: {}, facts: {} }];
  for (const question of questions) {
    const next: PartialAnswer[] = [];
    for (const partial of partials) {
      next.push(partial);
      for (const option of question.options) {
        next.push({
          answers: { ...partial.answers, [question.id]: option.id },
          facts: { ...partial.facts, [question.factKey]: option.value },
        });
      }
    }
    partials = next;
  }
  return partials;
}

function userState(facts: Readonly<Record<string, JsonScalar>>, revision: number): UserState {
  return UserStateSchema.parse({ schemaVersion: 1, revision, facts });
}

function optionLabel(value: JsonScalar): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (typeof value === "string" && value.length > 0) return value.charAt(0).toUpperCase() + value.slice(1);
  return "Value";
}
