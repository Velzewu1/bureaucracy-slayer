import { pathToFileURL } from "node:url";

import { createLiveFailedStatusFixture } from "../tests/integration/live-extraction/contract-fixtures.js";
import { startLiveMockApi } from "../tests/integration/live-extraction/mock-api.js";

const DEFAULT_MOCK_API_PORT = 5_190;

export function resolveMockApiPort(value = process.env["BUREAUCRACY_SLAYER_MOCK_API_PORT"]): number {
  if (value === undefined || value === "") return DEFAULT_MOCK_API_PORT;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("BUREAUCRACY_SLAYER_MOCK_API_PORT must be a decimal TCP port.");
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("BUREAUCRACY_SLAYER_MOCK_API_PORT must be between 1 and 65535.");
  }
  return port;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.some((argument) => argument !== "--failed")) {
    throw new Error("Unsupported offline mock API option.");
  }
  const failed = args.includes("--failed");
  const api = await startLiveMockApi({
    port: resolveMockApiPort(),
    ...(failed
      ? { timeline: [createLiveFailedStatusFixture()] }
      : { goalAware: true }),
  });
  process.stdout.write(`Offline Live Extraction mock listening on ${api.origin}\n`);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void api.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch(() => {
    process.stderr.write("Offline Live Extraction mock failed to start.\n");
    process.exitCode = 1;
  });
}
