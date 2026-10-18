import { describe, expect, it } from "vitest";

import { UserStateSchema, hashCanonical, type UserState } from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { deriveObservedGoalScope } from "../../src/extractor/source-selection.js";
import {
  LIVE_DEMO_CANCELLATION_GOAL,
  LIVE_DEMO_MISTAKEN_RECOVERY_GOAL,
  LIVE_TEST_UNAUTHORIZED_GOAL,
  NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL,
  createGoalSpecificLiveArtifactFixture,
} from "./live-extraction/contract-fixtures.js";

function facts(values: UserState["facts"], revision = 1): UserState {
  return UserStateSchema.parse({ schemaVersion: 1, revision, facts: values });
}

function decide(goal: string, userState: UserState) {
  const artifact = createGoalSpecificLiveArtifactFixture(goal);
  if (artifact === undefined) throw new Error(`No grounded fixture for ${goal}`);
  const evaluation = evaluatePolicies(artifact.procedureModel, artifact.evidence, userState);
  const plan = planActions(
    artifact.procedureModel,
    artifact.evidence,
    evaluation,
    userState,
    {
      planId: `plan_${revisionSafe(userState.revision)}`,
      generatedAt: "2026-10-17T12:00:00.000Z",
      userStateHash: hashCanonical(userState),
    },
  );
  return { artifact, evaluation, plan };
}

function revisionSafe(revision: number): string {
  return revision.toString(16).padStart(8, "0");
}

function decision(result: ReturnType<typeof decide>, actionId: string) {
  return result.evaluation.decisions.find((item) => item.actionId === actionId);
}

describe("Northstar grounded scenarios", () => {
  it("permits a scheduled standard cancellation and grounds the route in the observed control", () => {
    const result = decide(LIVE_DEMO_CANCELLATION_GOAL, facts({
      transfer_status: "scheduled",
      transfer_type: "standard",
      processing_started: false,
    }));

    expect(result.artifact.provenance.modelName).toBe("deterministic-offline-test-fixture");
    expect(result.artifact.sourceSelection.coverage).toBe("complete");
    expect(result.artifact.sourceSelection.selectedCounts.pages).toBeLessThanOrEqual(9);
    expect(result.artifact.sourceSelection.selectedCounts.blocks).toBeLessThanOrEqual(80);
    expect(result.artifact.sourceSelection.selectedCounts.actions).toBeLessThanOrEqual(35);
    expect(decision(result, "proc_cancel_transfer")).toMatchObject({
      status: "allowed",
      reasonCodes: ["PERMITTED"],
    });
    expect(result.plan.status).toBe("ready");
    expect(result.plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_cancel_transfer"]);
    expect(result.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
  });

  it("does not treat a completed mistaken transfer as cancellable", () => {
    const result = decide(LIVE_DEMO_MISTAKEN_RECOVERY_GOAL, facts({
      transfer_status: "completed",
      initiated_by_user: true,
      transfer_type: "standard",
      processing_started: true,
    }));

    expect(decision(result, "proc_cancel_transfer")?.status).toBe("forbidden");
    expect(decision(result, "proc_cancel_transfer")?.reasonCodes).toContain("PROHIBITED");
    expect(result.plan.steps.map((step) => step.procedureActionId)).not.toContain("proc_cancel_transfer");
    expect(result.plan.status).not.toBe("ready");
    expect(result.artifact.procedureModel.id).toBe("procedure_fixture_completed_recovery");
  });

  it("grounds the exact completed-recovery goal without converting a hedged permit into a ready route", () => {
    const result = decide(NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL, facts({
      transfer_status: "completed",
      initiated_by_user: true,
      transfer_type: "scheduled",
    }));

    expect(result.artifact.sourceSelection.coverage).toBe("complete");
    expect(result.artifact.sourceSelection.selectedCounts.pages).toBeLessThanOrEqual(9);
    expect(result.artifact.sourceSelection.selectedCounts.blocks).toBeLessThanOrEqual(80);
    expect(result.artifact.provenance.modelName).toBe("deterministic-offline-test-fixture");
    expect(decision(result, "proc_cancel_transfer")?.reasonCodes).toContain("PROHIBITED");
    expect(result.plan.status).not.toBe("ready");
  });

  it("keeps an unauthorized transfer distinct from a mistaken-transfer report", () => {
    const missingInformation = decide(
      LIVE_TEST_UNAUTHORIZED_GOAL,
      facts({ initiated_by_user: false }),
    );
    const unauthorized = decide(LIVE_TEST_UNAUTHORIZED_GOAL, facts({
      initiated_by_user: false,
      transfer_reference_available: true,
      first_notice_date_available: true,
      account_secured: false,
    }));
    const mistaken = decide(LIVE_TEST_UNAUTHORIZED_GOAL, facts({ initiated_by_user: true }));
    const unknown = decide(LIVE_TEST_UNAUTHORIZED_GOAL, facts({}));

    expect(decision(missingInformation, "proc_submit_unauthorized_report")).toMatchObject({
      status: "indeterminate",
      reasonCodes: ["MISSING_FACTS"],
    });
    expect(missingInformation.plan.status).toBe("needs_information");
    expect(decision(unauthorized, "proc_submit_unauthorized_report")).toMatchObject({
      status: "allowed",
      reasonCodes: ["PERMITTED"],
    });
    expect(unauthorized.plan.status).toBe("ready");
    expect(unauthorized.plan.steps.map((step) => step.procedureActionId)).toContain(
      "proc_submit_unauthorized_report",
    );
    expect(decision(unauthorized, "proc_submit_mistaken_report")?.status).toBe("forbidden");
    expect(decision(unauthorized, "proc_submit_recovery_request")?.status).toBe("forbidden");
    expect(unauthorized.plan.steps.map((step) => step.procedureActionId)).not.toContain(
      "proc_submit_mistaken_report",
    );
    expect(decision(mistaken, "proc_submit_unauthorized_report")?.reasonCodes).toContain("PROHIBITED");
    expect(decision(mistaken, "proc_submit_mistaken_report")).toMatchObject({
      status: "allowed",
      reasonCodes: ["PERMITTED"],
    });
    expect(mistaken.plan.steps.map((step) => step.procedureActionId)).toEqual([
      "proc_submit_mistaken_report",
    ]);
    expect(unknown.plan.status).toBe("needs_information");
    expect(unknown.plan.steps).toEqual([]);
  });

  it("lets an instant-transfer prohibition override the visible cancel control", () => {
    const permitted = decide(LIVE_DEMO_CANCELLATION_GOAL, facts({
      transfer_status: "scheduled",
      transfer_type: "standard",
      processing_started: false,
    }));
    const instant = decide(LIVE_DEMO_CANCELLATION_GOAL, facts({
      transfer_status: "scheduled",
      transfer_type: "instant",
      processing_started: false,
    }));
    const unknown = decide(LIVE_DEMO_CANCELLATION_GOAL, facts({
      transfer_status: "scheduled",
      transfer_type: "standard",
    }));

    expect(permitted.plan.status).toBe("ready");
    expect(decision(instant, "proc_cancel_transfer")).toMatchObject({ status: "forbidden" });
    expect(decision(instant, "proc_cancel_transfer")?.reasonCodes).toContain("PROHIBITED");
    expect(instant.plan.status).not.toBe("ready");
    expect(unknown.plan.status).toBe("needs_information");
    expect(unknown.plan.missingFacts).toContain("processing_started");
  });

  it("replans a completed transfer on the same cancellation model without a new extraction", () => {
    const scheduled = decide(LIVE_DEMO_CANCELLATION_GOAL, facts({
      transfer_status: "scheduled",
      transfer_type: "standard",
      processing_started: false,
    }, 1));
    const completed = decide(LIVE_DEMO_CANCELLATION_GOAL, facts({
      transfer_status: "completed",
      transfer_type: "standard",
      processing_started: false,
    }, 2));

    expect(scheduled.plan.status).toBe("ready");
    expect(completed.plan.status).not.toBe("ready");
    expect(completed.plan.steps).toEqual([]);
    expect(decision(completed, "proc_cancel_transfer")?.reasonCodes).toContain("PROHIBITED");
    expect(completed.artifact.sourceSnapshot.contentHash).toBe(scheduled.artifact.sourceSnapshot.contentHash);
    expect(completed.artifact.procedureModel.id).toBe(scheduled.artifact.procedureModel.id);
    expect(completed.artifact.evidence.id).toBe(scheduled.artifact.evidence.id);
    expect(completed.plan.userStateRevision).toBe(2);
    expect(completed.artifact.procedureModel.goalActionIds).toEqual(["proc_cancel_transfer"]);
  });

  it("keeps each demo goal inside the source budget and distinguishes recovery retrieval", () => {
    const goals = [
      LIVE_DEMO_CANCELLATION_GOAL,
      LIVE_DEMO_MISTAKEN_RECOVERY_GOAL,
      LIVE_TEST_UNAUTHORIZED_GOAL,
    ] as const;
    const catalogs = goals.map((goal) => {
      const artifact = createGoalSpecificLiveArtifactFixture(goal);
      if (artifact === undefined) throw new Error(`No grounded fixture for ${goal}`);
      const scope = deriveObservedGoalScope(artifact.sourceSnapshot, goal);
      return {
        purpose: scope?.primaryActionPurpose,
        pages: artifact.sourceSelection.selectedPageIds,
        counts: artifact.sourceSelection.selectedCounts,
      };
    });
    for (const catalog of catalogs) {
      expect(catalog.counts.pages).toBeLessThanOrEqual(9);
      expect(catalog.counts.blocks).toBeLessThanOrEqual(80);
      expect(catalog.counts.actions).toBeLessThanOrEqual(35);
    }
    expect(catalogs[1]?.pages.join(",")).not.toBe(catalogs[0]?.pages.join(","));
    expect(new Set(catalogs.map((catalog) => catalog.purpose)).size).toBeGreaterThan(1);
  });
});
