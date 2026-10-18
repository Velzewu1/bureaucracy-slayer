import { describe, expect, it } from "vitest";

import { GOAL_CATALOG } from "../../extension/src/generated/fixtureEnvelopes.js";
import { checkEnvelope, TRUSTED_ORIGINS } from "../../extension/src/guidance.js";
import {
  lookupOutcome,
  matchGoal,
  parseGoalCatalog,
  UNSUPPORTED_GOAL_MESSAGE,
  visibleQuestions,
} from "../../extension/src/goals.js";
import { PanelCommandSchema } from "../../extension/src/messages.js";
import {
  LIVE_DEMO_CANCELLATION_GOAL,
  LIVE_TEST_UNAUTHORIZED_GOAL,
  NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL,
} from "../integration/live-extraction/contract-fixtures.js";

const catalog = parseGoalCatalog(GOAL_CATALOG);

function answersFor(goal: string, choices: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const entry = matchGoal(catalog, goal);
  if (entry === undefined) throw new Error(`missing catalog entry for ${goal}`);
  const answers: Record<string, string> = {};
  for (const [label, optionLabel] of Object.entries(choices)) {
    const question = entry.questions.find((candidate) => candidate.label === label);
    const option = question?.options.find((candidate) => candidate.label === optionLabel);
    if (question === undefined || option === undefined) throw new Error(`missing ${label}=${optionLabel}`);
    answers[question.id] = option.id;
  }
  return answers;
}

async function status(goal: string, choices: Readonly<Record<string, string>>): Promise<string> {
  const entry = matchGoal(catalog, goal);
  if (entry === undefined) throw new Error("missing entry");
  const found = lookupOutcome(entry, answersFor(goal, choices));
  if (!found.ok) throw new Error(found.code);
  const checked = await checkEnvelope(found.envelope, TRUSTED_ORIGINS);
  if (!checked.ok) throw new Error(checked.code);
  expect(checked.envelope.goal).toBe(goal);
  expect(checked.envelope.sourceLabel).toBe("Offline fixture — not a live analysis.");
  expect(checked.envelope.source).toBe("fixture_demo");
  return checked.envelope.planStatus;
}

describe("exact offline goal catalog", () => {
  it("parses three recognized goals and no fact keys", () => {
    expect(catalog.map((entry) => entry.goal)).toEqual([
      LIVE_DEMO_CANCELLATION_GOAL,
      NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL,
      LIVE_TEST_UNAUTHORIZED_GOAL,
    ]);
    expect(JSON.stringify(catalog.map((entry) => entry.questions))).not.toMatch(/transfer_status|processing_started|initiated_by_user/);
    expect(UNSUPPORTED_GOAL_MESSAGE).toBe("This goal is not available in the offline demonstration.");
  });

  it("matches only the exact goal text", () => {
    expect(matchGoal(catalog, `  ${LIVE_DEMO_CANCELLATION_GOAL}  `)?.goal).toBe(LIVE_DEMO_CANCELLATION_GOAL);
    expect(matchGoal(catalog, "Can I cancel my scheduled bank transfer")).toBeUndefined();
    expect(matchGoal(catalog, "Please cancel something else")).toBeUndefined();
    expect(matchGoal(catalog, LIVE_DEMO_CANCELLATION_GOAL.toLowerCase())).toBeUndefined();
  });

  it("seals the A1 ready, missing, and prohibited states", async () => {
    expect(await status(LIVE_DEMO_CANCELLATION_GOAL, {})).toBe("needs_information");
    expect(
      await status(LIVE_DEMO_CANCELLATION_GOAL, {
        "Transfer status": "Scheduled",
        "Transfer type": "Standard",
      }),
    ).toBe("needs_information");
    expect(
      await status(LIVE_DEMO_CANCELLATION_GOAL, {
        "Transfer status": "Scheduled",
        "Transfer type": "Standard",
        "Transfer processing has begun": "No",
      }),
    ).toBe("ready");
    expect(
      await status(LIVE_DEMO_CANCELLATION_GOAL, {
        "Transfer status": "Scheduled",
        "Transfer type": "Instant",
        "Transfer processing has begun": "No",
      }),
    ).toBe("blocked");
    expect(
      await status(LIVE_DEMO_CANCELLATION_GOAL, {
        "Transfer status": "Completed",
        "Transfer type": "Standard",
        "Transfer processing has begun": "No",
      }),
    ).toBe("blocked");
  });

  it("keeps the completed-recovery goal off a ready route", async () => {
    const recovery = await status(NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL, {
      "Transfer status": "Completed",
      "User started the transfer themselves": "Yes",
      "Transfer type": "Scheduled",
    });
    expect(recovery).toBe("review_required");
  });

  it("moves the unauthorized goal from missing information to a ready report", async () => {
    expect(
      await status(LIVE_TEST_UNAUTHORIZED_GOAL, {
        "User started the transfer themselves": "No",
      }),
    ).toBe("needs_information");
    const ready = await status(LIVE_TEST_UNAUTHORIZED_GOAL, {
      "User started the transfer themselves": "No",
      "Transfer reference number is available": "Yes",
      "Date first noticed is available": "Yes",
      "Account has been secured": "No",
    });
    expect(ready).toBe("ready");
  });

  it("shows guided questions only for labels the plan still needs", () => {
    const entry = matchGoal(catalog, LIVE_DEMO_CANCELLATION_GOAL);
    if (entry === undefined) throw new Error("missing entry");
    const guided = visibleQuestions(entry, "guided", ["Transfer status"], {});
    expect(guided.map((question) => question.label)).toEqual(["Transfer status"]);
    const all = visibleQuestions(entry, "all", ["Transfer status"], {});
    expect(all.length).toBe(entry.questions.length);
  });

  it("refuses an answer that is not one of the sealed combinations", () => {
    const entry = matchGoal(catalog, LIVE_DEMO_CANCELLATION_GOAL);
    if (entry === undefined) throw new Error("missing entry");
    expect(lookupOutcome(entry, { q1: "not-an-option" }).ok).toBe(false);
  });

  it("rejects analyze commands that try to carry a url", () => {
    expect(PanelCommandSchema.safeParse({ type: "ANALYZE", goal: LIVE_DEMO_CANCELLATION_GOAL, url: "http://evil" }).success).toBe(false);
    expect(PanelCommandSchema.safeParse({ type: "ANSWER", questionId: "q1", optionId: "o1" }).success).toBe(true);
  });
});
