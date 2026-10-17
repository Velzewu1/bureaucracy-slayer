import type {
  EvaluationResult,
  EvidenceResult,
  ProcedureModel,
  SafeActionPlan,
  SiteSnapshot,
  UserState,
} from "../contracts/index.js";

export type DemoScenarioId = "policy-exception" | "dynamic-replanning" | "evidence-failure";

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

export type DemoAnalysis = Readonly<{
  sessionId: string;
  mode: "recorded_fixture";
  replanMode: "deterministic_engine";
  goal: string;
  portalName: string;
  portalUrl: string;
  snapshot: SiteSnapshot;
  model: ProcedureModel;
  evidence: EvidenceResult;
  evaluation: EvaluationResult;
  plan: SafeActionPlan;
}>;

export interface DemoDataProvider {
  analyze(request: AnalysisRequest): Promise<DemoAnalysis>;
  replan(sessionId: string, userState: UserState): Promise<DemoAnalysis>;
  getEvidence(sessionId: string): Promise<EvidenceResult>;
}
