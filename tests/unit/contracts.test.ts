import { describe, expect, it } from "vitest";

import { ProcedureModelSchema, SiteSnapshotSchema, UserStateSchema } from "../../src/contracts/index.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  brokenReferenceModelFixture,
  malformedExtractionFixture,
  missingEvidenceModelFixture,
  scheduledStandardStateFixture,
} from "../fixtures/p0.js";

describe("external contracts", () => {
  it("accepts the golden snapshot, procedure model, and user state", () => {
    expect(SiteSnapshotSchema.safeParse(baseSnapshotFixture).success).toBe(true);
    expect(ProcedureModelSchema.safeParse(baseProcedureModelFixture).success).toBe(true);
    expect(UserStateSchema.safeParse(scheduledStandardStateFixture).success).toBe(true);
  });

  it("rejects unknown fields at the snapshot boundary", () => {
    expect(SiteSnapshotSchema.safeParse({ ...baseSnapshotFixture, invented: true }).success).toBe(false);
  });

  it("rejects a missing required source identity", () => {
    expect(SiteSnapshotSchema.safeParse({ ...baseSnapshotFixture, contentHash: undefined }).success).toBe(false);
  });

  it("rejects malformed structured extraction", () => {
    expect(ProcedureModelSchema.safeParse(malformedExtractionFixture).success).toBe(false);
  });

  it("rejects a rule with no evidence citations", () => {
    expect(ProcedureModelSchema.safeParse(missingEvidenceModelFixture).success).toBe(false);
  });

  it("rejects broken action dependency references", () => {
    const result = ProcedureModelSchema.safeParse(brokenReferenceModelFixture);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("Unknown prerequisite"))).toBe(true);
  });

  it("rejects browser-backed actions without website action identities", () => {
    const actions = baseProcedureModelFixture.actions.map((action) =>
      action.id === "proc_cancel01"
        ? {
            id: action.id,
            kind: action.kind,
            label: action.label,
            description: action.description,
            prerequisiteActionIds: action.prerequisiteActionIds,
            terminal: action.terminal,
          }
        : action,
    );
    expect(ProcedureModelSchema.safeParse({ ...baseProcedureModelFixture, actions }).success).toBe(false);
  });

  it("rejects null as a substitute for an unknown user fact", () => {
    expect(
      UserStateSchema.safeParse({ ...scheduledStandardStateFixture, facts: { "payment.status": null } }).success,
    ).toBe(false);
  });
});

