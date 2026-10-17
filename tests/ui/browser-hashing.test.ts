import { describe, expect, it } from "vitest";

import { createHash } from "../../src/ui/shims/nodeCrypto.js";

describe("UI browser hashing adapter", () => {
  it("matches the standard SHA-256 UTF-8 digest", () => {
    expect(createHash("sha256").update("abc", "utf8").digest("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("rejects unsupported algorithms instead of changing hash semantics", () => {
    expect(() => createHash("sha1")).toThrow("Unsupported hash algorithm");
  });
});
