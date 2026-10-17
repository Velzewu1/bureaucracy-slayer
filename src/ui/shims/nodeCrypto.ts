import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

type HashEncoding = "hex";

type BrowserHash = Readonly<{
  update(value: string, encoding?: "utf8"): BrowserHash;
  digest(encoding: HashEncoding): string;
}>;

/** UI-build adapter for the narrow synchronous Node crypto surface used by canonical hashing. */
export function createHash(algorithm: string): BrowserHash {
  if (algorithm !== "sha256") throw new TypeError(`Unsupported hash algorithm: ${algorithm}`);
  let input = "";
  const hash: BrowserHash = {
    update(value, encoding = "utf8") {
      if (encoding !== "utf8") throw new TypeError(`Unsupported text encoding: ${encoding}`);
      input += value;
      return hash;
    },
    digest(encoding) {
      if (encoding !== "hex") throw new TypeError(`Unsupported digest encoding: ${encoding}`);
      return bytesToHex(sha256(utf8ToBytes(input)));
    },
  };
  return hash;
}
