import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import {
  createAnthropicTransport,
  parseAnthropicMaxTokens,
  resumeProcedureMapping,
  type ExtractionDebugEvent,
} from "../src/extractor/index.js";

const DEFAULT_ARTIFACT = "artifacts/live-extraction-debug.json";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_PATH = join(PROJECT_ROOT, ".env");
const OUTPUT_DIRECTORY = join(PROJECT_ROOT, "artifacts");
const PAID_CONFIRMATION = "RUN_PAID_STAGE2";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function savedEvent(
  artifact: Readonly<Record<string, unknown>>,
  kind: "source_selection" | "policy_dto",
): Readonly<Record<string, unknown>> {
  const events = artifact["debugEvents"];
  if (!Array.isArray(events)) throw new Error("Source artifact does not contain debugEvents.");
  const event = [...events]
    .reverse()
    .find((candidate) => isRecord(candidate) && candidate["kind"] === kind);
  if (!isRecord(event)) throw new Error(`Source artifact does not contain a ${kind} event.`);
  return event;
}

function uniqueArtifactPath(): string {
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const suffix = randomUUID().slice(0, 8);
  return join(OUTPUT_DIRECTORY, `live-stage2-resume-${timestamp}-${suffix}.json`);
}

async function main(): Promise<void> {
  if (existsSync(ENV_PATH)) loadEnvFile(ENV_PATH);
  if (process.env[PAID_CONFIRMATION]?.trim() !== "1") {
    throw new Error(
      `${PAID_CONFIRMATION}=1 is required to authorize exactly one Stage 2 Anthropic request.`,
    );
  }

  const sourceArtifactPath = resolve(PROJECT_ROOT, process.argv[2] ?? DEFAULT_ARTIFACT);
  const artifactInput: unknown = JSON.parse(await readFile(sourceArtifactPath, "utf8"));
  if (!isRecord(artifactInput)) throw new Error("Source artifact root must be an object.");
  const sourceSnapshot = artifactInput["sourceSnapshot"];
  const selection = savedEvent(artifactInput, "source_selection")["selection"];
  const policyDto = savedEvent(artifactInput, "policy_dto")["policyDto"];

  const apiKey = requiredEnvironmentValue("ANTHROPIC_API_KEY");
  const model = requiredEnvironmentValue("ANTHROPIC_MODEL");
  const maxTokens = parseAnthropicMaxTokens(process.env["ANTHROPIC_MAX_TOKENS"], model);
  if (!maxTokens.ok) throw new Error(maxTokens.message);

  const debugEvents: ExtractionDebugEvent[] = [];
  const transport = await createAnthropicTransport({ apiKey, environment: process.env });
  const outcome = await resumeProcedureMapping(sourceSnapshot, selection, policyDto, {
    transport,
    model,
    maxTokens: maxTokens.value,
    maxTransientRetries: 0,
    sourceArtifactLabel: basename(sourceArtifactPath),
    evidenceContext: {
      evidenceResultId: `evidence_${randomUUID().replaceAll("-", "")}`,
      checkedAt: new Date().toISOString(),
    },
    onDebugEvent: (event): void => void debugEvents.push(event),
  });

  const mappingEvent = [...debugEvents]
    .reverse()
    .find((event) => event.kind === "procedure_mapping_dto");
  const output = {
    artifactKind: "saved_stage1_stage2_resume",
    createdAt: new Date().toISOString(),
    provenance: {
      stage1Source: "saved_artifact",
      sourceArtifactLabel: basename(sourceArtifactPath),
      reusedSnapshotId: isRecord(sourceSnapshot) ? sourceSnapshot["id"] : null,
      reusedSnapshotHash: isRecord(sourceSnapshot) ? sourceSnapshot["contentHash"] : null,
      reusedPolicyAnalysisId: isRecord(policyDto) ? policyDto["policyAnalysisId"] : null,
    },
    configuration: {
      model,
      maxTokens: maxTokens.value,
      expectedPaidCalls: 1,
      retries: 0,
    },
    reusedInputs: { sourceSnapshot, focusedSourceCatalog: selection, policyDto },
    stage2Dto: mappingEvent?.kind === "procedure_mapping_dto"
      ? mappingEvent.procedureMappingDto
      : null,
    result: outcome,
    debugEvents,
  };
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const outputPath = uniqueArtifactPath();
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  process.stdout.write(
    `${JSON.stringify({ outputPath, outcome: outcome.ok ? outcome.status : "typed_failure", result: outcome }, null, 2)}\n`,
  );
  if (!outcome.ok) process.exitCode = 1;
  else if (outcome.status === "review_required") process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Stage 2 resume failed with an unknown error."}\n`,
  );
  process.exitCode = 1;
});
