import { describe, expect, it } from "vitest";

import {
  COMPACT_EXTRACTION_OUTPUT_SCHEMA,
  POLICY_EXTRACTION_OUTPUT_SCHEMA,
  PROCEDURE_MAPPING_OUTPUT_SCHEMA,
  PROCEDURE_MODEL_OUTPUT_SCHEMA,
} from "../../src/extractor/index.js";

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${description} must be an object`);
  return value;
}

function walkJson(
  value: unknown,
  visit: (record: JsonRecord, path: string) => void,
  path = "root",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visit, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  visit(value, path);
  for (const [key, child] of Object.entries(value)) walkJson(child, visit, `${path}.${key}`);
}

function definition(name: string): JsonRecord {
  const definitions = requireRecord(COMPACT_EXTRACTION_OUTPUT_SCHEMA["$defs"], "$defs");
  return requireRecord(definitions[name], `$defs.${name}`);
}

function properties(schema: JsonRecord, description: string): JsonRecord {
  return requireRecord(schema["properties"], `${description}.properties`);
}

describe("Anthropic compact extraction output schema", () => {
  it("uses a small supported grammar with no unions, recursion, or optional object properties", () => {
    const forbiddenKeywords = new Set([
      "oneOf",
      "anyOf",
      "allOf",
      "not",
      "discriminator",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "maxItems",
      "uniqueItems",
      "contains",
      "minContains",
      "maxContains",
      "patternProperties",
      "additionalItems",
      "unevaluatedProperties",
      "if",
      "then",
      "else",
    ]);
    const issues: string[] = [];
    let objectCount = 0;
    let referenceCount = 0;

    walkJson(COMPACT_EXTRACTION_OUTPUT_SCHEMA, (record, path) => {
      for (const key of Object.keys(record)) {
        if (forbiddenKeywords.has(key)) issues.push(`${path} uses ${key}`);
      }
      if (record["type"] === "object") {
        objectCount += 1;
        if (record["additionalProperties"] !== false) {
          issues.push(`${path} must set additionalProperties=false`);
        }
        const objectProperties = properties(record, path);
        const required = new Set(
          Array.isArray(record["required"])
            ? record["required"].filter((value): value is string => typeof value === "string")
            : [],
        );
        for (const name of Object.keys(objectProperties)) {
          if (!required.has(name)) issues.push(`${path}.${name} is optional`);
        }
      }
      const reference = record["$ref"];
      if (typeof reference === "string") {
        referenceCount += 1;
        if (!reference.startsWith("#/$defs/")) issues.push(`${path} has a non-local reference`);
      }
    });

    expect(issues).toEqual([]);
    expect(objectCount).toBe(6);
    expect(referenceCount).toBe(5);
    expect(JSON.stringify(COMPACT_EXTRACTION_OUTPUT_SCHEMA)).not.toContain("oneOf");
    expect(JSON.stringify(COMPACT_EXTRACTION_OUTPUT_SCHEMA)).not.toContain("anyOf");
    expect(JSON.stringify(COMPACT_EXTRACTION_OUTPUT_SCHEMA)).not.toContain("pattern");
  });

  it("uses one flat condition-node shape and one flat rule shape", () => {
    const rootRequired = COMPACT_EXTRACTION_OUTPUT_SCHEMA["required"];
    expect(rootRequired).toEqual([
      "schemaVersion",
      "id",
      "sourceSnapshotId",
      "sourceSnapshotHash",
      "extractedAt",
      "goalSummary",
      "factDefinitions",
      "actions",
      "goalActionIds",
      "conditionNodes",
      "rules",
    ]);

    const conditionProperties = properties(definition("conditionNode"), "conditionNode");
    expect(requireRecord(conditionProperties["kind"], "conditionNode.kind")["enum"]).toEqual([
      "always",
      "fact",
      "all",
      "any",
      "not",
    ]);
    expect(Object.keys(conditionProperties)).toEqual([
      "id",
      "kind",
      "fact",
      "op",
      "valueJson",
      "childIds",
    ]);

    const ruleProperties = properties(definition("rule"), "rule");
    expect(requireRecord(ruleProperties["effect"], "rule.effect")["enum"]).toEqual([
      "permit",
      "prohibit",
      "require_condition",
      "require_action",
    ]);
    expect(Object.keys(ruleProperties)).toContain("appliesWhenConditionId");
    expect(Object.keys(ruleProperties)).toContain("requirementConditionId");

    const citationProperties = properties(definition("citation"), "citation");
    expect(Object.keys(citationProperties)).toContain("websiteActionIds");
    expect(Object.keys(citationProperties)).not.toContain("actionIds");
  });

  it("preserves the legacy schema export name", () => {
    expect(PROCEDURE_MODEL_OUTPUT_SCHEMA).toBe(COMPACT_EXTRACTION_OUTPUT_SCHEMA);
  });

  it("does not add evaluation or authorization fields", () => {
    const rootProperties = properties(COMPACT_EXTRACTION_OUTPUT_SCHEMA, "root");
    expect(Object.keys(rootProperties)).not.toContain("status");
    expect(Object.keys(rootProperties)).not.toContain("decisions");
    expect(Object.keys(rootProperties)).not.toContain("autoExecutable");
    expect(JSON.stringify(COMPACT_EXTRACTION_OUTPUT_SCHEMA)).not.toContain("SafeActionPlan");
  });

  it("keeps both staged schemas flat, closed, and free of recursive unions", () => {
    for (const schema of [POLICY_EXTRACTION_OUTPUT_SCHEMA, PROCEDURE_MAPPING_OUTPUT_SCHEMA]) {
      const issues: string[] = [];
      walkJson(schema, (record, path) => {
        for (const keyword of ["oneOf", "anyOf", "allOf", "pattern", "patternProperties"]) {
          if (keyword in record) issues.push(`${path} uses ${keyword}`);
        }
        if (record["type"] === "object") {
          if (record["additionalProperties"] !== false) issues.push(`${path} is open`);
          const objectProperties = properties(record, path);
          const required = new Set(Array.isArray(record["required"]) ? record["required"] : []);
          for (const name of Object.keys(objectProperties)) {
            if (!required.has(name)) issues.push(`${path}.${name} is optional`);
          }
        }
        const reference = record["$ref"];
        if (typeof reference === "string" && !reference.startsWith("#/$defs/")) {
          issues.push(`${path} has a non-local reference`);
        }
      });
      expect(issues).toEqual([]);
      expect(JSON.stringify(schema).length).toBeLessThan(JSON.stringify(COMPACT_EXTRACTION_OUTPUT_SCHEMA).length);
    }
  });
});
