import type {
  ConditionEvaluation,
  JsonScalar,
  PolicyCondition,
  TruthValue,
} from "../contracts/index.js";

const TRUTH_VALUES: readonly TruthValue[] = ["true", "false", "unknown"];

export function notTruth(value: TruthValue): TruthValue {
  if (value === "true") return "false";
  if (value === "false") return "true";
  return "unknown";
}

export function andTruth(values: readonly TruthValue[]): TruthValue {
  if (values.includes("false")) return "false";
  if (values.every((value) => value === "true")) return "true";
  return "unknown";
}

export function orTruth(values: readonly TruthValue[]): TruthValue {
  if (values.includes("true")) return "true";
  if (values.every((value) => value === "false")) return "false";
  return "unknown";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameScalarType(left: JsonScalar, right: JsonScalar): boolean {
  return typeof left === typeof right;
}

function equalJsonScalar(left: JsonScalar, right: JsonScalar): boolean {
  return left === right;
}

function atomicResult(condition: Extract<PolicyCondition, { kind: "fact" }>, facts: Readonly<Record<string, JsonScalar>>): ConditionEvaluation {
  if (!Object.prototype.hasOwnProperty.call(facts, condition.fact)) {
    return { value: "unknown", missingFacts: [condition.fact], reasonCodes: ["MISSING_FACT"] };
  }

  const actual = facts[condition.fact];
  if (actual === undefined) {
    return { value: "unknown", missingFacts: [condition.fact], reasonCodes: ["MISSING_FACT"] };
  }

  if (condition.op === "in" || condition.op === "not_in") {
    const expectedValues = Array.isArray(condition.value) ? condition.value : [];
    const comparableValues = expectedValues.filter((value) => sameScalarType(actual, value));
    if (comparableValues.length !== expectedValues.length) {
      return { value: "unknown", missingFacts: [], reasonCodes: ["TYPE_MISMATCH"] };
    }
    const included = comparableValues.some((value) => equalJsonScalar(actual, value));
    return { value: condition.op === "in" ? (included ? "true" : "false") : included ? "false" : "true", missingFacts: [], reasonCodes: [] };
  }

  if (Array.isArray(condition.value) || !sameScalarType(actual, condition.value)) {
    return { value: "unknown", missingFacts: [], reasonCodes: ["TYPE_MISMATCH"] };
  }

  let value: boolean;
  switch (condition.op) {
    case "eq":
      value = equalJsonScalar(actual, condition.value);
      break;
    case "neq":
      value = !equalJsonScalar(actual, condition.value);
      break;
    case "lt":
      value = typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
      break;
    case "lte":
      value = typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
      break;
    case "gt":
      value = typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
      break;
    case "gte":
      value = typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
      break;
  }
  return { value: value ? "true" : "false", missingFacts: [], reasonCodes: [] };
}

export function evaluateCondition(
  condition: PolicyCondition,
  facts: Readonly<Record<string, JsonScalar>>,
): ConditionEvaluation {
  switch (condition.kind) {
    case "always":
      return { value: "true", missingFacts: [], reasonCodes: [] };
    case "fact":
      return atomicResult(condition, facts);
    case "not": {
      const inner = evaluateCondition(condition.condition, facts);
      return { ...inner, value: notTruth(inner.value) };
    }
    case "all":
    case "any": {
      const results = condition.conditions.map((child) => evaluateCondition(child, facts));
      const value =
        condition.kind === "all"
          ? andTruth(results.map((result) => result.value))
          : orTruth(results.map((result) => result.value));
      return {
        value,
        missingFacts: value === "unknown" ? uniqueSorted(results.flatMap((result) => result.missingFacts)) : [],
        reasonCodes:
          value === "unknown"
            ? (uniqueSorted(results.flatMap((result) => result.reasonCodes)) as ConditionEvaluation["reasonCodes"])
            : [],
      };
    }
  }
}

export const completeTruthDomain = TRUTH_VALUES;

