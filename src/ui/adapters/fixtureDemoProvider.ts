import {
  UserStateSchema,
  hashCanonical,
  type EvidenceResult,
  type ProcedureModel,
  type UserState,
} from "../../contracts/index.js";
import { analyzeDecisionIntelligence } from "../../decision/index.js";
import { evaluatePolicies, planActions } from "../../engine/index.js";
import { validateEvidence } from "../../evidence/index.js";
import {
  demoProcedureModel,
  demoScenarios,
  demoSnapshot,
  wrongQuoteModel,
} from "../fixtures/demoArtifacts.js";
import type {
  AnalysisRequest,
  DemoAnalysis,
  DemoDataProvider,
  DemoScenarioId,
} from "../types.js";

type Session = Readonly<{
  id: string;
  goal: string;
  scenarioId: DemoScenarioId;
  model: ProcedureModel;
  evidence: EvidenceResult;
}>;

export type FixtureDemoProviderOptions = Readonly<{
  latencyMs?: number;
  now?: () => string;
}>;

function getScenario(id: DemoScenarioId) {
  const scenario = demoScenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`Unsupported demo scenario: ${id}`);
  return scenario;
}

function modelForScenario(id: DemoScenarioId): ProcedureModel {
  return id === "evidence-failure" ? wrongQuoteModel : demoProcedureModel;
}

function shortHash(value: unknown): string {
  return hashCanonical(value).slice(0, 16);
}

export class FixtureDemoProvider implements DemoDataProvider {
  readonly #latencyMs: number;
  readonly #now: () => string;
  readonly #sessions = new Map<string, Session>();

  constructor(options: FixtureDemoProviderOptions = {}) {
    this.#latencyMs = options.latencyMs ?? 0;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async #pause(): Promise<void> {
    if (this.#latencyMs <= 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.#latencyMs);
    });
  }

  #buildAnalysis(session: Session, userStateInput: UserState): DemoAnalysis {
    const userState = UserStateSchema.parse(userStateInput);
    const evaluation = evaluatePolicies(session.model, session.evidence, userState);
    const userStateHash = hashCanonical(userState);
    const plan = planActions(session.model, session.evidence, evaluation, userState, {
      planId: `plan_${shortHash({
        scenarioId: session.scenarioId,
        modelId: session.model.id,
        userState,
      })}`,
      generatedAt: this.#now(),
      userStateHash,
    });

    const analysis: Omit<DemoAnalysis, "decisionIntelligence"> = {
      sessionId: session.id,
      mode: "recorded_fixture",
      replanMode: "deterministic_engine",
      goal: session.goal,
      portalName: "Northstar Mock Portal",
      portalUrl: demoSnapshot.rootUrl,
      snapshot: demoSnapshot,
      model: session.model,
      evidence: session.evidence,
      evaluation,
      plan,
      userState,
    };
    return {
      ...analysis,
      decisionIntelligence: analyzeDecisionIntelligence(analysis),
    };
  }

  async analyze(request: AnalysisRequest): Promise<DemoAnalysis> {
    await this.#pause();
    getScenario(request.scenarioId);
    if (request.goal.trim().length === 0) throw new Error("Enter a goal before starting analysis.");
    if (request.portalUrl !== demoSnapshot.rootUrl) {
      throw new Error("Fixture mode can analyze only the selected fictional portal.");
    }

    const model = modelForScenario(request.scenarioId);
    const modelKey = { scenarioId: request.scenarioId, modelId: model.id };
    const validation = validateEvidence(demoSnapshot, model, {
      evidenceResultId: `evidence_${shortHash(modelKey)}`,
      checkedAt: this.#now(),
    });
    if (!validation.ok) {
      throw new Error(`Recorded fixture failed ${validation.stage} validation.`);
    }

    const session: Session = {
      id: `session_${shortHash({ goal: request.goal, ...modelKey })}`,
      goal: request.goal.trim(),
      scenarioId: request.scenarioId,
      model: validation.model,
      evidence: validation.evidence,
    };
    this.#sessions.set(session.id, session);
    return this.#buildAnalysis(session, request.userState);
  }

  async replan(sessionId: string, userStateInput: UserState): Promise<DemoAnalysis> {
    await this.#pause();
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("The demo analysis session is no longer available.");
    return this.#buildAnalysis(session, userStateInput);
  }

  async getEvidence(sessionId: string): Promise<EvidenceResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("The demo analysis session is no longer available.");
    return session.evidence;
  }
}
