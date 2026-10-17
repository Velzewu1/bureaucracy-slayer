import { describe, expect, it } from "vitest";

import { PolicyConditionSchema, type TruthValue } from "../../src/contracts/index.js";
import { andTruth, completeTruthDomain, evaluateCondition, notTruth, orTruth } from "../../src/engine/index.js";

const binaryExpectations: Readonly<Record<`${TruthValue}:${TruthValue}`, readonly [TruthValue, TruthValue]>> = {
  "true:true": ["true", "true"],
  "true:false": ["false", "true"],
  "true:unknown": ["unknown", "true"],
  "false:true": ["false", "true"],
  "false:false": ["false", "false"],
  "false:unknown": ["false", "unknown"],
  "unknown:true": ["unknown", "true"],
  "unknown:false": ["false", "unknown"],
  "unknown:unknown": ["unknown", "unknown"],
};

describe("three-valued logic", () => {
  for (const left of completeTruthDomain) {
    for (const right of completeTruthDomain) {
      it(`evaluates the full AND/OR row for ${left}, ${right}`, () => {
        const [expectedAnd, expectedOr] = binaryExpectations[`${left}:${right}`];
        expect(andTruth([left, right])).toBe(expectedAnd);
        expect(orTruth([left, right])).toBe(expectedOr);
      });
    }
  }

  it.each([
    ["true", "false"],
    ["false", "true"],
    ["unknown", "unknown"],
  ] as const)("negates %s to %s", (input, expected) => {
    expect(notTruth(input)).toBe(expected);
  });

  it("propagates missing facts through conjunction", () => {
    const condition = PolicyConditionSchema.parse({
      kind: "all",
      conditions: [
        { kind: "fact", fact: "known", op: "eq", value: true },
        { kind: "fact", fact: "missing", op: "eq", value: true },
      ],
    });
    expect(evaluateCondition(condition, { known: true })).toEqual({
      value: "unknown",
      missingFacts: ["missing"],
      reasonCodes: ["MISSING_FACT"],
    });
  });

  it("does not coerce a fact of the wrong type", () => {
    const condition = PolicyConditionSchema.parse({ kind: "fact", fact: "count", op: "eq", value: 1 });
    expect(evaluateCondition(condition, { count: "1" })).toEqual({
      value: "unknown",
      missingFacts: [],
      reasonCodes: ["TYPE_MISMATCH"],
    });
  });
});

