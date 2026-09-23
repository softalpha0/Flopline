import { describe, expect } from "bun:test";
import { test } from "@chainlink/cre-sdk/test";
import { initWorkflow } from "./main";
import type { Config } from "./main";

const config: Config = {
  schedule: "0 */1 * * * *",
  chainName: "monad-testnet",
  receiverAddress: "0x0000000000000000000000000000000000000000",
  gasLimit: "300000",
  sources: [{ name: "feed-a", url: "http://localhost:8787/feed/a", path: "h100.usd_per_hour" }],
  markets: [{ sku: "H100-USEAST-DRYRUN", premiumBps: 0 }],
};

describe("initWorkflow", () => {
  test("registers one cron handler with the configured schedule", async () => {
    const handlers = initWorkflow(config);
    expect(handlers).toBeArray();
    expect(handlers).toHaveLength(1);
    expect(handlers[0].trigger.config.schedule).toBe(config.schedule);
  });
});
