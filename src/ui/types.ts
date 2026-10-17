import type {
  EvaluationResult,
  EvidenceResult,
  ProcedureModel,
  SafeActionPlan,
  SiteSnapshot,
  UserState,
} from "../contracts/index.js";
import type { DecisionIntelligence } from "../decision/index.js";
import type {
  LiveExtractionClientStopReason,
} from "../orchestration/live-extraction-contract.js";
import type { RecordedSemanticFinding } from "./recordedBundle.js";

export type DemoMode = "verified_fixture" | "recorded_sonnet" | "live_sonnet";

export type DemoScenarioId =
  | "policy-exception"
  | "dynamic-replanning"
  | "unknown-fact"
  | "evidence-failure";

export type DemoScenario = Readonly<{
  id: DemoScenarioId;
  experiment: string;
  label: string;
  description: string;
  defaultUserState: UserState;
}>;

export type AnalysisRequest = Readonly<{
  goal: string;
  portalUrl: string;
  scenarioId: DemoScenarioId;
  userState: UserState;
}>;

export type LiveExtractionPhase =
  | "queued"
  | "collecting"
  | "selecting_sources"
  | "extracting_policy"
  | "mapping_procedure"
  | "validating"
  | "complete"
  | "failed";

export type AnalysisProgress = Readonly<{
  phase: LiveExtractionPhase;
  jobId?: string;
}>;

export type AnalysisRunOptions = Readonly<{
  onProgress?: (progress: AnalysisProgress) => void;
}>;

export type LiveResumeState = "none" | "request" | "job" | "blocked";

export type DemoAnalysis = Readonly<{
  sessionId: string;
  mode: DemoMode;
  replanMode: "deterministic_engine";
  goal: string;
  portalName: string;
  portalUrl: string;
  snapshot: SiteSnapshot;
  model: ProcedureModel;
  evidence: EvidenceResult;
  evaluation: EvaluationResult;
  plan: SafeActionPlan;
  userState: UserState;
  decisionIntelligence: DecisionIntelligence;
  semanticAuditFindings: readonly RecordedSemanticFinding[];
  source: Readonly<{
    kind:
      | "verified_fixture"
      | "recorded_replay"
      | "live_extraction"
      | "offline_mock_replay";
    label: string;
    extractionPreviouslyCompleted: boolean;
    modelName?: string;
    recordedAt?: string;
  }>;
}>;

export interface DemoDataProvider {
  analyze(request: AnalysisRequest, options?: AnalysisRunOptions): Promise<DemoAnalysis>;
  replan(sessionId: string, userState: UserState): Promise<DemoAnalysis>;
  getEvidence(sessionId: string): Promise<EvidenceResult>;
  stop?(reason: LiveExtractionClientStopReason): void;
  canResume?(): boolean;
  resumeState?(): LiveResumeState;
}
