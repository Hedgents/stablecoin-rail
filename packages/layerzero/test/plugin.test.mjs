import assert from "node:assert/strict";
import test from "node:test";
import {
  SOLANA_USDT,
  TRON_USDT,
  createLayerZeroUsdt0TronToSolana,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const QUOTE_ID = `0x${"1".repeat(64)}`;
const SOURCE = "TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt";
const DESTINATION = "HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN";
const OWNER_HEX = "41f17a2e2dc0d6b58375f75bd02cb3b5e2e7f67822";

const intent = {
  id: "tron-usdt-1",
  source: {
    account: { chainId: "tron:mainnet", address: SOURCE },
    asset: TRON_USDT,
  },
  destination: {
    account: { chainId: "solana:mainnet", address: DESTINATION },
    settlementAsset: SOLANA_USDT,
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
  action: { pluginId: "jupiter" },
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function quoteResponse() {
  return {
    quotes: [
      {
        id: `0x${"3".repeat(64)}`,
        routeSteps: [{ type: "SWAP", srcChainKey: "tron" }],
        duration: { estimated: "10000" },
        expiresAt: String(NOW + 60_000),
        srcAmount: "100000000",
        dstAmount: "100000000",
        dstAmountMin: "99900000",
      },
      {
        id: `0x${"2".repeat(64)}`,
        routeSteps: [{ type: "OFT_V2_MULTIHOP", srcChainKey: "tron" }],
        duration: { estimated: "30000" },
        feeUsd: "0.20",
        feePercent: "0.20",
        expiresAt: String(NOW + 60_000),
        srcAmount: "100000000",
        dstAmount: "99600000",
        dstAmountMin: "99500000",
      },
      {
        id: QUOTE_ID,
        routeSteps: [{ type: "OFT_V2_MULTIHOP", srcChainKey: "tron" }],
        duration: { estimated: "45000" },
        feeUsd: "0.10",
        feePercent: "0.10",
        expiresAt: String(NOW + 60_000),
        srcAmount: "100000000",
        dstAmount: "99800000",
        dstAmountMin: "99700000",
      },
    ],
  };
}

test("pins canonical TRON and Solana USDT in the LayerZero quote request", async () => {
  const calls = [];
  const plugin = createLayerZeroUsdt0TronToSolana({
    apiKey: "test-key",
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return json(quoteResponse());
    },
  });

  assert.equal(await plugin.supports(intent), true);
  assert.equal(
    await plugin.supports({
      ...intent,
      source: { ...intent.source, asset: { ...TRON_USDT, assetId: "fake" } },
    }),
    false,
  );

  const quote = await plugin.quote(intent, { now: () => NOW });
  assert.equal(quote.id, QUOTE_ID);
  assert.equal(quote.minimumOutput.amountBaseUnits, "99700000");
  assert.equal(quote.etaSeconds, 45);

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.srcChainKey, "tron");
  assert.equal(body.srcTokenAddress, "0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C");
  assert.equal(body.srcWalletAddress, SOURCE);
  assert.equal(body.dstChainKey, "solana");
  assert.equal(body.dstTokenAddress, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
  assert.equal(body.dstWalletAddress, DESTINATION);
  assert.equal(body.options.dstNativeDropAmount, "0");
});

test("maps a fresh LayerZero TRON transaction to a typed wallet request", async () => {
  const calls = [];
  const plugin = createLayerZeroUsdt0TronToSolana({
    apiKey: "test-key",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith("/quotes")) return json(quoteResponse());
      if (path.endsWith("/build-user-steps")) {
        return json({
          userSteps: [
            {
              type: "TRANSACTION",
              description: "Bridge USDT to Solana",
              chainKey: "tron",
              chainType: "TRON",
              signerAddress: SOURCE,
              transaction: {
                encoded: {
                  visible: false,
                  txID: "a".repeat(64),
                  raw_data: {
                    contract: [
                      {
                        type: "TriggerSmartContract",
                        parameter: {
                          value: {
                            owner_address: OWNER_HEX,
                            contract_address: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
                            call_value: 0,
                            data: "a9059cbb",
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected path ${path}`);
    },
    validateTronTransaction: ({ transaction }) => {
      assert.equal(
        transaction.raw_data.contract[0].parameter.value.contract_address,
        "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
      );
    },
  });
  const draft = await plugin.quote(intent, { now: () => NOW });
  const quote = {
    ...draft,
    providerId: plugin.manifest.id,
    providerName: plugin.manifest.name,
  };
  const steps = await plugin.prepare({ intent, quote }, { now: () => NOW });

  assert.deepEqual(calls, ["/v1/quotes", "/v1/build-user-steps"]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].request.namespace, "tron");
  assert.equal(steps[0].request.signerAddress, SOURCE);
  assert.equal(steps[0].request.transaction.raw_data.contract[0].type, "TriggerSmartContract");
});

test("fails closed when LayerZero changes the TRON signer", async () => {
  const plugin = createLayerZeroUsdt0TronToSolana({
    apiKey: "test-key",
    validateTronTransaction: () => {},
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/quotes")) return json(quoteResponse());
      return json({
        userSteps: [
          {
            type: "TRANSACTION",
            chainKey: "tron",
            chainType: "TRON",
            signerAddress: "TV3nb5HYFe2xBEmyb3ETe93UGkjAhWyzrs",
            transaction: {
              encoded: {
                raw_data: {
                  contract: [
                    {
                      type: "TriggerSmartContract",
                      parameter: { value: { owner_address: OWNER_HEX, call_value: 0 } },
                    },
                  ],
                },
              },
            },
          },
        ],
      });
    },
  });
  const draft = await plugin.quote(intent, { now: () => NOW });
  const quote = {
    ...draft,
    providerId: plugin.manifest.id,
    providerName: plugin.manifest.name,
  };

  await assert.rejects(
    () => plugin.prepare({ intent, quote }, { now: () => NOW }),
    (error) => error.code === "SIGNER_MISMATCH",
  );
});

test("refuses to prepare a TRON transaction without a host allowlist policy", async () => {
  const plugin = createLayerZeroUsdt0TronToSolana({
    apiKey: "test-key",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/quotes")) return json(quoteResponse());
      return json({
        userSteps: [
          {
            type: "TRANSACTION",
            chainKey: "tron",
            chainType: "TRON",
            signerAddress: SOURCE,
            transaction: {
              encoded: {
                raw_data: {
                  contract: [
                    {
                      type: "TriggerSmartContract",
                      parameter: { value: { owner_address: OWNER_HEX, call_value: 0 } },
                    },
                  ],
                },
              },
            },
          },
        ],
      });
    },
  });
  const draft = await plugin.quote(intent, { now: () => NOW });
  const quote = {
    ...draft,
    providerId: plugin.manifest.id,
    providerName: plugin.manifest.name,
  };

  await assert.rejects(
    () => plugin.prepare({ intent, quote }, { now: () => NOW }),
    (error) => error.code === "TRANSACTION_POLICY_REQUIRED",
  );
});

test("only reports completion from a successful status with Solana delivery evidence", async () => {
  const plugin = createLayerZeroUsdt0TronToSolana({
    apiKey: "test-key",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/quotes")) return json(quoteResponse());
      if (path.includes("/status/")) {
        return json({
          status: "SUCCEEDED",
          executionHistory: [
            {
              event: "DELIVERED",
              transaction: {
                chainKey: "solana",
                hash: "solana-delivery-signature",
                timestamp: NOW,
              },
            },
          ],
        });
      }
      throw new Error(`Unexpected path ${path}`);
    },
  });
  const draft = await plugin.quote(intent, { now: () => NOW });
  const quote = {
    ...draft,
    providerId: plugin.manifest.id,
    providerName: plugin.manifest.name,
  };
  const reference = {
    chainId: "tron:mainnet",
    txId: "b".repeat(64),
    submittedAt: new Date(NOW).toISOString(),
  };
  const status = await plugin.getStatus({ intent, quote, reference }, { now: () => NOW });

  assert.equal(status.state, "completed");
  assert.equal(status.received, null, "the API does not prove the exact amount received");
  assert.equal(status.destinationReference.chainId, "solana:mainnet");
  assert.equal(status.destinationReference.txId, "solana-delivery-signature");
});

test("keeps a provider success pending until Solana delivery evidence is indexed", async () => {
  const plugin = createLayerZeroUsdt0TronToSolana({
    apiKey: "test-key",
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/quotes")) return json(quoteResponse());
      return json({ status: "SUCCEEDED", executionHistory: [] });
    },
  });
  const draft = await plugin.quote(intent, { now: () => NOW });
  const quote = {
    ...draft,
    providerId: plugin.manifest.id,
    providerName: plugin.manifest.name,
  };
  const reference = {
    chainId: "tron:mainnet",
    txId: "c".repeat(64),
    submittedAt: new Date(NOW).toISOString(),
  };
  const status = await plugin.getStatus({ intent, quote, reference }, { now: () => NOW });

  assert.equal(status.state, "pending");
  assert.equal(status.destinationReference, null);
});
