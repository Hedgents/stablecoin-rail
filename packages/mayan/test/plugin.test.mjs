import assert from "node:assert/strict";
import test from "node:test";
import {
  BNB_PEG_USDC,
  MAYAN_FORWARDER,
  SOLANA_USDC_MINT,
  createMayanBnbToSolana,
  encodeApprove,
  floorToBaseUnits,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const context = { now: () => NOW };
const RPC = "https://rpc.test";
const EXPLORER = "https://explorer.test";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIGNER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"ab".repeat(32)}`;
const EXPECTED_ATA = "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B";
const CALLDATA = `0x${"cd".repeat(200)}`;

const bnbUsdc = {
  chainId: "eip155:56",
  assetId: `eip155:56/erc20:${BNB_PEG_USDC.toLowerCase()}`,
  symbol: "USDC",
  decimals: 18,
};
const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: `solana:mainnet/spl:${SOLANA_USDC_MINT}`,
  symbol: "USDC",
  decimals: 6,
};

const intent = {
  id: "mayan-1",
  source: { account: { chainId: "eip155:56", address: SIGNER }, asset: bnbUsdc },
  destination: { account: { chainId: "solana:mainnet", address: WALLET }, settlementAsset: solanaUsdc },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

function quote(overrides = {}) {
  return {
    type: "SWIFT",
    effectiveAmountIn64: "100000000",
    expectedAmountOut: 99.5,
    minReceived: 99.1,
    etaSeconds: 42,
    toToken: { contract: SOLANA_USDC_MINT, decimals: 6, symbol: "USDC" },
    ...overrides,
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function build(opts = {}) {
  const sdk = {
    fetchQuote: async (params) => {
      opts.capture?.push(params);
      return opts.quotes ?? [quote()];
    },
    getSwapFromEvmTxPayload: async () =>
      opts.payload ?? { to: MAYAN_FORWARDER, data: CALLDATA, value: 0 },
  };
  return createMayanBnbToSolana({
    sdk,
    rpcUrl: RPC,
    explorerBaseUrl: EXPLORER,
    fetch: async (input) => {
      const url = String(input);
      if (url === RPC) {
        return "balance" in opts && opts.balance === null
          ? json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "could not find account" } })
          : json({ jsonrpc: "2.0", id: 1, result: { value: { amount: String(opts.balance ?? 0) } } });
      }
      if (url.includes("/v3/swap/trx/")) {
        return opts.swap === undefined ? json({ error: "nope" }, 404) : json(opts.swap);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });
}

async function quoteOf(plugin) {
  const draft = await plugin.quote(intent, context);
  assert.ok(draft, "expected a quote");
  return { ...draft, providerId: plugin.manifest.id, providerName: plugin.manifest.name };
}

test("floors human-readable amounts to base units", () => {
  // Must round DOWN: a minimum higher than guaranteed is unsafe.
  assert.equal(floorToBaseUnits(99.1234567, 6), 99_123_456n);
  assert.equal(floorToBaseUnits(0.0000019, 6), 1n);
  assert.equal(floorToBaseUnits(0.000001, 6), 1n);
  assert.equal(floorToBaseUnits(0, 6), 0n);
});

test("absorbs binary representation noise before truncating", () => {
  // 99.1 is not exactly representable and prints as 99.09999999999999.
  // Truncating the raw double would silently lose a base unit.
  assert.equal((99.1).toFixed(14), "99.09999999999999");
  assert.equal(floorToBaseUnits(99.1, 6), 99_100_000n);
  assert.equal(floorToBaseUnits(0.07, 6), 70_000n);
  assert.equal(floorToBaseUnits(1.005, 6), 1_005_000n);
});

test("rejects a non-finite amount rather than coercing it", () => {
  assert.throws(() => floorToBaseUnits(Number.NaN, 6));
  assert.throws(() => floorToBaseUnits(-1, 6));
});

test("supports the BNB Binance-Peg USDC route only", async () => {
  const plugin = build();
  assert.equal(await plugin.supports(intent), true);
  assert.equal(
    await plugin.supports({
      ...intent,
      source: {
        account: { chainId: "eip155:1", address: SIGNER },
        asset: { ...bnbUsdc, chainId: "eip155:1", assetId: "eip155:1/erc20:0xdead" },
      },
    }),
    false,
  );
  assert.equal(
    await plugin.supports({
      ...intent,
      source: { ...intent.source, asset: { ...bnbUsdc, assetId: "eip155:56/erc20:0xdead" } },
    }),
    false,
  );
});

test("names itself so no interface can present it as Circle CCTP", () => {
  assert.match(build().manifest.name, /Binance-Peg/);
});

test("quotes from the guaranteed minimum received", async () => {
  const draft = await build({ balance: 0 }).quote(intent, context);
  assert.equal(draft.minimumOutput.amountBaseUnits, "99100000");
  assert.equal(draft.expectedOutput.amountBaseUnits, "99500000");
  assert.equal(draft.etaSeconds, 42);
  assert.equal(draft.executionMode, "two-phase");
});

test("carries an explicit adapter disclosure and the derived account", async () => {
  const draft = await build({ balance: 0 }).quote(intent, context);
  assert.match(draft.opaqueData.disclosure, /not Circle CCTP/i);
  assert.match(draft.opaqueData.disclosure, /issued by Binance/i);
  assert.equal(draft.opaqueData.destinationTokenAccount, EXPECTED_ATA);
  assert.equal(draft.opaqueData.forwarder, MAYAN_FORWARDER);
  assert.equal(draft.opaqueData.routeType, "SWIFT");
});

test("asks Mayan for the exact route being quoted", async () => {
  const capture = [];
  await build({ balance: 0, capture }).quote(intent, context);
  assert.equal(capture[0].fromChain, "bsc");
  assert.equal(capture[0].toChain, "solana");
  assert.equal(capture[0].fromToken, BNB_PEG_USDC);
  assert.equal(capture[0].toToken, SOLANA_USDC_MINT);
  assert.equal(capture[0].amountIn64, "100000000");
  assert.equal(capture[0].destinationAddress, WALLET);
});

test("rejects a route that would land a different mint", async () => {
  const wrongMint = quote({ toToken: { contract: "So11111111111111111111111111111111111111112" } });
  assert.equal(await build({ balance: 0, quotes: [wrongMint] }).quote(intent, context), null);
});

test("rejects a quote whose input amount was changed", async () => {
  const changed = quote({ effectiveAmountIn64: "99999999" });
  assert.equal(await build({ balance: 0, quotes: [changed] }).quote(intent, context), null);
});

test("picks the route with the highest guaranteed minimum", async () => {
  const draft = await build({
    balance: 0,
    quotes: [quote({ minReceived: 98.0 }), quote({ type: "MCTP", minReceived: 99.4 })],
  }).quote(intent, context);
  assert.equal(draft.minimumOutput.amountBaseUnits, "99400000");
  assert.equal(draft.opaqueData.routeType, "MCTP");
});

test("prepares an exact approval and a forwarder call", async () => {
  const plugin = build({ balance: 0 });
  const steps = await plugin.prepare({ intent, quote: await quoteOf(plugin) }, context);
  assert.equal(steps.length, 2);
  const [approve, forward] = steps;

  assert.equal(approve.request.to, BNB_PEG_USDC);
  assert.equal(approve.request.data, encodeApprove(MAYAN_FORWARDER, 100_000_000n));
  assert.ok(!approve.request.data.includes("f".repeat(64)), "allowance must not be unlimited");
  assert.equal(approve.request.value, "0");

  assert.equal(forward.request.to, MAYAN_FORWARDER);
  assert.equal(forward.request.data, CALLDATA);
  assert.equal(forward.request.value, "0");
  assert.equal(forward.request.numericChainId, 56);
});

test("refuses a transaction aimed anywhere but the Mayan Forwarder", async () => {
  const plugin = build({
    balance: 0,
    payload: { to: "0x000000000000000000000000000000000000dEaD", data: CALLDATA, value: 0 },
  });
  const quoted = await quoteOf(plugin);
  await assert.rejects(
    () => plugin.prepare({ intent, quote: quoted }, context),
    (error) => {
      assert.equal(error.code, "UNEXPECTED_TARGET");
      return true;
    },
  );
});

test("refuses a transaction that would move native BNB", async () => {
  const plugin = build({
    balance: 0,
    payload: { to: MAYAN_FORWARDER, data: CALLDATA, value: "1000000000000000" },
  });
  const quoted = await quoteOf(plugin);
  await assert.rejects(
    () => plugin.prepare({ intent, quote: quoted }, context),
    (error) => {
      assert.equal(error.code, "UNEXPECTED_NATIVE_VALUE");
      return true;
    },
  );
});

test("refuses to prepare when the quote pins do not match", async () => {
  const plugin = build({ balance: 0 });
  const quoted = await quoteOf(plugin);
  quoted.opaqueData = { ...quoted.opaqueData, sourceAmount: "1" };
  await assert.rejects(
    () => plugin.prepare({ intent, quote: quoted }, context),
    (error) => {
      assert.equal(error.code, "QUOTE_PIN_MISMATCH");
      return true;
    },
  );
});

test("reports pending before Mayan indexes the swap", async () => {
  const plugin = build({ balance: 0 });
  const quoted = await quoteOf(plugin);
  const status = await plugin.getStatus(
    { intent, quote: quoted, reference: { chainId: "eip155:56", txId: TX, submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "pending");
});

test("detects a refund by status family", async () => {
  const plugin = build({ balance: 0, swap: { status: "REFUNDED_ON_EVM" } });
  const quoted = await quoteOf(plugin);
  const status = await plugin.getStatus(
    { intent, quote: quoted, reference: { chainId: "eip155:56", txId: TX, submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "refunded");
});

test("stays pending on an in-flight status until the balance actually moves", async () => {
  const plugin = build({ balance: 0, swap: { status: "SWAPPED_ON_EVM" } });
  const quoted = await quoteOf(plugin);
  const status = await plugin.getStatus(
    { intent, quote: quoted, reference: { chainId: "eip155:56", txId: TX, submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "pending");
});

test("completes only once the destination balance has risen by the minimum", async () => {
  let balance = 0;
  const sdk = {
    fetchQuote: async () => [quote()],
    getSwapFromEvmTxPayload: async () => ({ to: MAYAN_FORWARDER, data: CALLDATA, value: 0 }),
  };
  const plugin = createMayanBnbToSolana({
    sdk,
    rpcUrl: RPC,
    explorerBaseUrl: EXPLORER,
    fetch: async (input) => {
      const url = String(input);
      if (url === RPC) {
        return json({ jsonrpc: "2.0", id: 1, result: { value: { amount: String(balance) } } });
      }
      return json({ status: "SETTLED_ON_SOLANA" });
    },
  });
  const quoted = await quoteOf(plugin);
  balance = 99_100_000;
  const status = await plugin.getStatus(
    { intent, quote: quoted, reference: { chainId: "eip155:56", txId: TX, submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "completed");
  // No exact figure is claimed; the rail keeps its quoted-minimum fallback.
  assert.equal(status.received, null);
});

test("rejects a status reference from the wrong chain", async () => {
  const plugin = build({ balance: 0 });
  const quoted = await quoteOf(plugin);
  await assert.rejects(
    () =>
      plugin.getStatus(
        { intent, quote: quoted, reference: { chainId: "eip155:1", txId: TX, submittedAt: "" } },
        context,
      ),
    (error) => {
      assert.equal(error.code, "REFERENCE_CHAIN_MISMATCH");
      return true;
    },
  );
});
