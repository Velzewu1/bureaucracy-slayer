import { pathToFileURL } from "node:url";

import { createLiveFailedStatusFixture } from "../tests/integration/live-extraction/contract-fixtures.js";
import { startLiveMockApi } from "../tests/integration/live-extraction/mock-api.js";

const MOCK_API_PORT = 5_190;

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.some((argument) => argument !== "--failed")) {
    throw new Error("Unsupported offline mock API option.");
  }
  const failed = args.includes("--failed");
  const api = await startLiveMockApi({
    port: MOCK_API_PORT,
    ...(failed ? { timeline: [createLiveFailedStatusFixture()] } : {}),
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
