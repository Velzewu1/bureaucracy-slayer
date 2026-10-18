import { describe, expect, it } from "vitest";

import { validateEvidence } from "../../src/evidence/index.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  cycleModelFixture,
  evidenceContextFixture,
  invalidSourceModelFixture,
  malformedExtractionFixture,
  semanticReviewModelFixture,
  wrongQuoteModelFixture,
} from "../fixtures/p0.js";

describe("evidence validation", () => {
  it("binds every golden rule and observed action", () => {
    const result = validateEvidence(baseSnapshotFixture, baseProcedureModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.status).toBe("valid");
      expect(result.evidence.rejectedRuleIds).toEqual([]);
      expect(result.evidence.validRuleIds).toHaveLength(baseProcedureModelFixture.rules.length);
    }
  });

  it("rejects malformed extraction before it reaches trusted evaluation", () => {
    const result = validateEvidence(baseSnapshotFixture, malformedExtractionFixture, evidenceContextFixture);
    expect(result).toMatchObject({ ok: false, stage: "procedure_schema" });
  });

  it("rejects a quotation that does not exactly match its cited source", () => {
    const result = validateEvidence(baseSnapshotFixture, wrongQuoteModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.status).toBe("degraded");
      expect(result.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
      expect(result.evidence.issues.some((issue) => issue.code === "EXCERPT_MISMATCH")).toBe(true);
    }
  });

  it("rejects a citation to an absent source block", () => {
    const result = validateEvidence(baseSnapshotFixture, invalidSourceModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.issues.some((issue) => issue.code === "BLOCK_MISSING")).toBe(true);
  });

  it("rejects source text whose recorded identity hash was altered", () => {
    const pages = baseSnapshotFixture.pages.map((page) =>
      page.id === "page_policy001"
        ? {
            ...page,
            blocks: page.blocks.map((block) =>
              block.id === "block_general01" ? { ...block, textHash: "tamperedhash0001" } : block,
            ),
          }
        : page,
    );
    const result = validateEvidence({ ...baseSnapshotFixture, pages }, baseProcedureModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
      expect(result.evidence.issues.some((issue) => issue.code === "REFERENCE_INVALID")).toBe(true);
    }
  });

  it("rejects a procedure action observed on a page outside the allowed origin", () => {
    const pages = baseSnapshotFixture.pages.map((page) =>
      page.id === "page_transfer01"
        ? {
            ...page,
            url: "https://external.test/transfers/tx-001",
            canonicalUrl: "https://external.test/transfers/tx-001",
          }
        : page,
    );
    const result = validateEvidence({ ...baseSnapshotFixture, pages }, baseProcedureModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.executableProcedureActionIds).not.toContain("proc_cancel01");
      expect(
        result.evidence.issues.some(
          (issue) => issue.code === "CROSS_ORIGIN_BLOCKED" && issue.procedureActionId === "proc_cancel01",
        ),
      ).toBe(true);
    }
  });

  it("rejects a rule that relies on an undeclared user fact", () => {
    const rules = baseProcedureModelFixture.rules.map((rule) =>
      rule.id === "rule_cancelpermit1"
        ? {
            ...rule,
            appliesWhen: { kind: "fact", fact: "undeclared.flag", op: "eq", value: true },
          }
        : rule,
    );
    const result = validateEvidence(
      baseSnapshotFixture,
      { ...baseProcedureModelFixture, rules },
      evidenceContextFixture,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
      expect(
        result.evidence.issues.some(
          (issue) => issue.code === "REFERENCE_INVALID" && issue.ruleId === "rule_cancelpermit1",
        ),
      ).toBe(true);
    }
  });

  it("keeps exact quotation validity separate from semantic sufficiency", () => {
    const result = validateEvidence(baseSnapshotFixture, semanticReviewModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
      expect(result.evidence.issues.some((issue) => issue.code === "SEMANTIC_REVIEW_REQUIRED")).toBe(true);
      expect(result.evidence.issues.some((issue) => issue.code === "EXCERPT_MISMATCH")).toBe(false);
    }
  });

  it("invalidates a model bound to a different snapshot hash", () => {
    const model = { ...baseProcedureModelFixture, sourceSnapshotHash: "differenthash0001" };
    const result = validateEvidence(baseSnapshotFixture, model, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence).toMatchObject({ status: "invalid", issues: [{ code: "SNAPSHOT_MISMATCH" }] });
  });

  it("detects dependency cycles", () => {
    const result = validateEvidence(baseSnapshotFixture, cycleModelFixture, evidenceContextFixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.status).toBe("invalid");
      expect(result.evidence.issues.some((issue) => issue.code === "DEPENDENCY_CYCLE")).toBe(true);
    }
  });
});
