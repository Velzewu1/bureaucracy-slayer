import { createHash } from "node:crypto";

export function normalizeEvidenceText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function hashText(value: string): string {
  return createHash("sha256").update(normalizeEvidenceText(value)).digest("hex");
}

