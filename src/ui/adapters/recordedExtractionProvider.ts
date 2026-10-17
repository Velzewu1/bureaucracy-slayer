import {
  UserStateSchema,
  hashCanonical,
  type EvidenceResult,
  type UserState,
} from "../../contracts/index.js";
import { analyzeDecisionIntelligence } from "../../decision/index.js";
import { evaluatePolicies, planActions } from "../../engine/index.js";
import { validateEvidence } from "../../evidence/index.js";
import { auditSemanticQualifiers } from "../../extractor/semantic-audit.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../../shared/index.js";
import { recordedSonnetBundleInput } from "../generated/recordedSonnetBundle.js";
import {
  RecordedExtractionBundleSchema,
  type RecordedExtractionBundle,
  type RecordedSemanticFinding,
} from "../recordedBundle.js";
import type { AnalysisRequest, DemoAnalysis, DemoDataProvider } from "../types.js";

export type RecordedExtractionErrorCode =
  | "BUNDLE_INVALID"
  | "ARTIFACT_STALE"
  | "GOAL_MISMATCH"
  | "PORTAL_MISMATCH"
  | "SESSION_MISSING";

export class RecordedExtractionError extends Error {
  readonly code: RecordedExtractionErrorCode;

  constructor(code: RecordedExtractionErrorCode, message: string) {
    super(message);
    this.name = "RecordedExtractionError";
    this.code = code;
  }
}

type RecordedSession = Readonly<{
  id: string;
  evidence: EvidenceResult;
  semanticAuditFindings: readonly RecordedSemanticFinding[];
}>;

export type RecordedExtractionProviderOptions = Readonly<{
  bundleInput?: unknown;
  latencyMs?: number;
  now?: () => string;
}>;

function shortHash(value: unknown): string {
  return hashCanonical(value).slice(0, 16);
}

function assertSnapshotHashes(bundle: RecordedExtractionBundle): void {
  for (const page of bundle.sourceSnapshot.pages) {
    for (const block of page.blocks) {
      if (block.textHash !== hashEvidenceBlockText(block.text)) {
        throw new RecordedExtractionError(
          "ARTIFACT_STALE",
          `Recorded evidence block ${block.id} no longer matches its hash.`,
        );
      }
    }
    for (const action of page.actions) {
      if (action.fingerprint !== hashWebsiteActionFingerprint(action)) {
        throw new RecordedExtractionError(
          "ARTIFACT_STALE",
          `Recorded website action ${action.id} no longer matches its fingerprint.`,
        );
      }
    }
    if (page.contentHash !== hashPageSnapshotContent(page)) {
      throw new RecordedExtractionError(
        "ARTIFACT_STALE",
        `Recorded page ${page.id} no longer matches its content hash.`,
      );
    }
  }
  if (bundle.sourceSnapshot.contentHash !== hashSiteSnapshotContent(bundle.sourceSnapshot)) {
    throw new RecordedExtractionError(
      "ARTIFACT_STALE",
      "Recorded snapshot no longer matches its canonical content hash.",
    );
  }
}

function evidenceDisposition(evidence: EvidenceResult): unknown {
  return {
    status: evidence.status,
    validRuleIds: evidence.validRuleIds,
    rejectedRuleIds: evidence.rejectedRuleIds,
    verifiedWebsiteActionIds: evidence.verifiedWebsiteActionIds,
    executableProcedureActionIds: evidence.executableProcedureActionIds,
  };
}

function parseBundle(input: unknown): RecordedExtractionBundle {
  const parsed = RecordedExtractionBundleSchema.safeParse(input);
  if (!parsed.success) {
    throw new RecordedExtractionError(
      "BUNDLE_INVALID",
      `Recorded Sonnet bundle failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    );
  }
  assertSnapshotHashes(parsed.data);
  return parsed.data;
}

export const recordedExtractionBundle = parseBundle(recordedSonnetBundleInput);

export class RecordedExtractionProvider implements DemoDataProvider {
  readonly #bundle: RecordedExtractionBundle;
  readonly #latencyMs: number;
  readonly #now: () => string;
  readonly #sessions = new Map<string, RecordedSession>();

  constructor(options: RecordedExtractionProviderOptions = {}) {
    this.#bundle =
      options.bundleInput === undefined ? recordedExtractionBundle : parseBundle(options.bundleInput);
    this.#latencyMs = options.latencyMs ?? 0;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #pause(): Promise<void> {
    if (this.#latencyMs <= 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.#latencyMs);
    });
  }

  #validateRequest(request: AnalysisRequest): void {
    if (request.goal !== this.#bundle.extractionGoal) {
      throw new RecordedExtractionError(
        "GOAL_MISMATCH",
        "Recorded mode is locked to the goal used for the saved Sonnet extraction.",
      );
    }
    if (request.portalUrl !== this.#bundle.sourceSnapshot.rootUrl) {
      throw new RecordedExtractionError(
        "PORTAL_MISMATCH",
        "Recorded mode is locked to the portal URL in the saved snapshot.",
      );
    }
  }

  #recomputeEvidence(): RecordedSession {
    const audit = auditSemanticQualifiers(
      this.#bundle.sourceSnapshot,
      this.#bundle.procedureModel,
    );
    if (hashCanonical(audit) !== hashCanonical(this.#bundle.semanticAudit)) {
      throw new RecordedExtractionError(
        "ARTIFACT_STALE",
        "The current semantic qualifier audit no longer matches the sanitized bundle.",
      );
    }
    const validation = validateEvidence(
      this.#bundle.sourceSnapshot,
      this.#bundle.procedureModel,
      {
        evidenceResultId: this.#bundle.buildTimeEvidence.id,
        checkedAt: this.#bundle.buildTimeEvidence.checkedAt,
      },
      audit.findings.map((finding) => ({ ruleId: finding.ruleId, message: finding.message })),
    );
    if (!validation.ok) {
      throw new RecordedExtractionError(
        "BUNDLE_INVALID",
        `Recorded bundle failed ${validation.stage} validation.`,
      );
    }
    if (
      hashCanonical(evidenceDisposition(validation.evidence)) !==
      hashCanonical(evidenceDisposition(this.#bundle.buildTimeEvidence))
    ) {
      throw new RecordedExtractionError(
        "ARTIFACT_STALE",
        "Recomputed evidence no longer matches the sanitized bundle disposition.",
      );
    }
    return {
      id: `session_${shortHash({
        kind: "recorded_sonnet",
        snapshotId: this.#bundle.identity.snapshotId,
        modelId: this.#bundle.identity.modelId,
      })}`,
      evidence: validation.evidence,
      semanticAuditFindings: audit.findings,
    };
  }

  #buildAnalysis(session: RecordedSession, userStateInput: UserState): DemoAnalysis {
    const userState = UserStateSchema.parse(userStateInput);
    const evaluation = evaluatePolicies(
      this.#bundle.procedureModel,
      session.evidence,
      userState,
    );
    const plan = planActions(
      this.#bundle.procedureModel,
      session.evidence,
      evaluation,
      userState,
      {
        planId: `plan_${shortHash({
          kind: "recorded_sonnet",
          modelId: this.#bundle.procedureModel.id,
          userState,
        })}`,
        generatedAt: this.#now(),
        userStateHash: hashCanonical(userState),
      },
    );
    const analysis: Omit<DemoAnalysis, "decisionIntelligence"> = {
      sessionId: session.id,
      mode: "recorded_sonnet",
      replanMode: "deterministic_engine",
      goal: this.#bundle.extractionGoal,
      portalName: "Northstar Mock Bank (recorded snapshot)",
      portalUrl: this.#bundle.sourceSnapshot.rootUrl,
      snapshot: this.#bundle.sourceSnapshot,
      model: this.#bundle.procedureModel,
      evidence: session.evidence,
      evaluation,
      plan,
      userState,
      semanticAuditFindings: session.semanticAuditFindings,
      source: {
        kind: "recorded_replay",
        label: "Recorded Sonnet extraction",
        extractionPreviouslyCompleted: true,
        modelName: this.#bundle.provenance.modelName,
        recordedAt: this.#bundle.provenance.recordedAt,
      },
    };
    return { ...analysis, decisionIntelligence: analyzeDecisionIntelligence(analysis) };
  }

  async analyze(request: AnalysisRequest): Promise<DemoAnalysis> {
    await this.#pause();
    this.#validateRequest(request);
    const session = this.#recomputeEvidence();
    this.#sessions.set(session.id, session);
    return this.#buildAnalysis(session, request.userState);
  }

  async replan(sessionId: string, userState: UserState): Promise<DemoAnalysis> {
    await this.#pause();
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RecordedExtractionError(
        "SESSION_MISSING",
        "The recorded extraction session is no longer available.",
      );
    }
    return this.#buildAnalysis(session, userState);
  }

  async getEvidence(sessionId: string): Promise<EvidenceResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RecordedExtractionError(
        "SESSION_MISSING",
        "The recorded extraction session is no longer available.",
      );
    }
    return session.evidence;
  }
}
