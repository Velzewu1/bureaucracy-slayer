import { hashCanonical, type EvidenceResult } from "../../contracts/index.js";
import { validateEvidence } from "../../evidence/index.js";
import {
  auditSemanticQualifiers,
  type SemanticAuditResult,
} from "../../extractor/semantic-audit.js";
import {
  LiveExtractionArtifactSchema,
  type LiveExtractionArtifact,
} from "../../orchestration/live-extraction-contract.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../../shared/index.js";

export type LiveArtifactIntegrityErrorCode =
  | "ARTIFACT_SCHEMA_INVALID"
  | "BLOCK_HASH_MISMATCH"
  | "ACTION_FINGERPRINT_MISMATCH"
  | "PAGE_HASH_MISMATCH"
  | "SNAPSHOT_HASH_MISMATCH"
  | "SEMANTIC_AUDIT_MISMATCH"
  | "EVIDENCE_VALIDATION_FAILED"
  | "EVIDENCE_RESULT_MISMATCH";

export class LiveArtifactIntegrityError extends Error {
  readonly code: LiveArtifactIntegrityErrorCode;

  constructor(code: LiveArtifactIntegrityErrorCode, message: string) {
    super(message);
    this.name = "LiveArtifactIntegrityError";
    this.code = code;
  }
}

export type VerifiedLiveArtifact = Readonly<{
  artifact: LiveExtractionArtifact;
  evidence: EvidenceResult;
  semanticAudit: SemanticAuditResult;
}>;

function assertSnapshotHashes(artifact: LiveExtractionArtifact): void {
  for (const page of artifact.sourceSnapshot.pages) {
    for (const block of page.blocks) {
      if (block.textHash !== hashEvidenceBlockText(block.text)) {
        throw new LiveArtifactIntegrityError(
          "BLOCK_HASH_MISMATCH",
          `Live evidence block ${block.id} does not match its canonical text hash.`,
        );
      }
    }
    for (const action of page.actions) {
      if (action.fingerprint !== hashWebsiteActionFingerprint(action)) {
        throw new LiveArtifactIntegrityError(
          "ACTION_FINGERPRINT_MISMATCH",
          `Live website action ${action.id} does not match its canonical fingerprint.`,
        );
      }
    }
    if (page.contentHash !== hashPageSnapshotContent(page)) {
      throw new LiveArtifactIntegrityError(
        "PAGE_HASH_MISMATCH",
        `Live page ${page.id} does not match its canonical content hash.`,
      );
    }
  }
  if (artifact.sourceSnapshot.contentHash !== hashSiteSnapshotContent(artifact.sourceSnapshot)) {
    throw new LiveArtifactIntegrityError(
      "SNAPSHOT_HASH_MISMATCH",
      "The live snapshot does not match its canonical content hash.",
    );
  }
}

export function verifyLiveExtractionArtifact(input: unknown): VerifiedLiveArtifact {
  const parsed = LiveExtractionArtifactSchema.safeParse(input);
  if (!parsed.success) {
    throw new LiveArtifactIntegrityError(
      "ARTIFACT_SCHEMA_INVALID",
      "The live extraction result did not match the frozen artifact contract.",
    );
  }

  const artifact = parsed.data;
  assertSnapshotHashes(artifact);

  const semanticAudit = auditSemanticQualifiers(
    artifact.sourceSnapshot,
    artifact.procedureModel,
  );
  if (hashCanonical(semanticAudit) !== hashCanonical(artifact.semanticAudit)) {
    throw new LiveArtifactIntegrityError(
      "SEMANTIC_AUDIT_MISMATCH",
      "The locally recomputed semantic audit does not match the server result.",
    );
  }

  const validation = validateEvidence(
    artifact.sourceSnapshot,
    artifact.procedureModel,
    {
      evidenceResultId: artifact.evidence.id,
      checkedAt: artifact.evidence.checkedAt,
    },
    semanticAudit.findings.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
    })),
  );
  if (!validation.ok) {
    throw new LiveArtifactIntegrityError(
      "EVIDENCE_VALIDATION_FAILED",
      `The live artifacts failed local ${validation.stage} validation.`,
    );
  }
  if (hashCanonical(validation.evidence) !== hashCanonical(artifact.evidence)) {
    throw new LiveArtifactIntegrityError(
      "EVIDENCE_RESULT_MISMATCH",
      "The locally recomputed evidence result does not match the server result.",
    );
  }

  return {
    artifact,
    evidence: validation.evidence,
    semanticAudit,
  };
}
