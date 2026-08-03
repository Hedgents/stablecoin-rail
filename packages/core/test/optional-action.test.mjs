import assert from "node:assert/strict";
import test from "node:test";
import { RailClient, RailError, defineFundingProvider } from "../dist/index.js";

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

test("quotes a funding-only intent with no destination actions registered", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const batch = await client.quote(fundingOnlyIntent);
  assert.equal(batch.quotes.length, 1);
  assert.equal(batch.quotes[0].action, null);
  assert.equal(batch.quotes[0].id, "a:a-quote");
  assert.equal(batch.quotes[0].expiresAt, expiresAt);
});

test("ranks funding-only quotes by guaranteed settlement output", async () => {
  const client = new RailClient({
    fundingProviders: [provider("low", "98000000"), provider("high", "99500000")],
    now,
  });
  const batch = await client.quote(fundingOnlyIntent);
  assert.equal(batch.quotes.length, 2);
  assert.equal(batch.quotes[0].funding.providerId, "high");
});

test("a funding-only flow completes without a destination action", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  const snapshot = await flow.refreshFunding();
  assert.equal(snapshot.phase, "completed");
});

test("action entry points reject a funding-only flow", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await assert.rejects(
    () => flow.prepareAction(),
    (error) => {
      assert.ok(error instanceof RailError);
      assert.equal(error.code, "ACTION_NOT_CONFIGURED");
      return true;
    },
  );
});

test("an intent naming an unregistered action still fails loudly", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  await assert.rejects(
    () => client.quote({ ...fundingOnlyIntent, action: { pluginId: "missing" } }),
    (error) => {
      assert.equal(error.code, "ACTION_PLUGIN_NOT_FOUND");
      return true;
    },
  );
});
