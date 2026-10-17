import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  analyzePolicyExtraction,
  type FocusedSourceCatalog,
} from "../src/extractor/index.js";

const DEFAULT_ARTIFACT = "artifacts/live-extraction-debug.json";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function debugEvent(
  artifact: Readonly<Record<string, unknown>>,
  kind: string,
): Readonly<Record<string, unknown>> {
  const events = artifact["debugEvents"];
  if (!Array.isArray(events)) throw new Error("Debug artifact does not contain debugEvents.");
  const event = events.find((candidate) => isRecord(candidate) && candidate["kind"] === kind);
  if (!isRecord(event)) throw new Error(`Debug artifact does not contain a ${kind} event.`);
  return event;
}

async function main(): Promise<void> {
  const artifactPath = resolve(process.argv[2] ?? DEFAULT_ARTIFACT);
  const raw: unknown = JSON.parse(await readFile(artifactPath, "utf8"));
  if (!isRecord(raw)) throw new Error("Debug artifact root must be an object.");

  const selectionEvent = debugEvent(raw, "source_selection");
  const policyEvent = debugEvent(raw, "policy_dto");
  const selection = selectionEvent["selection"];
  if (!isRecord(selection) || !Array.isArray(selection["pages"])) {
    throw new Error("Debug artifact contains an invalid source-selection event.");
  }

  const analysis = analyzePolicyExtraction(
    policyEvent["policyDto"],
    selection as FocusedSourceCatalog,
  );
  const report = {
    artifactPath,
    outcome: analysis.ok ? "stage1_valid" : "stage1_invalid",
    normalizationCount: analysis.normalizations.length,
    normalizations: analysis.normalizations,
    issues: analysis.ok ? [] : analysis.issues,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!analysis.ok) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Stage 1 replay failed with an unknown error."}\n`,
  );
  process.exitCode = 1;
});
