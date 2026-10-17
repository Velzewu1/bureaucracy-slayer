import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  hashText,
  type PolicyCondition,
  type ProcedureModel,
  type SiteSnapshot,
} from "../../src/contracts/index.js";
import {
  auditSemanticQualifiers,
  extractProcedure,
  type ClaudeMessageRequest,
  type ClaudeTransport,
} from "../../src/extractor/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  evidenceContextFixture,
} from "../fixtures/p0.js";

const USER_GOAL = "Cancel this transfer or identify an evidenced recovery path.";

type FactDefinition = ProcedureModel["factDefinitions"][number];

function replaceBlock(snapshot: SiteSnapshot, blockId: string, text: string): SiteSnapshot {
  return SiteSnapshotSchema.parse({
    ...snapshot,
    pages: snapshot.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) =>
        block.id === blockId ? { ...block, text, textHash: hashText(text) } : block,
      ),
    })),
  });
}

function replacePermit(
  model: ProcedureModel,
  ruleId: string,
  excerpt: string,
  appliesWhen: PolicyCondition,
): ProcedureModel {
  return ProcedureModelSchema.parse({
    ...model,
    rules: model.rules.map((rule) =>
      rule.id === ruleId
        ? {
            ...rule,
            appliesWhen,
            citations: rule.citations.map((citation) => ({ ...citation, excerpt })),
          }
        : rule,
    ),
  });
}

function baseArtifacts(): Readonly<{ snapshot: SiteSnapshot; model: ProcedureModel }> {
  return {
    snapshot: SiteSnapshotSchema.parse(baseSnapshotFixture),
    model: ProcedureModelSchema.parse(baseProcedureModelFixture),
  };
}

function cancellationArtifacts(
  source: string,
  appliesWhen: PolicyCondition,
): Readonly<{ snapshot: SiteSnapshot; model: ProcedureModel }> {
  const base = baseArtifacts();
  return {
    snapshot: replaceBlock(base.snapshot, "block_general01", source),
    model: replacePermit(base.model, "rule_cancelpermit1", source, appliesWhen),
  };
}

function recoveryArtifacts(
  source: string,
  appliesWhen: PolicyCondition,
  extraDefinitions: readonly FactDefinition[] = [],
): Readonly<{ snapshot: SiteSnapshot; model: ProcedureModel }> {
  const base = baseArtifacts();
  const modelWithDefinitions = ProcedureModelSchema.parse({
    ...base.model,
    factDefinitions: [...base.model.factDefinitions, ...extraDefinitions],
  });
  return {
    snapshot: replaceBlock(base.snapshot, "block_recovery1", source),
    model: replacePermit(modelWithDefinitions, "rule_recoverok01", source, appliesWhen),
  };
}

function cancellationCondition(options: Readonly<{ standard: boolean; beforeProcessing: boolean }>): PolicyCondition {
  return {
    kind: "all",
    conditions: [
      { kind: "fact", fact: "payment.status", op: "eq", value: "scheduled" },
      ...(options.standard
        ? [{ kind: "fact", fact: "payment.method", op: "eq", value: "standard" } as const]
        : []),
      ...(options.beforeProcessing
        ? [{ kind: "fact", fact: "payment.beforeDeadline", op: "eq", value: true } as const]
        : []),
    ],
  };
}

function findingsFor(
  artifacts: Readonly<{ snapshot: SiteSnapshot; model: ProcedureModel }>,
  ruleId: string,
) {
  return auditSemanticQualifiers(artifacts.snapshot, artifacts.model).findings.filter(
    (finding) => finding.ruleId === ruleId,
  );
}

describe("semantic qualifier audit", () => {
  it("accepts a permission when all explicit mandatory qualifiers are represented", () => {
    const source = "A scheduled standard transfer may be canceled before processing begins.";
    const artifacts = cancellationArtifacts(
      source,
      cancellationCondition({ standard: true, beforeProcessing: true }),
    );

    expect(findingsFor(artifacts, "rule_cancelpermit1")).toEqual([]);
  });

  it("flags a scheduled permission that omits the Standard category qualifier", () => {
    const source = "A scheduled standard transfer may be canceled before processing begins.";
    const artifacts = cancellationArtifacts(
      source,
      cancellationCondition({ standard: false, beforeProcessing: true }),
    );

    expect(findingsFor(artifacts, "rule_cancelpermit1")).toContainEqual(
      expect.objectContaining({ code: "MISSING_QUALIFIER", message: expect.stringContaining("standard") }),
    );
  });

  it("flags a permission that omits the before-processing restriction", () => {
    const source = "A scheduled standard transfer may be canceled before processing begins.";
    const artifacts = cancellationArtifacts(
      source,
      cancellationCondition({ standard: true, beforeProcessing: false }),
    );

    expect(findingsFor(artifacts, "rule_cancelpermit1")).toContainEqual(
      expect.objectContaining({ code: "MISSING_QUALIFIER", message: expect.stringContaining("before process") }),
    );
  });

  it("flags completed recovery that omits the initiated-by-user requirement", () => {
    const source = "Completed transfers that you started yourself may be eligible for recovery.";
    const artifacts = recoveryArtifacts(
      source,
      { kind: "fact", fact: "payment.status", op: "eq", value: "completed" },
      [
        {
          key: "payment.initiatedByUser",
          label: "Initiated by user",
          type: "boolean",
          sensitive: false,
        },
      ],
    );

    expect(findingsFor(artifacts, "rule_recoverok01")).toContainEqual(
      expect.objectContaining({ code: "MISSING_QUALIFIER", message: expect.stringContaining("initiate") }),
    );
  });

  it("detects a negated ownership qualifier represented with the opposite polarity", () => {
    const source = "A completed transfer not initiated by you may be reported for recovery.";
    const artifacts = recoveryArtifacts(
      source,
      {
        kind: "all",
        conditions: [
          { kind: "fact", fact: "payment.status", op: "eq", value: "completed" },
          { kind: "fact", fact: "payment.initiatedByUser", op: "eq", value: true },
        ],
      },
      [
        {
          key: "payment.initiatedByUser",
          label: "Initiated by user",
          type: "boolean",
          sensitive: false,
        },
      ],
    );

    expect(findingsFor(artifacts, "rule_recoverok01")).toContainEqual(
      expect.objectContaining({ code: "NEGATED_QUALIFIER_MISMATCH" }),
    );
  });

  it("flags an explicit related exception on another evidence block when no restrictive rule models it", () => {
    const base = baseArtifacts();
    const model = ProcedureModelSchema.parse({
      ...base.model,
      rules: base.model.rules.filter((rule) => rule.id !== "rule_instantdeny1"),
    });

    expect(findingsFor({ snapshot: base.snapshot, model }, "rule_cancelpermit1")).toContainEqual(
      expect.objectContaining({ code: "UNMODELED_EXCEPTION", message: expect.stringContaining("block_instant01") }),
    );
  });

  it("does not reject a genuinely unconditional permission", () => {
    const base = baseArtifacts();
    const source = "Users may view transfer details.";
    const artifacts = {
      snapshot: replaceBlock(base.snapshot, "block_procedure1", source),
      model: replacePermit(base.model, "rule_openpermit1", source, { kind: "always" }),
    };

    expect(findingsFor(artifacts, "rule_openpermit1")).toEqual([]);
  });

  it("requires review for ambiguous natural-language permission scope", () => {
    const source = "Completed transfers may sometimes be eligible for recovery where appropriate.";
    const artifacts = recoveryArtifacts(source, {
      kind: "fact",
      fact: "payment.status",
      op: "eq",
      value: "completed",
    });

    expect(findingsFor(artifacts, "rule_recoverok01")).toContainEqual(
      expect.objectContaining({ code: "AMBIGUOUS_PERMISSION_SCOPE" }),
    );
  });

  it("does not turn unrelated restrictive text into a phantom qualifier", () => {
    const source = "A scheduled standard transfer may be canceled before processing begins.";
    const artifacts = cancellationArtifacts(
      source,
      cancellationCondition({ standard: true, beforeProcessing: true }),
    );
    const unrelated = "Subscriptions cannot be canceled after billing starts.";
    const snapshot = replaceBlock(artifacts.snapshot, "block_instant01", unrelated);
    const model = ProcedureModelSchema.parse({
      ...artifacts.model,
      rules: artifacts.model.rules.filter((rule) => rule.id !== "rule_instantdeny1"),
    });

    expect(findingsFor({ snapshot, model }, "rule_cancelpermit1")).toEqual([]);
  });

  it("keeps the preserved canonical extraction fixture compatible", () => {
    const artifacts = baseArtifacts();

    expect(auditSemanticQualifiers(artifacts.snapshot, artifacts.model)).toEqual({
      findings: [],
      reviewRequiredRuleIds: [],
    });
  });

  it("never lets audit metadata suppress a prohibition", () => {
    const artifacts = baseArtifacts();
    const result = validateEvidence(
      artifacts.snapshot,
      artifacts.model,
      evidenceContextFixture,
      [{ ruleId: "rule_instantdeny1", message: "Unexpected external review input." }],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.validRuleIds).toContain("rule_instantdeny1");
    expect(result.evidence.rejectedRuleIds).not.toContain("rule_instantdeny1");
  });

  it("makes an independently flagged permit review-required without mutating the model", async () => {
    const source = "A scheduled standard transfer may be canceled before processing begins.";
    const artifacts = cancellationArtifacts(
      source,
      cancellationCondition({ standard: false, beforeProcessing: true }),
    );
    const transport: ClaudeTransport = {
      createMessage(_request: ClaudeMessageRequest): Promise<unknown> {
        return Promise.resolve({
          id: "msg_semantic_audit",
          type: "message",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(artifacts.model) }],
        });
      },
    };

    const outcome = await extractProcedure(artifacts.snapshot, USER_GOAL, {
      transport,
      model: "claude-test-model",
      evidenceContext: evidenceContextFixture,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("review_required");
    expect(outcome.model.rules.find((rule) => rule.id === "rule_cancelpermit1")?.needsReview).toBe(false);
    expect(outcome.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
    expect(outcome.evidence.issues).toContainEqual(
      expect.objectContaining({ code: "SEMANTIC_REVIEW_REQUIRED", ruleId: "rule_cancelpermit1" }),
    );
  });
});
