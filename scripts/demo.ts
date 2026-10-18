import { UserStateSchema, hashCanonical } from "../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../src/engine/index.js";
import { validateEvidence } from "../src/evidence/index.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  completedStateFixture,
  conflictingEvidenceModelFixture,
  evidenceContextFixture,
  plannerContextFixture,
  scheduledInstantStateFixture,
  scheduledStandardStateFixture,
  unknownMethodStateFixture,
  wrongQuoteModelFixture,
} from "../tests/fixtures/p0.js";

const scenarioFlag = process.argv.indexOf("--scenario");
const scenario = scenarioFlag >= 0 ? process.argv[scenarioFlag + 1] : "valid";

const scenarios: Readonly<Record<string, Readonly<{ model: unknown; state: unknown }>>> = {
  valid: { model: baseProcedureModelFixture, state: scheduledStandardStateFixture },
  exception: { model: baseProcedureModelFixture, state: scheduledInstantStateFixture },
  completed: { model: baseProcedureModelFixture, state: completedStateFixture },
  unknown: { model: baseProcedureModelFixture, state: unknownMethodStateFixture },
  "trust-failure": { model: wrongQuoteModelFixture, state: scheduledStandardStateFixture },
  conflict: { model: conflictingEvidenceModelFixture, state: scheduledInstantStateFixture },
};

const selected = scenario === undefined ? undefined : scenarios[scenario];
if (selected === undefined) {
  process.stderr.write(`Unknown scenario. Choose one of: ${Object.keys(scenarios).sort().join(", ")}\n`);
  process.exitCode = 1;
} else {
  const validation = validateEvidence(baseSnapshotFixture, selected.model, evidenceContextFixture);
  if (!validation.ok) {
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    const userState = UserStateSchema.parse(selected.state);
    const evaluation = evaluatePolicies(validation.model, validation.evidence, userState);
    const plan = planActions(validation.model, validation.evidence, evaluation, userState, {
      ...plannerContextFixture,
      userStateHash: hashCanonical(userState),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          scenario,
          evidenceStatus: validation.evidence.status,
          evidenceIssues: validation.evidence.issues,
          actionDecisions: evaluation.decisions,
          plan,
        },
        null,
        2,
      )}\n`,
    );
  }
}

