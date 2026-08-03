import assert from "node:assert/strict";
import test from "node:test";
import { fundingProviderConformance } from "@hedgents/stablecoin-rail/testing";
import {
  ROBINHOOD_USDG,
  ROBINHOOD_USDG_ADDRESS,
  SOLANA_USDG,
  SOLANA_USDG_MINT,
  createLayerZeroUsdgRobinhoodToSolana,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const context = { now };
const QUOTE_ID = `0x${"1".repeat(64)}`;
const SIGNER = "0x1111111111111111111111111111111111111111";
const DESTINATION = "HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN";
const OFT = "0x2222222222222222222222222222222222222222";
const CALLDATA = `0x${"ab".repeat(120)}`;

const intent = {
  id: "usdg-1",
  source: { account: { chainId: "eip155:4663", address: SIGNER }, asset: ROBINHOOD_USDG },
  destination: {
    account: { chainId: "solana:mainnet", address: DESTINATION },
    settlementAsset: SOLANA_USDG,
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

const ethereumIntent = {
  ...intent,
  id: "usdg-ethereum",
  source: {
    account: { chainId: "eip155:1", address: SIGNER },
    asset: { ...ROBINHOOD_USDG, chainId: "eip155:1", assetId: "eip155:1/erc20:0xdead" },
  },
};

function json(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

const QUOTES = {
  quotes: [
    {
      id: `0x${"3".repeat(64)}`,
      // A swap would change the stablecoin underneath the user; must be skipped.
      routeSteps: [{ type: "SWAP", srcChainKey: "robinhood" }],
      duration: { estimated: "5000" },
      expiresAt: String(NOW + 60_000),
      srcAmount: "100000000",
      dstAmount: "100000000",
      dstAmountMin: "99990000",
    },
    {
      id: QUOTE_ID,
      routeSteps: [{ type: "OFT_V2", srcChainKey: "robinhood" }],
      duration: { estimated: "12000" },
      feeUsd: "0.02",
      expiresAt: String(NOW + 60_000),
      srcAmount: "100000000",
      dstAmount: "99900000",
      dstAmountMin: "99800000",
    },
  ],
};

function userSteps(overrides = {}) {
  return {
    userSteps: [
      {
        type: "TRANSACTION",
        description: "Send USDG to Solana",
        chainKey: "robinhood",
        chainType: "EVM",
        signerAddress: SIGNER,
        transaction: { encoded: { to: OFT, data: CALLDATA, value: "0", ...overrides } },
      },
    ],
  };
}

function build(opts = {}) {
  return createLayerZeroUsdgRobinhoodToSolana({
    apiKey: "test-key",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/quotes")) return json(opts.quotes ?? QUOTES);
      if (path.endsWith("/build-user-steps")) return json(opts.steps ?? userSteps());
      return json(opts.status ?? { status: "PENDING", executionHistory: [] });
    },
  });
}

async function quoteOf(plugin) {
  const draft = await plugin.quote(intent, context);
  assert.ok(draft, "expected a quote");
  return { ...draft, providerId: plugin.manifest.id, providerName: plugin.manifest.name };
}

test("pins canonical Robinhood and Solana USDG", () => {
  assert.equal(ROBINHOOD_USDG_ADDRESS, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(SOLANA_USDG_MINT, "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH");
  assert.equal(ROBINHOOD_USDG.decimals, 6);
  assert.equal(SOLANA_USDG.decimals, 6);
});

test("supports the Robinhood USDG route only", async () => {
  const plugin = build();
  assert.equal(await plugin.supports(intent), true);
  assert.equal(await plugin.supports(ethereumIntent), false);
  assert.equal(
    await plugin.supports({
      ...intent,
      source: { ...intent.source, asset: { ...ROBINHOOD_USDG, assetId: "eip155:4663/erc20:0xdead" } },
    }),
    false,
  );
});

test("skips a swap route and quotes the guaranteed minimum", async () => {
  const draft = await build().quote(intent, context);
  // The SWAP-bearing quote must be discarded even though its minimum is higher.
  assert.equal(draft.id, QUOTE_ID);
  assert.equal(draft.minimumOutput.amountBaseUnits, "99800000");
  assert.equal(draft.expectedOutput.amountBaseUnits, "99900000");
  assert.equal(draft.etaSeconds, 12);
  assert.equal(draft.executionMode, "two-phase");
  assert.equal(draft.opaqueData.sourceChainKey, "robinhood");
});

test("maps the EVM step to a zero-value wallet request", async () => {
  const plugin = build();
  const steps = await plugin.prepare({ intent, quote: await quoteOf(plugin) }, context);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].request.namespace, "evm");
  assert.equal(steps[0].request.chainId, "eip155:4663");
  assert.equal(steps[0].request.numericChainId, 4663);
  assert.equal(steps[0].request.to, OFT);
  assert.equal(steps[0].request.data, CALLDATA);
  assert.equal(steps[0].request.value, "0");
});

test("refuses a step that would send native currency", async () => {
  const plugin = build({ steps: userSteps({ value: "1000000000000000" }) });
  const quote = await quoteOf(plugin);
  await assert.rejects(
    () => plugin.prepare({ intent, quote }, context),
    (error) => {
      assert.equal(error.code, "UNEXPECTED_NATIVE_VALUE");
      return true;
    },
  );
});

test("refuses a malformed EVM target or calldata", async () => {
  for (const [override, code] of [
    [{ to: "0xnope" }, "INVALID_EVM_TRANSACTION"],
    [{ data: "0x1" }, "INVALID_EVM_TRANSACTION"],
  ]) {
    const plugin = build({ steps: userSteps(override) });
    const quote = await quoteOf(plugin);
    await assert.rejects(
      () => plugin.prepare({ intent, quote }, context),
      (error) => {
        assert.equal(error.code, code);
        return true;
      },
    );
  }
});

test("fails closed when LayerZero changes the signer", async () => {
  const steps = userSteps();
  steps.userSteps[0].signerAddress = "0x9999999999999999999999999999999999999999";
  const plugin = build({ steps });
  const quote = await quoteOf(plugin);
  await assert.rejects(
    () => plugin.prepare({ intent, quote }, context),
    (error) => {
      assert.equal(error.code, "SIGNER_MISMATCH");
      return true;
    },
  );
});

test("refuses to prepare when the quote pins do not match", async () => {
  const plugin = build();
  const quote = await quoteOf(plugin);
  quote.opaqueData = { ...quote.opaqueData, sourceAmount: "1" };
  await assert.rejects(
    () => plugin.prepare({ intent, quote }, context),
    (error) => {
      assert.equal(error.code, "QUOTE_PIN_MISMATCH");
      return true;
    },
  );
});

test("only completes with Solana delivery evidence", async () => {
  const reference = { chainId: "eip155:4663", txId: "0xabc", submittedAt: "" };

  const succeededOnly = build({ status: { status: "SUCCEEDED", executionHistory: [] } });
  const pending = await succeededOnly.getStatus(
    { intent, quote: await quoteOf(succeededOnly), reference },
    context,
  );
  assert.equal(pending.state, "pending");

  const delivered = build({
    status: {
      status: "SUCCEEDED",
      executionHistory: [
        { event: "DELIVERED", transaction: { chainKey: "solana", hash: "solsig", timestamp: 1785790000 } },
      ],
    },
  });
  const done = await delivered.getStatus(
    { intent, quote: await quoteOf(delivered), reference },
    context,
  );
  assert.equal(done.state, "completed");
  assert.equal(done.destinationReference.txId, "solsig");
  assert.equal(done.received, null);
});

test("detects a refund", async () => {
  const plugin = build({
    status: {
      status: "PENDING",
      executionHistory: [{ event: "REFUNDED", transaction: { chainKey: "robinhood", hash: "0xdef" } }],
    },
  });
  const status = await plugin.getStatus(
    { intent, quote: await quoteOf(plugin), reference: { chainId: "eip155:4663", txId: "0xabc", submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "refunded");
});

for (const item of fundingProviderConformance({
  plugin: build(),
  supportedIntent: intent,
  unsupportedIntent: ethereumIntent,
  now,
})) {
  test(`USDG adapter: ${item.name}`, async () => {
    await item.run();
  });
}
