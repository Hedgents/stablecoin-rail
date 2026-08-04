import assert from "node:assert/strict";
import test from "node:test";
import { RailClient, defineDestinationAction, defineFundingProvider } from "../dist/index.js";

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

const fundingOnlyIntent = {
  id: "intent-funding-only",
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

function provider(id, minimumOutput) {
  return defineFundingProvider({
    manifest: {
      id,
      name: id.toUpperCase(),
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    supports: () => true,
    quote: async () => ({
      id: `${id}-quote`,
      input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
      expectedOutput: { asset: solanaUsdc, amountBaseUnits: String(Number(minimumOutput) + 1000) },
      minimumOutput: { asset: solanaUsdc, amountBaseUnits: minimumOutput },
      fees: [],
      etaSeconds: 30,
      expiresAt,
      executionMode: "two-phase",
    }),
    prepare: async () => [
      {
        id: `${id}-step`,
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
    getStatus: async ({ reference }) => ({
      state: "completed",
      reference,
      destinationReference: { chainId: "solana:mainnet", txId: "solsig", submittedAt: checkedAt },
      received: null,
      detail: "settled",
      checkedAt,
    }),
  });
}

async function fundedFlow(client) {
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  return flow;
}

test("round-trips a pending funding flow", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client);
  const persisted = flow.serialize();
  assert.equal(persisted.version, 1);
  assert.equal(persisted.snapshot.phase, "funding-pending");

  const resumed = client.hydrateFlow(persisted);
  assert.equal(resumed.getSnapshot().phase, "funding-pending");
  assert.equal(resumed.getSnapshot().fundingReference.txId, "0xabc");

  const snapshot = await resumed.refreshFunding();
  assert.equal(snapshot.phase, "completed");
});

test("drops wallet steps on rehydrate", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  assert.equal(flow.getSnapshot().fundingSteps.length, 1);

  const resumed = client.hydrateFlow(flow.serialize());
  assert.deepEqual(resumed.getSnapshot().fundingSteps, []);
  assert.equal(resumed.getSnapshot().phase, "quote-ready");
});

test("degrades an unsigned flow to idle once the quote has expired", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  const persisted = flow.serialize();

  const later = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    now: () => NOW + 120_000,
  });
  assert.equal(later.hydrateFlow(persisted).getSnapshot().phase, "idle");
});

test("rejects an unknown persisted version", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client);
  const persisted = { ...flow.serialize(), version: 2 };
  assert.throws(
    () => client.hydrateFlow(persisted),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_PERSISTED_VERSION");
      return true;
    },
  );
});

test("rejects a snapshot whose funding provider is no longer registered", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client);
  const other = new RailClient({ fundingProviders: [provider("b", "99000000")], now });
  assert.throws(
    () => other.hydrateFlow(flow.serialize()),
    (error) => {
      assert.equal(error.code, "FUNDING_PLUGIN_NOT_FOUND");
      return true;
    },
  );
});

test("restores terminal phases untouched", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client);
  await flow.refreshFunding();
  assert.equal(client.hydrateFlow(flow.serialize()).getSnapshot().phase, "completed");
});

test("an idle snapshot rehydrates as idle", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const resumed = client.hydrateFlow(client.createFlow().serialize());
  assert.equal(resumed.getSnapshot().phase, "idle");
  assert.equal(resumed.getSnapshot().batch, null);
});

// Post-settlement phases: funding already settled on mainnet, so a restore
// must keep the funding evidence and rewind no further than destination-ready.

const outputAsset = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:metalMint11111111111111111111111111111111",
  symbol: "METAL",
  decimals: 6,
};

const actionIntent = {
  ...fundingOnlyIntent,
  id: "intent-with-action",
  action: { pluginId: "jupiter", params: {} },
};

const jupiter = defineDestinationAction({
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
      label: "Buy the asset",
      request: { namespace: "solana", chainId: "solana:mainnet", transactionBase64: "AQ==" },
    },
  ],
});

function actionClient() {
  return new RailClient({
    fundingProviders: [provider("a", "99000000")],
    destinationActions: [jupiter],
    now,
  });
}

async function settledActionFlow(client) {
  const flow = client.createFlow();
  await flow.quote(actionIntent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  await flow.refreshFunding();
  await flow.prepareAction();
  return flow;
}

test("awaiting-destination-signature restores as destination-ready with funding evidence intact", async () => {
  const client = actionClient();
  const flow = await settledActionFlow(client);
  assert.equal(flow.getSnapshot().phase, "awaiting-destination-signature");

  const resumed = client.hydrateFlow(flow.serialize());
  const snapshot = resumed.getSnapshot();
  assert.equal(snapshot.phase, "destination-ready");
  assert.equal(snapshot.fundingReference.txId, "0xabc");
  assert.equal(snapshot.fundingStatus.state, "completed");
  assert.deepEqual(snapshot.actionSteps, []);

  // The settled transfer must not be payable again...
  await assert.rejects(
    () => resumed.prepareFunding(),
    (error) => {
      assert.equal(error.code, "INVALID_FLOW_PHASE");
      return true;
    },
  );
  // ...while the unsigned action leg is simply prepared again.
  const prepared = await resumed.prepareAction();
  assert.equal(prepared.phase, "awaiting-destination-signature");
});

test("preparing-action restores as destination-ready, not idle", async () => {
  const client = actionClient();
  const flow = await settledActionFlow(client);
  const persisted = flow.serialize();
  persisted.snapshot = { ...persisted.snapshot, phase: "preparing-action" };

  const snapshot = client.hydrateFlow(persisted).getSnapshot();
  assert.equal(snapshot.phase, "destination-ready");
  assert.equal(snapshot.fundingReference.txId, "0xabc");
});

test("a failed quote() serializes and rehydrates as a fresh flow instead of being refused", async () => {
  const failing = defineFundingProvider({
    manifest: { id: "a", name: "A", version: "1.0.0", apiVersion: 1, kind: "funding-provider" },
    supports: () => true,
    quote: async () => {
      throw new Error("upstream down");
    },
    prepare: async () => [],
    getStatus: async () => {
      throw new Error("unused");
    },
  });
  const client = new RailClient({ fundingProviders: [failing], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  assert.equal(flow.getSnapshot().phase, "failed");
  assert.equal(flow.getSnapshot().batch, null);

  // A host persisting on every revision must be able to rehydrate this.
  const resumed = client.hydrateFlow(flow.serialize());
  assert.equal(resumed.getSnapshot().phase, "idle");
});

test("a no-quote snapshot claiming funding evidence is refused as corrupt", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client);
  const persisted = flow.serialize();
  persisted.snapshot = { ...persisted.snapshot, batch: null, selectedQuoteId: null };
  assert.throws(
    () => client.hydrateFlow(persisted),
    (error) => {
      assert.equal(error.code, "INVALID_PERSISTED_SNAPSHOT");
      return true;
    },
  );
});

test("preparing-funding degrades to quote-ready while the quote is fresh", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  const persisted = flow.serialize();
  persisted.snapshot = { ...persisted.snapshot, phase: "preparing-funding" };
  const snapshot = client.hydrateFlow(persisted).getSnapshot();
  assert.equal(snapshot.phase, "quote-ready");
  assert.ok(snapshot.batch);
});

test("a post-settlement snapshot without funding evidence is refused", async () => {
  const client = actionClient();
  const flow = await settledActionFlow(client);
  const persisted = flow.serialize();
  persisted.snapshot = { ...persisted.snapshot, fundingReference: null };

  assert.throws(
    () => client.hydrateFlow(persisted),
    (error) => {
      assert.equal(error.code, "INVALID_PERSISTED_SNAPSHOT");
      return true;
    },
  );
});
