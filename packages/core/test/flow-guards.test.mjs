import assert from "node:assert/strict";
import test from "node:test";
import { RailClient, defineFundingProvider } from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const expiresAt = new Date(NOW + 60_000).toISOString();
const checkedAt = new Date(NOW).toISOString();

const ethereumUsdc = {
  chainId: "eip155:1",
  assetId: "eip155:1/erc20:0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  symbol: "USDC",
  decimals: 6,
};
const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "USDC",
  decimals: 6,
};

const intent = {
  id: "intent-guards",
  source: {
    account: { chainId: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    asset: ethereumUsdc,
  },
  destination: {
    account: { chainId: "solana:mainnet", address: "DestinationWallet111111111111111111111111111" },
    settlementAsset: solanaUsdc,
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

/** A provider whose getStatus works through a queue of behaviors, one per poll. */
function provider(statusQueue) {
  return defineFundingProvider({
    manifest: {
      id: "queued",
      name: "QUEUED",
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    supports: () => true,
    quote: async () => ({
      id: "queued-quote",
      input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
      expectedOutput: { asset: solanaUsdc, amountBaseUnits: "99001000" },
      minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
      fees: [],
      etaSeconds: 30,
      expiresAt,
      executionMode: "two-phase",
    }),
    prepare: async () => [
      {
        id: "queued-step",
        kind: "funding",
        chainId: "eip155:1",
        label: "Fund",
        request: {
          namespace: "evm",
          chainId: "eip155:1",
          numericChainId: 1,
          to: "0x2222222222222222222222222222222222222222",
          data: "0x",
          value: "0",
        },
      },
    ],
    getStatus: async ({ reference }) => {
      const behavior = statusQueue.shift();
      if (!behavior) throw new Error("status queue exhausted");
      if (behavior.throw) throw behavior.throw;
      return {
        state: behavior.state,
        reference,
        destinationReference:
          behavior.state === "completed"
            ? { chainId: "solana:mainnet", txId: "solsig", submittedAt: checkedAt }
            : null,
        received: behavior.received ?? null,
        detail: behavior.detail ?? "status",
        checkedAt,
      };
    },
  });
}

async function pendingFlow(client) {
  const flow = client.createFlow();
  await flow.quote(intent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  return flow;
}

test("a transient status-poll error keeps the flow pollable instead of failing it", async () => {
  const queue = [{ throw: new Error("ETIMEDOUT") }, { state: "completed" }];
  const client = new RailClient({ fundingProviders: [provider(queue)], now });
  const flow = await pendingFlow(client);

  const afterError = await flow.refreshFunding();
  assert.equal(afterError.phase, "funding-pending");
  assert.equal(afterError.error.code, "PLUGIN_ERROR");
  assert.equal(afterError.fundingReference.txId, "0xabc");

  // The same flow, polled again once the upstream recovers, completes.
  const afterRecovery = await flow.refreshFunding();
  assert.equal(afterRecovery.phase, "completed");
  assert.equal(afterRecovery.error, null);
});

test("a transient action-poll error keeps action-pending pollable", async () => {
  const { RailClient: Client, defineDestinationAction } = await import("../dist/index.js");
  const outputAsset = {
    chainId: "solana:mainnet",
    assetId: "solana:mainnet/spl:metalMint11111111111111111111111111111111",
    symbol: "METAL",
    decimals: 6,
  };
  const actionStatusQueue = [
    { throw: new Error("ETIMEDOUT") },
    { state: "completed" },
  ];
  const jupiter = defineDestinationAction({
    manifest: { id: "jupiter", name: "Jupiter", version: "1.0.0", apiVersion: 1, kind: "destination-action" },
    supports: () => true,
    quote: async ({ fundingQuote }) => ({
      id: `jupiter-${fundingQuote.providerId}`,
      input: fundingQuote.minimumOutput,
      expectedOutput: { asset: outputAsset, amountBaseUnits: fundingQuote.minimumOutput.amountBaseUnits },
      minimumOutput: {
        asset: outputAsset,
        amountBaseUnits: (BigInt(fundingQuote.minimumOutput.amountBaseUnits) - 100n).toString(),
      },
      fees: [],
      expiresAt,
    }),
    prepare: async () => [
      {
        id: "jupiter-swap",
        kind: "destination-action",
        chainId: "solana:mainnet",
        label: "Buy",
        request: { namespace: "solana", chainId: "solana:mainnet", transactionBase64: "AQ==" },
      },
    ],
    getStatus: async ({ reference, actionQuote }) => {
      const behavior = actionStatusQueue.shift();
      if (behavior.throw) throw behavior.throw;
      return {
        state: behavior.state,
        reference,
        received: actionQuote.minimumOutput,
        detail: "done",
        checkedAt,
      };
    },
  });
  const client = new Client({
    fundingProviders: [provider([{ state: "completed" }])],
    destinationActions: [jupiter],
    now,
  });
  const flow = client.createFlow();
  await flow.quote({ ...intent, id: "intent-action", action: { pluginId: "jupiter", params: {} } });
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  await flow.refreshFunding();
  await flow.prepareAction();
  flow.markActionSubmitted({ chainId: "solana:mainnet", txId: "actsig", submittedAt: checkedAt });

  const afterError = await flow.refreshAction();
  assert.equal(afterError.phase, "action-pending");
  assert.equal(afterError.error.code, "PLUGIN_ERROR");

  const afterRecovery = await flow.refreshAction();
  assert.equal(afterRecovery.phase, "completed");
  assert.equal(afterRecovery.error, null);
});

test("a provider-asserted failure is still terminal", async () => {
  const queue = [{ state: "failed", detail: "burn reverted" }];
  const client = new RailClient({ fundingProviders: [provider(queue)], now });
  const flow = await pendingFlow(client);
  const snapshot = await flow.refreshFunding();
  assert.equal(snapshot.phase, "failed");
  assert.equal(snapshot.error.code, "FUNDING_FAILED");
});

test("a self-reported settled amount below the guaranteed minimum hard-stops the flow", async () => {
  const queue = [
    {
      state: "completed",
      received: { asset: solanaUsdc, amountBaseUnits: "1" },
      detail: "settled short",
    },
  ];
  const client = new RailClient({ fundingProviders: [provider(queue)], now });
  const flow = await pendingFlow(client);
  const snapshot = await flow.refreshFunding();
  // Below-minimum is an affirmative verification failure, not transport
  // trouble, so it is one of the few poll outcomes allowed to be terminal.
  assert.equal(snapshot.phase, "failed");
  assert.equal(snapshot.error.code, "SETTLEMENT_BELOW_MINIMUM");
});

test("getFundingStatus rejects a provider self-report below the minimum", async () => {
  const queue = [
    { state: "completed", received: { asset: solanaUsdc, amountBaseUnits: "98999999" } },
  ];
  const client = new RailClient({ fundingProviders: [provider(queue)], now });
  const batch = await client.quote(intent);
  await assert.rejects(
    () =>
      client.getFundingStatus(batch.quotes[0], {
        chainId: "eip155:1",
        txId: "0xabc",
        submittedAt: checkedAt,
      }),
    (error) => {
      assert.equal(error.code, "SETTLEMENT_BELOW_MINIMUM");
      return true;
    },
  );
});

test("getFundingStatus accepts a self-report at exactly the minimum", async () => {
  const queue = [
    { state: "completed", received: { asset: solanaUsdc, amountBaseUnits: "99000000" } },
  ];
  const client = new RailClient({ fundingProviders: [provider(queue)], now });
  const batch = await client.quote(intent);
  const status = await client.getFundingStatus(batch.quotes[0], {
    chainId: "eip155:1",
    txId: "0xabc",
    submittedAt: checkedAt,
  });
  assert.equal(status.state, "completed");
  assert.equal(status.received.amountBaseUnits, "99000000");
});

test("quote() refuses to erase an in-flight transfer", async () => {
  const client = new RailClient({ fundingProviders: [provider([])], now });
  const flow = await pendingFlow(client);
  await assert.rejects(
    () => flow.quote(intent),
    (error) => {
      assert.equal(error.code, "INVALID_FLOW_PHASE");
      return true;
    },
  );
  // The funding record survived the refused re-quote.
  assert.equal(flow.getSnapshot().phase, "funding-pending");
  assert.equal(flow.getSnapshot().fundingReference.txId, "0xabc");
});

test("quote() still works from terminal phases and after reset()", async () => {
  const queue = [{ state: "completed" }];
  const client = new RailClient({ fundingProviders: [provider(queue)], now });
  const flow = await pendingFlow(client);
  await flow.refreshFunding();
  assert.equal(flow.getSnapshot().phase, "completed");

  const requoted = await flow.quote(intent);
  assert.equal(requoted.phase, "quote-ready");

  flow.reset();
  const afterReset = await flow.quote(intent);
  assert.equal(afterReset.phase, "quote-ready");
});
