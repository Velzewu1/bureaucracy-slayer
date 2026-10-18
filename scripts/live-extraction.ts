import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectWebsite } from "../src/collector/index.js";
import type { SiteSnapshot } from "../src/contracts/index.js";
import {
  createAnthropicTransport,
  extractProcedure,
  parseAnthropicMaxTokens,
  type ExtractionDebugEvent,
  type ExtractionOutcome,
  type FocusedSourceCatalog,
} from "../src/extractor/index.js";

const USER_GOAL =
  "I sent an $850 transfer to the wrong recipient. Can I cancel it? If not, what are my alternatives?";
const DEBUG_FLAG = "LIVE_EXTRACTION_SAVE_DEBUG";
const DEBUG_PATH_VARIABLE = "LIVE_EXTRACTION_DEBUG_PATH";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_PATH = join(PROJECT_ROOT, ".env");
const DEFAULT_DEBUG_RELATIVE_PATH = join("artifacts", "live-extraction-debug.json");

type Environment = Readonly<Record<string, string | undefined>>;

export type LiveConfigurationSummary = Readonly<{
  environmentSource: ".env and process environment" | "process environment only";
  model: string;
  maxTokens: number;
  modelOutputTokenLimit: number;
  collectorUrl: string;
  workspaceConfigured: boolean;
  extractionMode: "general" | "goal_scoped";
}>;

type SnapshotSummary = Readonly<{
  pageCount: number;
  evidenceBlockCount: number;
  actionCount: number;
  snapshotHash: string;
}>;

type RunnerFailure = Readonly<{
  outcome: "runner_failure";
  message: string;
}>;

type RunCapture = {
  configuration?: LiveConfigurationSummary;
  snapshot?: SiteSnapshot;
  readonly debugEvents: ExtractionDebugEvent[];
};

function requiredEnvironmentValue(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required. Set it before running the live extraction.`);
  }
  return value;
}

function loadRootEnvironment(): boolean {
  if (!existsSync(ENV_PATH)) return false;
  loadEnvFile(ENV_PATH);
  return true;
}

function localPortalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("COLLECTOR_TEST_URL must be a valid local HTTP(S) URL.");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !localHosts.has(url.hostname)) {
    throw new Error("COLLECTOR_TEST_URL must point to the fictional portal on localhost.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error("COLLECTOR_TEST_URL must not contain embedded credentials.");
  }
  return url.href;
}

function debugRequested(environment: Environment): boolean {
  const value = environment[DEBUG_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function extractionMode(environment: Environment): "general" | "goal_scoped" {
  const value = environment["LIVE_EXTRACTION_MODE"]?.trim().toLowerCase() ?? "goal_scoped";
  if (value === "general" || value === "goal_scoped") return value;
  throw new Error("LIVE_EXTRACTION_MODE must be either general or goal_scoped.");
}

/** Resolves an explicitly enabled debug artifact to this repository's artifacts directory. */
export function resolveDebugOutputPath(
  environment: Environment,
  projectRoot = PROJECT_ROOT,
): string | undefined {
  if (!debugRequested(environment)) return undefined;
  const artifactsDirectory = resolve(projectRoot, "artifacts");
  const requested = environment[DEBUG_PATH_VARIABLE]?.trim();
  const outputPath = resolve(
    projectRoot,
    requested === undefined || requested.length === 0 ? DEFAULT_DEBUG_RELATIVE_PATH : requested,
  );
  const relativePath = relative(artifactsDirectory, outputPath);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${DEBUG_PATH_VARIABLE} must resolve to a JSON file under artifacts/.`);
  }
  if (!outputPath.toLowerCase().endsWith(".json")) {
    throw new Error(`${DEBUG_PATH_VARIABLE} must name a .json file.`);
  }
  return outputPath;
}

/** Fails before collection or transport creation if a requested artifact would be overwritten. */
export function assertDebugOutputAvailable(outputPath: string | undefined): void {
  if (outputPath !== undefined && existsSync(outputPath)) {
    throw new Error(`Debug output path already exists: ${outputPath}`);
  }
}

export function readLiveConfiguration(
  environment: Environment,
  envFileLoaded: boolean,
): Readonly<{ configuration: LiveConfigurationSummary; apiKey: string }> {
  const startUrl = localPortalUrl(requiredEnvironmentValue(environment, "COLLECTOR_TEST_URL"));
  const apiKey = requiredEnvironmentValue(environment, "ANTHROPIC_API_KEY");
  const model = requiredEnvironmentValue(environment, "ANTHROPIC_MODEL");
  const maxTokensResult = parseAnthropicMaxTokens(environment["ANTHROPIC_MAX_TOKENS"], model);
  if (!maxTokensResult.ok) throw new Error(maxTokensResult.message);
  return {
    apiKey,
    configuration: {
      environmentSource: envFileLoaded ? ".env and process environment" : "process environment only",
      model,
      maxTokens: maxTokensResult.value,
      modelOutputTokenLimit: maxTokensResult.modelLimit,
      collectorUrl: startUrl,
      workspaceConfigured: Boolean(environment["ANTHROPIC_WORKSPACE_ID"]?.trim()),
      extractionMode: extractionMode(environment),
    },
  };
}

function writeJson(label: string, value: unknown): void {
  process.stdout.write(`${label}:\n${JSON.stringify(value, null, 2)}\n`);
}

/** Uses exclusive creation so a race after preflight still cannot overwrite an artifact. */
export async function writeDebugRecording(outputPath: string, value: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

async function saveDebugOutput(outputPath: string | undefined, value: unknown): Promise<void> {
  if (outputPath === undefined) return;
  await writeDebugRecording(outputPath, value);
  process.stdout.write(`Sanitized debug output saved to ${outputPath}\n`);
}

function snapshotSummary(snapshot: SiteSnapshot): SnapshotSummary {
  return {
    pageCount: snapshot.pages.length,
    evidenceBlockCount: snapshot.pages.reduce((count, page) => count + page.blocks.length, 0),
    actionCount: snapshot.pages.reduce((count, page) => count + page.actions.length, 0),
    snapshotHash: snapshot.contentHash,
  };
}

function evidenceResultId(): string {
  return `evidence_${randomUUID().replaceAll("-", "")}`;
}

function latestEvent<K extends ExtractionDebugEvent["kind"]>(
  events: readonly ExtractionDebugEvent[],
  kind: K,
): Extract<ExtractionDebugEvent, Readonly<{ kind: K }>> | undefined {
  return [...events]
    .reverse()
    .find(
      (candidate): candidate is Extract<ExtractionDebugEvent, Readonly<{ kind: K }>> =>
        candidate.kind === kind,
    );
}

function stringProperty(value: unknown, property: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : null;
}

function stageStatus(
  debugEvents: readonly ExtractionDebugEvent[],
  stage: "policy_extraction" | "procedure_mapping" | "canonical_schema",
): "valid" | "failed" | "not_started" {
  const event = [...debugEvents]
    .reverse()
    .find((candidate) => candidate.kind === "stage_outcome" && candidate.stage === stage);
  return event?.kind === "stage_outcome" ? event.status : "not_started";
}

function buildPipelineSummary(
  configuration: LiveConfigurationSummary | undefined,
  summary: SnapshotSummary | undefined,
  outcome: ExtractionOutcome | undefined,
  debugEvents: readonly ExtractionDebugEvent[],
  runtimeMs: number,
): Readonly<Record<string, unknown>> {
  const selection = outcome?.ok
    ? outcome.sourceSelection
    : latestEvent(debugEvents, "source_selection")?.selection;
  const responseMetadata = Object.fromEntries(
    debugEvents
      .filter((event) => event.kind === "claude_response_metadata")
      .map((event) => [event.stage, event.metadata]),
  );
  return {
    original: selection?.originalCounts ?? (summary === undefined
      ? null
      : { pages: summary.pageCount, blocks: summary.evidenceBlockCount, actions: summary.actionCount }),
    selected: selection?.selectedCounts ?? null,
    sourceSelectionMode: selection?.selectionMode ?? "not_started",
    selectionCoverage: selection?.coverage ?? "not_started",
    semanticCoverage: selection?.semanticCoverage ?? "not_verified",
    selectionLimitations: selection?.limitations ?? [],
    model: configuration?.model ?? null,
    actualClaudeCalls: outcome?.attempts ?? 0,
    responseMetadata,
    stage1: stageStatus(debugEvents, "policy_extraction"),
    stage2: stageStatus(debugEvents, "procedure_mapping"),
    canonicalSchema: stageStatus(debugEvents, "canonical_schema"),
    evidenceValidation: outcome?.ok ? outcome.evidence.status : "not_completed",
    runtimeMs,
  };
}

function validationIssues(
  outcome: ExtractionOutcome | undefined,
  debugEvents: readonly ExtractionDebugEvent[],
  runnerFailure: RunnerFailure | undefined,
): Readonly<Record<string, unknown>> {
  return {
    stageOutcomes: debugEvents
      .filter((event) => event.kind === "stage_outcome")
      .map((event) => ({ stage: event.stage, status: event.status, issues: event.issues })),
    conversionFailures: debugEvents
      .filter((event) => event.kind === "conversion_failure")
      .map((event) => ({ stage: event.conversionStage, issues: event.issues })),
    evidenceValidationFailures: debugEvents
      .filter((event) => event.kind === "evidence_validation_failure")
      .flatMap((event) => event.issues),
    evidenceIssues: outcome?.ok ? outcome.evidence.issues : [],
    terminalIssues: outcome !== undefined && !outcome.ok ? outcome.issues : [],
    runnerIssue: runnerFailure?.message ?? null,
  };
}

function provenance(
  snapshot: SiteSnapshot | undefined,
  focusedSourceCatalog: FocusedSourceCatalog | undefined,
  stage1Dto: unknown,
  stage2Dto: unknown,
  outcome: ExtractionOutcome | undefined,
): Readonly<Record<string, unknown>> {
  return {
    sourceSnapshot: snapshot === undefined ? null : { id: snapshot.id, contentHash: snapshot.contentHash },
    focusedSourceCatalog: focusedSourceCatalog === undefined
      ? null
      : {
          sourceSnapshotId: focusedSourceCatalog.sourceSnapshotId,
          sourceSnapshotHash: focusedSourceCatalog.sourceSnapshotHash,
        },
    stage1: stage1Dto === undefined
      ? null
      : {
          policyAnalysisId: stringProperty(stage1Dto, "policyAnalysisId"),
          sourceSnapshotId: stringProperty(stage1Dto, "sourceSnapshotId"),
          sourceSnapshotHash: stringProperty(stage1Dto, "sourceSnapshotHash"),
        },
    stage2: stage2Dto === undefined
      ? null
      : {
          procedureMappingId: stringProperty(stage2Dto, "id"),
          sourceSnapshotId: stringProperty(stage2Dto, "sourceSnapshotId"),
          sourceSnapshotHash: stringProperty(stage2Dto, "sourceSnapshotHash"),
        },
    canonicalModel: outcome?.ok
      ? {
          procedureModelId: outcome.model.id,
          sourceSnapshotId: outcome.model.sourceSnapshotId,
          sourceSnapshotHash: outcome.model.sourceSnapshotHash,
        }
      : null,
    evidenceResult: outcome?.ok
      ? {
          evidenceResultId: outcome.evidence.id,
          snapshotId: outcome.evidence.snapshotId,
          snapshotHash: outcome.evidence.snapshotHash,
          procedureModelId: outcome.evidence.procedureModelId,
        }
      : null,
  };
}

export function createLiveExtractionRecording(input: Readonly<{
  createdAt: string;
  configuration?: LiveConfigurationSummary;
  snapshot?: SiteSnapshot;
  outcome?: ExtractionOutcome;
  debugEvents: readonly ExtractionDebugEvent[];
  runtimeMs: number;
  runnerFailure?: RunnerFailure;
}>): Readonly<Record<string, unknown>> {
  const summary = input.snapshot === undefined ? undefined : snapshotSummary(input.snapshot);
  const selection = input.outcome?.ok
    ? input.outcome.sourceSelection
    : latestEvent(input.debugEvents, "source_selection")?.selection;
  const stage1Dto = latestEvent(input.debugEvents, "policy_dto")?.policyDto;
  const stage2Dto = latestEvent(input.debugEvents, "procedure_mapping_dto")?.procedureMappingDto;
  const compactDto = latestEvent(input.debugEvents, "compact_dto")?.compactDto;
  const evidence = input.outcome?.ok
    ? input.outcome.evidence
    : latestEvent(input.debugEvents, "evidence_validation")?.evidence;
  const complete = input.outcome?.ok === true;
  const pipelineSummary = buildPipelineSummary(
    input.configuration,
    summary,
    input.outcome,
    input.debugEvents,
    input.runtimeMs,
  );
  const outcomeLabel = input.outcome?.ok
    ? input.outcome.status
    : input.outcome === undefined
      ? "runner_failure"
      : "typed_failure";

  return {
    artifactKind: "live_extraction_recording",
    recordingVersion: 1,
    recordingStatus: complete ? "complete" : "partial",
    createdAt: input.createdAt,
    configuration: input.configuration ?? null,
    snapshotSummary: summary ?? null,
    sourceSnapshot: input.snapshot ?? null,
    focusedSourceCatalog: selection ?? null,
    stage1Dto: stage1Dto ?? null,
    stage2Dto: stage2Dto ?? null,
    canonicalConversionDto: compactDto ?? null,
    canonicalModel: input.outcome?.ok ? input.outcome.model : null,
    evidenceResult: evidence ?? null,
    validationIssues: validationIssues(input.outcome, input.debugEvents, input.runnerFailure),
    provenance: provenance(input.snapshot, selection, stage1Dto, stage2Dto, input.outcome),
    pipelineSummary,
    outcome: outcomeLabel,
    ...(input.outcome !== undefined && !input.outcome.ok ? { failure: input.outcome } : {}),
    ...(input.runnerFailure === undefined ? {} : { failure: input.runnerFailure }),
    ...(input.outcome?.ok
      ? {
          attempts: input.outcome.attempts,
          procedureModel: input.outcome.model,
          evidenceValidation: {
            status: input.outcome.evidence.status,
            issues: input.outcome.evidence.issues,
          },
        }
      : {}),
    debugEvents: input.debugEvents,
  };
}

function sanitizedErrorMessage(error: unknown, environment: Environment): string {
  let message = error instanceof Error ? error.message : "Live extraction failed with an unknown error.";
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"]) {
    const secret = environment[name]?.trim();
    if (secret !== undefined && secret.length > 0) message = message.replaceAll(secret, "[redacted]");
  }
  return message;
}

async function reportExtraction(
  outputPath: string | undefined,
  configuration: LiveConfigurationSummary,
  snapshot: SiteSnapshot,
  outcome: ExtractionOutcome,
  debugEvents: readonly ExtractionDebugEvent[],
  runtimeMs: number,
): Promise<void> {
  const recording = createLiveExtractionRecording({
    createdAt: new Date().toISOString(),
    configuration,
    snapshot,
    outcome,
    debugEvents,
    runtimeMs,
  });
  writeJson("Pipeline summary", recording["pipelineSummary"]);

  if (!outcome.ok) {
    writeJson("Extraction outcome", { outcome: "typed_failure", failure: outcome });
    await saveDebugOutput(outputPath, recording);
    process.exitCode = 1;
    return;
  }

  writeJson("Extraction outcome", {
    outcome: outcome.status,
    attempts: outcome.attempts,
    procedureModel: outcome.model,
    evidenceValidation: {
      status: outcome.evidence.status,
      issues: outcome.evidence.issues,
    },
  });
  await saveDebugOutput(outputPath, recording);
  if (outcome.status === "review_required") process.exitCode = 2;
}

async function reportRunnerFailure(
  error: unknown,
  environment: Environment,
  outputPath: string | undefined,
  capture: RunCapture,
  startedAt: number,
): Promise<void> {
  const failure: RunnerFailure = {
    outcome: "runner_failure",
    message: sanitizedErrorMessage(error, environment),
  };
  writeJson("Live extraction failed", failure);
  if (outputPath !== undefined) {
    try {
      await saveDebugOutput(
        outputPath,
        createLiveExtractionRecording({
          createdAt: new Date().toISOString(),
          ...(capture.configuration === undefined ? {} : { configuration: capture.configuration }),
          ...(capture.snapshot === undefined ? {} : { snapshot: capture.snapshot }),
          debugEvents: capture.debugEvents,
          runtimeMs: Date.now() - startedAt,
          runnerFailure: failure,
        }),
      );
    } catch {
      process.stderr.write("Sanitized debug output could not be saved without overwriting a file.\n");
    }
  }
  process.exitCode = 1;
}

export async function main(): Promise<void> {
  const startedAt = Date.now();
  const capture: RunCapture = { debugEvents: [] };
  const envFileLoaded = loadRootEnvironment();
  const environment: Environment = process.env;
  let outputPath: string | undefined;

  try {
    outputPath = resolveDebugOutputPath(environment);
    assertDebugOutputAvailable(outputPath);
    const { configuration, apiKey } = readLiveConfiguration(environment, envFileLoaded);
    capture.configuration = configuration;
    writeJson("Live extraction configuration", configuration);

    const snapshot = await collectWebsite({
      startUrl: configuration.collectorUrl,
      allowedOrigins: [configuration.collectorUrl],
      maxPages: 12,
      maxDepth: 3,
      navigationTimeoutMs: 10_000,
    });
    capture.snapshot = snapshot;
    writeJson("Snapshot summary", snapshotSummary(snapshot));

    const transport = await createAnthropicTransport({ apiKey, environment });
    const outcome = await extractProcedure(snapshot, USER_GOAL, {
      transport,
      model: configuration.model,
      maxTokens: configuration.maxTokens,
      ...(configuration.extractionMode === "goal_scoped"
        ? {
            goalScope: {
              primaryActionPurpose: "cancel the transfer",
              alternativeActionPurposes: ["request recovery"],
            },
          }
        : {}),
      evidenceContext: {
        evidenceResultId: evidenceResultId(),
        checkedAt: new Date().toISOString(),
      },
      onDebugEvent: (event: ExtractionDebugEvent): void => void capture.debugEvents.push(event),
    });
    await reportExtraction(
      outputPath,
      configuration,
      snapshot,
      outcome,
      capture.debugEvents,
      Date.now() - startedAt,
    );
  } catch (error: unknown) {
    await reportRunnerFailure(error, environment, outputPath, capture, startedAt);
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main();
}
