import assert from "node:assert/strict";
import test from "node:test";
import { defineDestinationAction, defineFundingProvider } from "../dist/index.js";
import {
  destinationActionConformance,
  fundingProviderConformance,
} from "../dist/testing/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const expiresAt = new Date(NOW + 60_000).toISOString();

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
const foreignSettlement = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:ForeignMint1111111111111111111111111111111",
  symbol: "USDT",
  decimals: 6,
};
const metal = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:metalMint11111111111111111111111111111111",
  symbol: "METAL",
  decimals: 6,
};

const supportedIntent = {
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
};

const unsupportedIntent = {
  ...supportedIntent,
  id: "intent-unsupported",
  source: {
    account: { chainId: "eip155:999", address: "0x3333333333333333333333333333333333333333" },
    asset: { ...ethereumUsdc, chainId: "eip155:999", assetId: "eip155:999/erc20:0xdead" },
  },
};

const serves = (intent) => intent.source.account.chainId === "eip155:1";

function provider(id, minimumOutput, overrides = {}) {
  return defineFundingProvider({
    manifest: {
      id,
      name: id.toUpperCase(),
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    supports: serves,
    quote: async (intent) => {
      if (!serves(intent)) return null;
      return {
        id: `${id}-quote`,
        input: { asset: ethereumUsdc, amountBaseUnits: intent.inputAmountBaseUnits },
        expectedOutput: { asset: solanaUsdc, amountBaseUnits: String(Number(minimumOutput) + 1000) },
        minimumOutput: { asset: solanaUsdc, amountBaseUnits: minimumOutput },
        fees: [],
        etaSeconds: 30,
        expiresAt,
        executionMode: "two-phase",
      };
    },
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
    getStatus: async ({ reference }) => {
      if (reference.chainId !== "eip155:1") throw new Error("wrong chain");
      return {
        state: "pending",
        reference,
        destinationReference: null,
        received: null,
        detail: "moving",
        checkedAt: new Date(NOW).toISOString(),
      };
    },
    ...overrides,
  });
}

function fundingQuoteFor(asset) {
  return {
    id: "funding-quote",
    providerId: "a",
    providerName: "A",
    input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
    expectedOutput: { asset, amountBaseUnits: "99500000" },
    minimumOutput: { asset, amountBaseUnits: "99000000" },
    fees: [],
    etaSeconds: 30,
    expiresAt,
    executionMode: "two-phase",
  };
}

function action() {
  return defineDestinationAction({
    manifest: {
      id: "jupiter",
      name: "Jupiter",
      version: "1.0.0",
      apiVersion: 1,
      kind: "destination-action",
    },
    supports: ({ fundingQuote }) => fundingQuote.minimumOutput.asset.assetId === solanaUsdc.assetId,
    quote: async ({ fundingQuote }) => ({
      id: "action-quote",
      input: fundingQuote.minimumOutput,
      expectedOutput: { asset: metal, amountBaseUnits: "31000" },
      minimumOutput: { asset: metal, amountBaseUnits: "30800" },
      fees: [],
      expiresAt,
    }),
    prepare: async () => [
      {
        id: "action-step",
        kind: "destination-action",
        chainId: "solana:mainnet",
        label: "Buy",
        request: {
          namespace: "solana",
          chainId: "solana:mainnet",
          transactionBase64: "AAAA".repeat(30),
        },
      },
    ],
  });
}

test("a well-formed provider passes every case", async () => {
  const cases = fundingProviderConformance({
    plugin: provider("a", "99000000"),
    supportedIntent,
    unsupportedIntent,
    now,
  });
  assert.ok(cases.length >= 5);
  for (const item of cases) await item.run();
});

test("a provider that changes the input amount fails a case", async () => {
  const broken = provider("broken", "99000000", {
    quote: async () => ({
      id: "broken-quote",
      input: { asset: ethereumUsdc, amountBaseUnits: "1" },
      expectedOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
      minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
      fees: [],
      etaSeconds: 30,
      expiresAt,
      executionMode: "two-phase",
    }),
  });
  const results = await Promise.allSettled(
    fundingProviderConformance({ plugin: broken, supportedIntent, unsupportedIntent, now }).map(
      (item) => item.run(),
    ),
  );
  assert.ok(results.some((result) => result.status === "rejected"));
});

test("a provider that claims to support a foreign intent fails a case", async () => {
  const greedy = provider("greedy", "99000000", { supports: () => true });
  const results = await Promise.allSettled(
    fundingProviderConformance({ plugin: greedy, supportedIntent, unsupportedIntent, now }).map(
      (item) => item.run(),
    ),
  );
  assert.ok(results.some((result) => result.status === "rejected"));
});

test("a provider that accepts a foreign status reference fails a case", async () => {
  const sloppy = provider("sloppy", "99000000", {
    getStatus: async ({ reference }) => ({
      state: "pending",
      reference,
      destinationReference: null,
      received: null,
      detail: "moving",
      checkedAt: new Date(NOW).toISOString(),
    }),
  });
  const results = await Promise.allSettled(
    fundingProviderConformance({ plugin: sloppy, supportedIntent, unsupportedIntent, now }).map(
      (item) => item.run(),
    ),
  );
  assert.ok(results.some((result) => result.status === "rejected"));
});

test("a well-formed destination action passes every case", async () => {
  const cases = destinationActionConformance({
    plugin: action(),
    intent: { ...supportedIntent, action: { pluginId: "jupiter" } },
    fundingQuote: fundingQuoteFor(solanaUsdc),
    unsupportedFundingQuote: fundingQuoteFor(foreignSettlement),
    now,
  });
  assert.ok(cases.length >= 4);
  for (const item of cases) await item.run();
});

test("an action quoted from optimistic output fails a case", async () => {
  const optimistic = defineDestinationAction({
    ...action(),
    quote: async ({ fundingQuote }) => ({
      id: "action-quote",
      // Sized from expectedOutput rather than the guaranteed minimum.
      input: fundingQuote.expectedOutput,
      expectedOutput: { asset: metal, amountBaseUnits: "31000" },
      minimumOutput: { asset: metal, amountBaseUnits: "30800" },
      fees: [],
      expiresAt,
    }),
  });
  const results = await Promise.allSettled(
    destinationActionConformance({
      plugin: optimistic,
      intent: { ...supportedIntent, action: { pluginId: "jupiter" } },
      fundingQuote: fundingQuoteFor(solanaUsdc),
      unsupportedFundingQuote: fundingQuoteFor(foreignSettlement),
      now,
    }).map((item) => item.run()),
  );
  assert.ok(results.some((result) => result.status === "rejected"));
});
