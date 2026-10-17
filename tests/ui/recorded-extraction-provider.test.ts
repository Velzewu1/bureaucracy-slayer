import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { UserStateSchema } from "../../src/contracts/index.js";
import {
  RecordedExtractionError,
  RecordedExtractionProvider,
  recordedExtractionBundle,
} from "../../src/ui/adapters/recordedExtractionProvider.js";
import { evidenceCards } from "../../src/ui/viewModel.js";

const fixedNow = () => "2026-10-17T12:00:00.000Z";

function request(userState = recordedExtractionBundle.defaultScenario.userState) {
  return {
    goal: recordedExtractionBundle.extractionGoal,
    portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
    scenarioId: "dynamic-replanning" as const,
    userState,
  };
}

describe("RecordedExtractionProvider", () => {
  it("loads exact artifact bindings and recomputes the six usable and two review-gated rules", async () => {
    const analysis = await new RecordedExtractionProvider({ now: fixedNow }).analyze(request());

    expect(analysis.snapshot.id).toBe(recordedExtractionBundle.identity.snapshotId);
    expect(analysis.snapshot.contentHash).toBe(recordedExtractionBundle.identity.snapshotHash);
    expect(analysis.model.id).toBe(recordedExtractionBundle.identity.modelId);
    expect(analysis.model.rules).toHaveLength(8);
    expect(analysis.evidence.status).toBe("degraded");
    expect(analysis.evidence.validRuleIds).toHaveLength(6);
    expect(analysis.evidence.rejectedRuleIds).toEqual([
      "rule_r3_permit_cancel_scheduled",
      "rule_r4_permit_recovery_completed_self_initiated",
    ]);
    expect(analysis.semanticAuditFindings.map((finding) => finding.ruleId)).toEqual(
      expect.arrayContaining(analysis.evidence.rejectedRuleIds),
    );
  });

  it("withholds cancellation and recovery routes for recorded review-required scenarios", async () => {
    const provider = new RecordedExtractionProvider({ now: fixedNow });
    const cancellation = await provider.analyze(request());
    const recoveryState = UserStateSchema.parse({
      schemaVersion: 1,
      revision: 2,
      facts: {
        transfer_status: "completed",
        processing_started: true,
        initiated_by_user: true,
        transfer_type: "scheduled",
      },
    });
    const recovery = await provider.replan(cancellation.sessionId, recoveryState);

    expect(cancellation.plan).toMatchObject({ status: "review_required", steps: [] });
    expect(recovery.plan).toMatchObject({ status: "review_required", steps: [] });
    expect(cancellation.evaluation.decisions.find((item) => item.actionId === "proc_cancel_transfer")?.status).toBe("review");
    expect(recovery.evaluation.decisions.find((item) => item.actionId === "proc_submit_recovery_request")?.status).toBe("review");
    expect(
      recovery.decisionIntelligence.counterfactuals.some(
        (item) => item.planStatusAfter === "ready" || item.routeAfter.length > 0,
      ),
    ).toBe(false);
  });

  it("rejects goal and portal changes with typed fail-closed errors", async () => {
    const provider = new RecordedExtractionProvider({ now: fixedNow });

    await expect(provider.analyze({ ...request(), goal: "Use this model for another goal" })).rejects.toMatchObject({
      code: "GOAL_MISMATCH",
    });
    await expect(provider.analyze({ ...request(), portalUrl: "https://unrelated.example.test/" })).rejects.toMatchObject({
      code: "PORTAL_MISMATCH",
    });
  });

  it("fails closed for malformed or stale sanitized artifacts", () => {
    expect(
      () => new RecordedExtractionProvider({ bundleInput: { schemaVersion: 1 } }),
    ).toThrow(RecordedExtractionError);

    const stale = structuredClone(recordedExtractionBundle);
    const firstPage = stale.sourceSnapshot.pages.at(0);
    const firstBlock = firstPage?.blocks.at(0);
    if (firstBlock === undefined) throw new Error("Recorded snapshot has no evidence block.");
    firstBlock.text = "altered after recording";
    expect(() => new RecordedExtractionProvider({ bundleInput: stale })).toThrow(
      /no longer matches its hash/,
    );
  });

  it("presents semantic review as distinct from an exact citation mismatch", async () => {
    const analysis = await new RecordedExtractionProvider({ now: fixedNow }).analyze(request());
    const reviewed = evidenceCards(analysis).filter((card) =>
      analysis.evidence.rejectedRuleIds.includes(card.ruleId),
    );

    expect(reviewed).not.toHaveLength(0);
    expect(reviewed.every((card) => card.status === "audit_review")).toBe(true);
    expect(reviewed.every((card) => card.status !== "citation_mismatch")).toBe(true);
    expect(reviewed.some((card) => card.issues.some((issue) => issue.code === "SEMANTIC_REVIEW_REQUIRED"))).toBe(true);
  });

  it("contains no Anthropic or Playwright adapter import or invocation", () => {
    const source = readFileSync(
      "src/ui/adapters/recordedExtractionProvider.ts",
      "utf8",
    ).toLocaleLowerCase("en-US");
    expect(source).not.toContain("anthropic");
    expect(source).not.toContain("playwright");
    expect(source).not.toContain("createmessage");
  });
});
