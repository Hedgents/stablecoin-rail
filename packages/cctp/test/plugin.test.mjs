import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_MAINNET,
  ETHEREUM_MAINNET,
  MONAD_MAINNET,
  SOLANA_MAINNET,
  createCctpToSolana,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const context = { now: () => NOW };
const RPC = "https://rpc.test";
const API = "https://iris.test";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TX = `0x${"ab".repeat(32)}`;
// deriveAssociatedTokenAddress(WALLET, USDC mint), pinned in the -solana suite.
const EXPECTED_ATA = "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B";

const ethereumUsdc = {
  chainId: "eip155:1",
  assetId: `eip155:1/erc20:${ETHEREUM_MAINNET.usdcAddress.toLowerCase()}`,
  symbol: "USDC",
  decimals: 6,
};
const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: `solana:mainnet/spl:${SOLANA_MAINNET.usdcMint}`,
  symbol: "USDC",
  decimals: 6,
};

const intent = {
  id: "cctp-1",
  source: {
    account: { chainId: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    asset: ethereumUsdc,
  },
  destination: {
    account: { chainId: "solana:mainnet", address: WALLET },
    settlementAsset: solanaUsdc,
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

const SCHEDULE = [
  {
    finalityThreshold: 1000,
    minimumFee: 1,
    forwardFee: { low: "1100000", med: "1200000", high: "1300000" },
  },
];

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * @param opts.balance      null to simulate a missing token account
 * @param opts.messages     Circle status payload, or 404 when undefined
 * @param opts.calls        collects request URLs
 */
function client(opts = {}) {
  const calls = opts.calls ?? [];
  return createCctpToSolana({
    sources: [ETHEREUM_MAINNET, BASE_MAINNET],
    solana: SOLANA_MAINNET,
    rpcUrl: RPC,
    apiBaseUrl: API,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === RPC) {
        const body = JSON.parse(init.body);
        assert.equal(body.method, "getTokenAccountBalance");
        return "balance" in opts && opts.balance === null
          ? json({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "could not find account" } })
          : json({
              jsonrpc: "2.0",
              id: 1,
              result: { value: { amount: String(opts.balance ?? 0), decimals: 6 } },
            });
      }
      if (url.includes("/v2/burn/")) return json(opts.schedule ?? SCHEDULE);
      if (url.includes("/v2/messages/")) {
        return opts.messages === undefined
          ? json({ error: "not found" }, 404)
          : json({ messages: opts.messages });
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

test("supports an Ethereum USDC to Solana USDC intent", async () => {
  assert.equal(await client().supports(intent), true);
});

test("declines unconfigured chains, foreign assets, and non-Solana destinations", async () => {
  const plugin = client();
  // BNB is not a CCTP source; its common USDC is Binance-Peg.
  assert.equal(
    await plugin.supports({
      ...intent,
      source: {
        account: { chainId: "eip155:56", address: intent.source.account.address },
        asset: { ...ethereumUsdc, chainId: "eip155:56", assetId: "eip155:56/erc20:0xdead" },
      },
    }),
    false,
  );
  assert.equal(
    await plugin.supports({
      ...intent,
      source: { ...intent.source, asset: { ...ethereumUsdc, assetId: "eip155:1/erc20:0xdead" } },
    }),
    false,
  );
  assert.equal(
    await plugin.supports({
      ...intent,
      destination: { ...intent.destination, settlementAsset: { ...solanaUsdc, assetId: "solana:mainnet/spl:Other" } },
    }),
    false,
  );
});

test("quotes minimum output as amount minus forwarding and protocol fees", async () => {
  const draft = await client({ balance: 5_000_000 }).quote(intent, context);
  // 1bp of 100 USDC is 10000, plus a 1.2 USDC forward fee.
  assert.equal(draft.minimumOutput.amountBaseUnits, String(100_000_000 - 1_200_000 - 10_000));
  assert.equal(draft.executionMode, "two-phase");
  assert.deepEqual(
    draft.fees.map((fee) => [fee.type, fee.amount.amountBaseUnits]),
    [
      ["forwarding", "1200000"],
      ["provider", "10000"],
    ],
  );
});

test("requests recipient setup only when the token account is missing", async () => {
  const missing = [];
  await client({ balance: null, calls: missing }).quote(intent, context);
  assert.ok(missing.some((url) => url.includes("includeRecipientSetup=true")));

  const present = [];
  await client({ balance: 5_000_000, calls: present }).quote(intent, context);
  assert.ok(!present.some((url) => url.includes("includeRecipientSetup")));
});

test("derives the destination token account and pins full disclosure", async () => {
  const draft = await client({ balance: 5_000_000 }).quote(intent, context);
  const data = draft.opaqueData;
  assert.equal(data.destinationTokenAccount, EXPECTED_ATA);
  assert.equal(data.destinationWallet, WALLET);
  assert.equal(data.sourceDomain, 0);
  assert.equal(data.destinationDomain, 5);
  assert.equal(data.tokenMessengerV2, ETHEREUM_MAINNET.tokenMessengerV2);
  assert.equal(data.maxFee, "1210000");
  assert.equal(data.forwardFee, "1200000");
  assert.equal(data.protocolFee, "10000");
  assert.equal(data.finalityThreshold, 1000);
  assert.equal(data.recipientSetupIncluded, false);
  assert.equal(data.baselineBaseUnits, "5000000");
  assert.match(data.mintRecipient, /^0x[0-9a-f]{64}$/);
  assert.equal(data.hookData.length, 2 + 130);
});

test("refuses an amount that does not clear the fees", async () => {
  await assert.rejects(
    () => client({ balance: 0 }).quote({ ...intent, inputAmountBaseUnits: "1500000" }, context),
    (error) => {
      assert.equal(error.code, "AMOUNT_BELOW_FEES");
      return true;
    },
  );
});

test("prepares an exact approval and the burn, never an unlimited allowance", async () => {
  const plugin = client({ balance: 5_000_000 });
  const steps = await plugin.prepare({ intent, quote: await quoteOf(plugin) }, context);

  assert.equal(steps.length, 2);
  const [approve, burn] = steps;

  assert.equal(approve.kind, "approval");
  assert.equal(approve.request.to, ETHEREUM_MAINNET.usdcAddress);
  assert.equal(approve.request.value, "0");
  assert.equal(approve.request.numericChainId, 1);
  assert.equal(approve.request.chainId, "eip155:1");
  assert.equal(approve.request.data.slice(0, 10), "0x095ea7b3");
  // Exactly the input amount, and specifically not 2^256-1.
  assert.ok(approve.request.data.endsWith("05f5e100"));
  assert.ok(!approve.request.data.includes("f".repeat(64)));

  assert.equal(burn.kind, "funding");
  assert.equal(burn.request.to, ETHEREUM_MAINNET.tokenMessengerV2);
  assert.equal(burn.request.value, "0");
});

test("refuses to prepare when the quote pins do not match the intent", async () => {
  const plugin = client({ balance: 5_000_000 });
  const quote = await quoteOf(plugin);
  quote.opaqueData = { ...quote.opaqueData, destinationWallet: "7VHUFJHWu2CuExkJcJrzhQPJ2oygupTWkL2A2For4BmE" };
  await assert.rejects(
    () => plugin.prepare({ intent, quote }, context),
    (error) => {
      assert.equal(error.code, "QUOTE_PIN_MISMATCH");
      return true;
    },
  );
});

test("reports pending while Circle has not indexed the burn", async () => {
  const plugin = client({ balance: 5_000_000 });
  const quote = await quoteOf(plugin);
  const status = await plugin.getStatus(
    { intent, quote, reference: { chainId: "eip155:1", txId: TX, submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "pending");
  assert.equal(status.received, null);
});

test("stays pending while attested but not yet delivered", async () => {
  const plugin = client({
    balance: 5_000_000,
    messages: [{ status: "complete", attestation: `0x${"cd".repeat(32)}` }],
  });
  const quote = await quoteOf(plugin);
  const status = await plugin.getStatus(
    { intent, quote, reference: { chainId: "eip155:1", txId: TX, submittedAt: "" } },
    context,
  );
  // Attestation means signed, not delivered. The balance has not moved.
  assert.equal(status.state, "pending");
  assert.match(status.detail, /not delivered/);
});

test("completes only once the destination balance has actually increased", async () => {
  let balance = 5_000_000;
  const plugin = createCctpToSolana({
    sources: [ETHEREUM_MAINNET],
    solana: SOLANA_MAINNET,
    rpcUrl: RPC,
    apiBaseUrl: API,
    fetch: async (input) => {
      const url = String(input);
      if (url === RPC) {
        return json({ jsonrpc: "2.0", id: 1, result: { value: { amount: String(balance), decimals: 6 } } });
      }
      if (url.includes("/v2/burn/")) return json(SCHEDULE);
      return json({ messages: [{ status: "complete", attestation: `0x${"cd".repeat(32)}` }] });
    },
  });
  const quote = await quoteOf(plugin);
  balance = 5_000_000 + 98_790_000; // exactly the guaranteed minimum
  const status = await plugin.getStatus(
    { intent, quote, reference: { chainId: "eip155:1", txId: TX, submittedAt: "" } },
    context,
  );
  assert.equal(status.state, "completed");
});

test("rejects a status reference from the wrong chain", async () => {
  const plugin = client({ balance: 5_000_000 });
  const quote = await quoteOf(plugin);
  await assert.rejects(
    () =>
      plugin.getStatus(
        { intent, quote, reference: { chainId: "eip155:8453", txId: TX, submittedAt: "" } },
        context,
      ),
    (error) => {
      assert.equal(error.code, "REFERENCE_CHAIN_MISMATCH");
      return true;
    },
  );
});

test("rejects a mis-checksummed configured address at construction", () => {
  assert.throws(
    () =>
      createCctpToSolana({
        sources: [{ ...ETHEREUM_MAINNET, usdcAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48" }],
        solana: SOLANA_MAINNET,
        rpcUrl: RPC,
      }),
    /EIP-55/,
  );
});

test("Monad is configured as CCTP domain 15", () => {
  assert.equal(MONAD_MAINNET.cctpDomain, 15);
  assert.equal(MONAD_MAINNET.numericChainId, 143);
  assert.equal(MONAD_MAINNET.chainId, "eip155:143");
  assert.equal(MONAD_MAINNET.tokenMessengerV2, ETHEREUM_MAINNET.tokenMessengerV2);
  // Circle's native USDC on Monad, EIP-55 checksummed. A bad checksum would be
  // rejected at construction, which is the point of validating there.
  assert.equal(MONAD_MAINNET.usdcAddress, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
});

test("Base is configured and shares the TokenMessenger address", () => {
  assert.equal(BASE_MAINNET.cctpDomain, 6);
  assert.equal(BASE_MAINNET.numericChainId, 8453);
  assert.equal(BASE_MAINNET.tokenMessengerV2, ETHEREUM_MAINNET.tokenMessengerV2);
});
