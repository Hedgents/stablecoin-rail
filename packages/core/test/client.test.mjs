import assert from "node:assert/strict";
import test from "node:test";
import {
  RailClient,
  RailError,
  defineDestinationAction,
  defineFundingProvider,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
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
const outputAsset = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:metalMint11111111111111111111111111111111",
  symbol: "METAL",
  decimals: 6,
};

const intent = {
  id: "intent-1",
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
  action: { pluginId: "jupiter", params: { outputMint: outputAsset.assetId } },
};

function provider(id, minimumOutput, options = {}) {
  return defineFundingProvider({
    manifest: {
      id,
      name: id.toUpperCase(),
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    supports: () => true,
    quote: async () => {
      if (options.quoteError) throw new Error(options.quoteError);
      return {
        id: `${id}-quote`,
        input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
        expectedOutput: { asset: solanaUsdc, amountBaseUnits: String(Number(minimumOutput) + 1000) },
        minimumOutput: { asset: solanaUsdc, amountBaseUnits: minimumOutput },
        fees: [],
        etaSeconds: options.etaSeconds ?? 30,
        expiresAt,
        executionMode: "two-phase",
      };
    },
    prepare: async () => [
      {
        id: `${id}-fund`,
        kind: "funding",
        chainId: "eip155:1",
        label: "Fund Solana",
        request: {
          namespace: "evm",
          chainId: "eip155:1",
          numericChainId: 1,
          to: "0x2222222222222222222222222222222222222222",
          data: "0x1234",
          value: "0",
        },
      },
    ],
    getStatus: async ({ reference }) => ({
      state: "completed",
      reference,
      destinationReference: {
        chainId: "solana:mainnet",
        txId: "solana-funding-signature",
        submittedAt: checkedAt,
      },
      received: { asset: solanaUsdc, amountBaseUnits: minimumOutput },
      detail: "USDC arrived on Solana.",
      checkedAt,
    }),
  });
}

const action = defineDestinationAction({
  manifest: {
    id: "jupiter",
    name: "Jupiter",
    version: "1.0.0",
    apiVersion: 1,
    kind: "destination-action",
  },
  supports: () => true,
  quote: async ({ fundingQuote }) => ({
    id: `jupiter-${fundingQuote.providerId}`,
    input: fundingQuote.minimumOutput,
    expectedOutput: {
      asset: outputAsset,
      amountBaseUnits: fundingQuote.minimumOutput.amountBaseUnits,
    },
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
      label: "Buy the asset",
      request: {
        namespace: "solana",
        chainId: "solana:mainnet",
        transactionBase64: "AQ==",
      },
    },
  ],
  getStatus: async ({ reference, actionQuote }) => ({
    state: "completed",
    reference,
    received: actionQuote.minimumOutput,
    detail: "The destination action finalized.",
    checkedAt,
  }),
});

test("ranks complete routes by guaranteed destination output", async () => {
  const client = new RailClient({
    fundingProviders: [provider("slower", "99000000", { etaSeconds: 60 }), provider("best", "99500000")],
    destinationActions: [action],
    now: () => NOW,
  });
  const batch = await client.quote(intent);

  assert.equal(batch.quotes.length, 2);
  assert.equal(batch.quotes[0].funding.providerId, "best");
  assert.equal(batch.quotes[0].action.minimumOutput.amountBaseUnits, "99499900");
  assert.equal(batch.failures.length, 0);
});

test("keeps valid routes when another provider fails", async () => {
  const client = new RailClient({
    fundingProviders: [provider("broken", "99000000", { quoteError: "temporarily unavailable" }), provider("good", "99100000")],
    destinationActions: [action],
    now: () => NOW,
  });
  const batch = await client.quote(intent);

  assert.equal(batch.quotes.length, 1);
  assert.equal(batch.quotes[0].funding.providerId, "good");
  assert.deepEqual(batch.failures[0], {
    pluginId: "broken",
    stage: "funding-quote",
    code: "PLUGIN_ERROR",
    message: "temporarily unavailable",
  });
});

test("rejects duplicate plugin IDs", () => {
  assert.throws(
    () =>
      new RailClient({
        fundingProviders: [provider("same", "99000000"), provider("same", "99100000")],
        destinationActions: [action],
      }),
    (error) => error instanceof RailError && error.code === "DUPLICATE_PLUGIN",
  );
});

test("runs a two-signature flow and refreshes the destination quote", async () => {
  let actionQuoteCalls = 0;
  const refreshingAction = {
    ...action,
    quote: async (...args) => {
      actionQuoteCalls += 1;
      return action.quote(...args);
    },
  };
  const client = new RailClient({
    fundingProviders: [provider("cctp", "99500000")],
    destinationActions: [refreshingAction],
    now: () => NOW,
  });
  const flow = client.createFlow();

  await flow.quote(intent);
  assert.equal(flow.getSnapshot().phase, "quote-ready");

  await flow.prepareFunding();
  assert.equal(flow.getSnapshot().phase, "awaiting-source-signature");

  flow.markFundingSubmitted({
    chainId: "eip155:1",
    txId: "0xsource",
    submittedAt: checkedAt,
  });
  await flow.refreshFunding();
  assert.equal(flow.getSnapshot().phase, "destination-ready");

  await flow.prepareAction();
  assert.equal(flow.getSnapshot().phase, "awaiting-destination-signature");
  assert.equal(actionQuoteCalls, 2, "the destination action is refreshed after settlement");

  flow.markActionSubmitted({
    chainId: "solana:mainnet",
    txId: "solana-action-signature",
    submittedAt: checkedAt,
  });
  await flow.refreshAction();
  assert.equal(flow.getSnapshot().phase, "completed");
  assert.equal(flow.getSnapshot().actionStatus.received.asset.symbol, "METAL");
});

test("fails closed when the action is quoted from optimistic funding output", async () => {
  const unsafeAction = defineDestinationAction({
    ...action,
    manifest: { ...action.manifest, id: "unsafe" },
    quote: async ({ fundingQuote }) => ({
      id: "unsafe-quote",
      input: fundingQuote.expectedOutput,
      expectedOutput: { asset: outputAsset, amountBaseUnits: "99000000" },
      minimumOutput: { asset: outputAsset, amountBaseUnits: "98000000" },
      fees: [],
      expiresAt,
    }),
  });
  const unsafeIntent = { ...intent, action: { pluginId: "unsafe" } };
  const client = new RailClient({
    fundingProviders: [provider("cctp", "99500000")],
    destinationActions: [unsafeAction],
    now: () => NOW,
  });
  const batch = await client.quote(unsafeIntent);

  assert.equal(batch.quotes.length, 0);
  assert.equal(batch.failures[0].code, "QUOTE_AMOUNT_MISMATCH");
});
