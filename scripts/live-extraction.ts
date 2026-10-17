import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { collectWebsite } from "../src/collector/index.js";
import {
  createAnthropicTransport,
  extractProcedure,
  parseAnthropicMaxTokens,
  type ExtractionDebugEvent,
  type ExtractionOutcome,
} from "../src/extractor/index.js";

const USER_GOAL =
  "I sent an $850 transfer to the wrong recipient. Can I cancel it? If not, what are my alternatives?";
const DEBUG_FLAG = "LIVE_EXTRACTION_SAVE_DEBUG";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_PATH = join(PROJECT_ROOT, ".env");
const DEBUG_DIRECTORY = join(PROJECT_ROOT, "artifacts");
const DEBUG_PATH = join(DEBUG_DIRECTORY, "live-extraction-debug.json");

type LiveConfigurationSummary = Readonly<{
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

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();
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

function debugRequested(): boolean {
  const value = process.env[DEBUG_FLAG]?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function extractionMode(): "general" | "goal_scoped" {
  const value = process.env["LIVE_EXTRACTION_MODE"]?.trim().toLowerCase() ?? "goal_scoped";
  if (value === "general" || value === "goal_scoped") return value;
  throw new Error("LIVE_EXTRACTION_MODE must be either general or goal_scoped.");
}

function writeJson(label: string, value: unknown): void {
  process.stdout.write(`${label}:\n${JSON.stringify(value, null, 2)}\n`);
}

async function saveDebugOutput(value: unknown): Promise<void> {
  if (!debugRequested()) return;
  await mkdir(DEBUG_DIRECTORY, { recursive: true });
  await writeFile(DEBUG_PATH, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  process.stdout.write(`Sanitized debug output saved to ${DEBUG_PATH}\n`);
}

function snapshotSummary(snapshot: Awaited<ReturnType<typeof collectWebsite>>): SnapshotSummary {
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

async function reportExtraction(
  configuration: LiveConfigurationSummary,
  summary: SnapshotSummary,
  snapshot: Awaited<ReturnType<typeof collectWebsite>>,
  outcome: ExtractionOutcome,
  debugEvents: readonly ExtractionDebugEvent[],
  runtimeMs: number,
): Promise<void> {
  const selectionEvent = debugEvents.find((event) => event.kind === "source_selection");
  const stageStatus = (stage: "policy_extraction" | "procedure_mapping" | "canonical_schema") => {
    const event = [...debugEvents]
      .reverse()
      .find((candidate) => candidate.kind === "stage_outcome" && candidate.stage === stage);
    return event?.kind === "stage_outcome" ? event.status : "not_started";
  };
  const sourceSelection = outcome.ok
    ? outcome.sourceSelection
    : selectionEvent?.kind === "source_selection"
      ? selectionEvent.selection
      : undefined;
  const responseMetadata = Object.fromEntries(
    debugEvents
      .filter((event) => event.kind === "claude_response_metadata")
      .map((event) => [event.stage, event.metadata]),
  );
  const pipelineSummary = {
    original: sourceSelection?.originalCounts ?? {
      pages: summary.pageCount,
      blocks: summary.evidenceBlockCount,
      actions: summary.actionCount,
    },
    selected: sourceSelection?.selectedCounts ?? null,
    sourceSelectionMode: sourceSelection?.selectionMode ?? "general",
    selectionCoverage: sourceSelection?.coverage ?? "not_started",
    semanticCoverage: sourceSelection?.semanticCoverage ?? "not_verified",
    selectionLimitations: sourceSelection?.limitations ?? [],
    model: configuration.model,
    actualClaudeCalls: outcome.attempts,
    responseMetadata,
    stage1: stageStatus("policy_extraction"),
    stage2: stageStatus("procedure_mapping"),
    canonicalSchema: stageStatus("canonical_schema"),
    evidenceValidation: outcome.ok ? outcome.evidence.status : "not_completed",
    runtimeMs,
  };
  writeJson("Pipeline summary", pipelineSummary);

  if (!outcome.ok) {
    writeJson("Extraction outcome", { outcome: "typed_failure", failure: outcome });
    await saveDebugOutput({
      configuration,
      snapshotSummary: summary,
      sourceSnapshot: snapshot,
      outcome: "typed_failure",
      failure: outcome,
      debugEvents,
      pipelineSummary,
    });
    process.exitCode = 1;
    return;
  }

  const report = {
    outcome: outcome.status,
    attempts: outcome.attempts,
    procedureModel: outcome.model,
    evidenceValidation: {
      status: outcome.evidence.status,
      issues: outcome.evidence.issues,
    },
  };
  writeJson("Extraction outcome", report);
  await saveDebugOutput({
    configuration,
    snapshotSummary: summary,
    sourceSnapshot: snapshot,
    pipelineSummary,
    ...report,
    debugEvents,
  });

  if (outcome.status === "review_required") process.exitCode = 2;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const envFileLoaded = loadRootEnvironment();
  const startUrl = localPortalUrl(requiredEnvironmentValue("COLLECTOR_TEST_URL"));
  const apiKey = requiredEnvironmentValue("ANTHROPIC_API_KEY");
  const model = requiredEnvironmentValue("ANTHROPIC_MODEL");
  const maxTokensResult = parseAnthropicMaxTokens(process.env["ANTHROPIC_MAX_TOKENS"], model);
  if (!maxTokensResult.ok) throw new Error(maxTokensResult.message);
  const mode = extractionMode();
  const debugEvents: ExtractionDebugEvent[] = [];

  const configuration: LiveConfigurationSummary = {
    environmentSource: envFileLoaded ? ".env and process environment" : "process environment only",
    model,
    maxTokens: maxTokensResult.value,
    modelOutputTokenLimit: maxTokensResult.modelLimit,
    collectorUrl: startUrl,
    workspaceConfigured: Boolean(process.env["ANTHROPIC_WORKSPACE_ID"]?.trim()),
    extractionMode: mode,
  };
  writeJson("Live extraction configuration", configuration);

  const snapshot = await collectWebsite({
    startUrl,
    allowedOrigins: [startUrl],
    maxPages: 12,
    maxDepth: 3,
    navigationTimeoutMs: 10_000,
  });
  const summary = snapshotSummary(snapshot);
  writeJson("Snapshot summary", summary);

  const transport = await createAnthropicTransport({ apiKey, environment: process.env });
  const outcome = await extractProcedure(snapshot, USER_GOAL, {
    transport,
    model,
    maxTokens: maxTokensResult.value,
    ...(mode === "goal_scoped"
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
    onDebugEvent: (event: ExtractionDebugEvent): void => void debugEvents.push(event),
  });
  await reportExtraction(configuration, summary, snapshot, outcome, debugEvents, Date.now() - startedAt);
}

async function reportRunnerFailure(error: unknown): Promise<void> {
  const failure = {
    outcome: "runner_failure",
    message: error instanceof Error ? error.message : "Live extraction failed with an unknown error.",
  };
  writeJson("Live extraction failed", failure);
  try {
    await saveDebugOutput(failure);
  } catch {
    process.stderr.write("Sanitized debug output could not be saved.\n");
  }
  process.exitCode = 1;
}

void main().catch(reportRunnerFailure);
