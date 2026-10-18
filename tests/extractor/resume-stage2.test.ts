import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { SiteSnapshotSchema } from "../../src/contracts/index.js";
import {
  resumeProcedureMapping,
  selectFocusedSources,
  type ClaudeMessageRequest,
  type ClaudeTransport,
} from "../../src/extractor/index.js";
import {
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../../src/shared/index.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  evidenceContextFixture,
} from "../fixtures/p0.js";
import { stagedFixturesFromModel } from "./compact-fixture.js";

const USER_GOAL = "Cancel this transfer or identify an evidenced recovery path.";

class FakeTransport implements ClaudeTransport {
  readonly requests: ClaudeMessageRequest[] = [];

  constructor(private readonly response: unknown) {}

  createMessage(request: ClaudeMessageRequest): Promise<unknown> {
    this.requests.push(request);
    return Promise.resolve(this.response);
  }
}

function claudeResponse(value: unknown): unknown {
  return {
    id: "msg_stage2_resume",
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function boundFixtures() {
  const parsedBase = SiteSnapshotSchema.parse(baseSnapshotFixture);
  const pages = parsedBase.pages.map((page) => {
    const actions = page.actions.map((action) => ({
      ...action,
      fingerprint: hashWebsiteActionFingerprint(action),
    }));
    const content = { ...page, actions };
    return { ...content, contentHash: hashPageSnapshotContent(content) };
  });
  const snapshot = SiteSnapshotSchema.parse({
    ...parsedBase,
    pages,
    contentHash: hashSiteSnapshotContent({ ...parsedBase, pages }),
  });
  const model = {
    ...baseProcedureModelFixture,
    sourceSnapshotHash: snapshot.contentHash,
  };
  const stages = stagedFixturesFromModel(model);
  const catalog = selectFocusedSources(snapshot, USER_GOAL);
  return { snapshot, catalog, stages };
}

function options(transport: ClaudeTransport) {
  return {
    transport,
    model: "claude-test-model",
    maxTokens: 8_192,
    evidenceContext: evidenceContextFixture,
    sourceArtifactLabel: "saved-stage1.json",
  } as const;
}

describe("saved Stage 1 procedure-mapping resume", () => {
  it.runIf(existsSync("artifacts/live-extraction-debug.json"))(
    "replays the locally saved Sonnet Stage 1 through preflight without a paid call",
    async () => {
      const artifact: unknown = JSON.parse(
        readFileSync("artifacts/live-extraction-debug.json", "utf8"),
      );
      if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
        throw new TypeError("Saved artifact root is invalid");
      }
      const events = Reflect.get(artifact, "debugEvents");
      if (!Array.isArray(events)) throw new TypeError("Saved artifact debugEvents are missing");
      const selection = [...events].reverse().find((event) => event?.kind === "source_selection")?.selection;
      const policy = [...events].reverse().find((event) => event?.kind === "policy_dto")?.policyDto;
      const transport = new FakeTransport(claudeResponse({}));

      const outcome = await resumeProcedureMapping(
        Reflect.get(artifact, "sourceSnapshot"),
        selection,
        policy,
        options(transport),
      );

      expect(transport.requests).toHaveLength(1);
      expect(outcome).toMatchObject({
        ok: false,
        code: "PROCEDURE_MAPPING_INVALID",
        attempts: 1,
      });
    },
  );

  it("revalidates a saved Stage 1 and makes only one Stage 2 request", async () => {
    const { snapshot, catalog, stages } = boundFixtures();
    const transport = new FakeTransport(claudeResponse(stages.mapping));

    const outcome = await resumeProcedureMapping(
      snapshot,
      catalog,
      stages.policy,
      options(transport),
    );

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.system).toContain("Stage 2 of a narrow procedure mapper");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.sourceSnapshotHash).toBe(snapshot.contentHash);
    expect(outcome.evidence.status).toBe("valid");
    expect(outcome.provenance).toEqual({
      stage1Source: "saved_artifact",
      policyAnalysisId: stages.policy.policyAnalysisId,
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      sourceArtifactLabel: "saved-stage1.json",
    });
  });

  it("rejects invalid saved Stage 1 before transport use", async () => {
    const { snapshot, catalog, stages } = boundFixtures();
    stages.policy.rules[0]!.appliesWhenConditionId = "condition_missing";
    const transport = new FakeTransport(claudeResponse(stages.mapping));

    const outcome = await resumeProcedureMapping(snapshot, catalog, stages.policy, options(transport));

    expect(outcome).toMatchObject({ ok: false, code: "POLICY_EXTRACTION_INVALID", attempts: 0 });
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects a snapshot hash mismatch before transport use", async () => {
    const { snapshot, catalog, stages } = boundFixtures();
    const transport = new FakeTransport(claudeResponse(stages.mapping));

    const outcome = await resumeProcedureMapping(
      { ...snapshot, contentHash: "snapshot_hash_tampered" },
      catalog,
      stages.policy,
      options(transport),
    );

    expect(outcome).toMatchObject({ ok: false, code: "INPUT_INVALID", attempts: 0 });
    expect(outcome.ok || outcome.issues.some((issue) => issue.includes("contentHash"))).toBe(true);
    expect(transport.requests).toHaveLength(0);
  });

  it("rejects wrong and missing focused-source bindings before transport use", async () => {
    const { snapshot, catalog, stages } = boundFixtures();
    const transport = new FakeTransport(claudeResponse(stages.mapping));
    const wrong = structuredClone(catalog);
    wrong.pages[0]!.title = "Wrong title";
    const wrongOutcome = await resumeProcedureMapping(snapshot, wrong, stages.policy, options(transport));
    expect(wrongOutcome).toMatchObject({ ok: false, code: "INPUT_INVALID", attempts: 0 });

    const missing = structuredClone(catalog);
    const citedBlockId = stages.policy.rules[0]!.citations[0]!.blockId;
    const page = missing.pages.find((candidate) =>
      candidate.blocks.some((block) => block.blockId === citedBlockId),
    );
    if (page === undefined) throw new TypeError("Fixture citation block is absent from catalog");
    page.blocks = page.blocks.filter((block) => block.blockId !== citedBlockId);
    missing.selectedCounts.blocks -= 1;
    const missingOutcome = await resumeProcedureMapping(
      snapshot,
      missing,
      stages.policy,
      options(transport),
    );
    expect(missingOutcome).toMatchObject({
      ok: false,
      code: "POLICY_EXTRACTION_INVALID",
      attempts: 0,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("fails closed on invalid Stage 2 without mutating saved Stage 1 inputs", async () => {
    const { snapshot, catalog, stages } = boundFixtures();
    const originalSnapshot = structuredClone(snapshot);
    const originalCatalog = structuredClone(catalog);
    const originalPolicy = structuredClone(stages.policy);
    const invalidMapping = { ...stages.mapping, sourceSnapshotHash: "wrong_hash" };
    const transport = new FakeTransport(claudeResponse(invalidMapping));

    const outcome = await resumeProcedureMapping(snapshot, catalog, stages.policy, options(transport));

    expect(outcome).toMatchObject({
      ok: false,
      code: "PROCEDURE_MAPPING_INVALID",
      attempts: 1,
    });
    expect(snapshot).toEqual(originalSnapshot);
    expect(catalog).toEqual(originalCatalog);
    expect(stages.policy).toEqual(originalPolicy);
  });
});
