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

function provider(id, minimumOutput, statusOverrides = {}) {
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
      ...statusOverrides,
    }),
  });
}

function verifier(amountBaseUnits, calls = []) {
  return {
    verify: async ({ status }) => {
      calls.push(status.reference.txId);
      return amountBaseUnits === null ? null : { asset: solanaUsdc, amountBaseUnits };
    },
  };
}

async function statusFor(client) {
  const batch = await client.quote(fundingOnlyIntent);
  return client.getFundingStatus(batch.quotes[0], {
    chainId: "eip155:1",
    txId: "0xabc",
    submittedAt: checkedAt,
  });
}

test("splices a verified amount into the funding status", async () => {
  const calls = [];
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: verifier("99500000", calls),
    now,
  });
  const status = await statusFor(client);
  assert.equal(status.received.amountBaseUnits, "99500000");
  assert.deepEqual(calls, ["0xabc"]);
});

test("rejects a delivery below the guaranteed minimum", async () => {
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: verifier("98000000"),
    now,
  });
  await assert.rejects(
    () => statusFor(client),
    (error) => {
      assert.equal(error.code, "SETTLEMENT_BELOW_MINIMUM");
      return true;
    },
  );
});

test("rejects a verified amount in another asset", async () => {
  const foreign = { ...solanaUsdc, assetId: "solana:mainnet/spl:OtherMint", symbol: "USDT" };
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: { verify: async () => ({ asset: foreign, amountBaseUnits: "99500000" }) },
    now,
  });
  await assert.rejects(
    () => statusFor(client),
    (error) => {
      assert.equal(error.code, "SETTLEMENT_ASSET_MISMATCH");
      return true;
    },
  );
});

test("a null verification preserves the quoted-minimum fallback", async () => {
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: verifier(null),
    now,
  });
  const status = await statusFor(client);
  assert.equal(status.received, null);
});

test("does not verify while funding is still pending", async () => {
  const calls = [];
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000", { state: "pending" })],
    settlementVerifier: verifier("99500000", calls),
    now,
  });
  const status = await statusFor(client);
  assert.equal(status.state, "pending");
  assert.deepEqual(calls, []);
});

test("does not verify without destination delivery evidence", async () => {
  const calls = [];
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000", { destinationReference: null })],
    settlementVerifier: verifier("99500000", calls),
    now,
  });
  const status = await statusFor(client);
  assert.equal(status.received, null);
  assert.deepEqual(calls, []);
});

test("does not second-guess a provider that already reported an amount", async () => {
  const calls = [];
  const client = new RailClient({
    fundingProviders: [
      provider("a", "99000000", {
        received: { asset: solanaUsdc, amountBaseUnits: "99400000" },
      }),
    ],
    settlementVerifier: verifier("99500000", calls),
    now,
  });
  const status = await statusFor(client);
  assert.equal(status.received.amountBaseUnits, "99400000");
  assert.deepEqual(calls, []);
});
