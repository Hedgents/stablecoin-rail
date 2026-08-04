import assert from "node:assert/strict";
import test from "node:test";
import { RailClient, defineFundingProvider } from "@hedgents/stablecoin-rail";
import { rebuildFlow } from "../dist/useRailFlow.js";

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
  id: "react-rebuild-1",
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

function provider(id, { failQuote = false } = {}) {
  return defineFundingProvider({
    manifest: { id, name: id.toUpperCase(), version: "1.0.0", apiVersion: 1, kind: "funding-provider" },
    supports: () => true,
    quote: async () => {
      if (failQuote) throw new Error("upstream down");
      return {
        id: `${id}-quote`,
        input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
        expectedOutput: { asset: solanaUsdc, amountBaseUnits: "99001000" },
        minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
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

test("a client rebuild preserves an in-flight funding transfer and keeps its guards armed", async () => {
  const clientA = new RailClient({ fundingProviders: [provider("a")], now });
  const flow = clientA.createFlow();
  await flow.quote(intent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });

  const clientB = new RailClient({ fundingProviders: [provider("a")], now });
  const rebuilt = rebuildFlow(clientB, flow, null);
  const snapshot = rebuilt.getSnapshot();
  assert.equal(snapshot.phase, "funding-pending");
  assert.equal(snapshot.fundingReference.txId, "0xabc");
  // The double-submit guard survives: funding cannot be prepared again.
  await assert.rejects(
    () => rebuilt.prepareFunding(),
    (error) => {
      assert.equal(error.code, "INVALID_FLOW_PHASE");
      return true;
    },
  );
});

test("the live flow's state wins over the mount-time persisted blob", async () => {
  const clientA = new RailClient({ fundingProviders: [provider("a")], now });
  const staleBlob = clientA.createFlow().serialize(); // idle, from mount time

  const flow = clientA.createFlow();
  await flow.quote(intent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });

  const clientB = new RailClient({ fundingProviders: [provider("a")], now });
  const rebuilt = rebuildFlow(clientB, flow, staleBlob);
  assert.equal(rebuilt.getSnapshot().phase, "funding-pending");
});

test("a flow whose quote() failed rebuilds as a fresh flow instead of crashing", async () => {
  // The failed-quote snapshot has batch: null. Rebuilding must not throw
  // INVALID_PERSISTED_SNAPSHOT: with an unmemoized client, that throw would
  // repeat on every render and permanently crash the component.
  const clientA = new RailClient({ fundingProviders: [provider("a", { failQuote: true })], now });
  const flow = clientA.createFlow();
  await flow.quote(intent);
  assert.equal(flow.getSnapshot().phase, "failed");
  assert.equal(flow.getSnapshot().batch, null);

  const clientB = new RailClient({ fundingProviders: [provider("a")], now });
  const rebuilt = rebuildFlow(clientB, flow, null);
  assert.equal(rebuilt.getSnapshot().phase, "idle");
});

test("rebuilding onto a client that lost the provider fails closed", async () => {
  const clientA = new RailClient({ fundingProviders: [provider("a")], now });
  const flow = clientA.createFlow();
  await flow.quote(intent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });

  const clientB = new RailClient({ fundingProviders: [provider("b")], now });
  assert.throws(
    () => rebuildFlow(clientB, flow, null),
    (error) => {
      assert.equal(error.code, "FUNDING_PLUGIN_NOT_FOUND");
      return true;
    },
  );
});

test("with no live flow and no blob, a fresh flow is created", () => {
  const client = new RailClient({ fundingProviders: [provider("a")], now });
  assert.equal(rebuildFlow(client, null, null).getSnapshot().phase, "idle");
});
