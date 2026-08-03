import test from "node:test";
import { fundingProviderConformance } from "@hedgents/stablecoin-rail/testing";
import { SOLANA_USDT, TRON_USDT, createLayerZeroUsdt0TronToSolana } from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const QUOTE_ID = `0x${"1".repeat(64)}`;
const SOURCE = "TFG4wBaDQ8sHWWP1ACeSGnoNR6RRzevLPt";
const DESTINATION = "HyXJcgYpURfDhgzuyRL7zxP4FhLg7LZQMeDrR4MXZcMN";
const OWNER_HEX = "41f17a2e2dc0d6b58375f75bd02cb3b5e2e7f67822";

const tronIntent = {
  id: "tron-usdt-conformance",
  source: { account: { chainId: "tron:mainnet", address: SOURCE }, asset: TRON_USDT },
  destination: {
    account: { chainId: "solana:mainnet", address: DESTINATION },
    settlementAsset: SOLANA_USDT,
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

// Same route, but sourced from Ethereum USDT. The adapter must decline it.
const ethereumIntent = {
  ...tronIntent,
  id: "ethereum-usdt-conformance",
  source: {
    account: { chainId: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    asset: {
      chainId: "eip155:1",
      assetId: "eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
    },
  },
};

function json(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

const QUOTES = {
  quotes: [
    {
      id: QUOTE_ID,
      routeSteps: [{ type: "OFT_V2_MULTIHOP", srcChainKey: "tron" }],
      duration: { estimated: "45000" },
      feeUsd: "0.10",
      feePercent: "0.10",
      // Must outlive NOW, or the quote contract case fails on expiry rather
      // than on the behaviour under test.
      expiresAt: String(NOW + 60_000),
      srcAmount: "100000000",
      dstAmount: "99800000",
      dstAmountMin: "99700000",
    },
  ],
};

const USER_STEPS = {
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
};

const STATUS = { status: "PENDING", executionHistory: [] };

const plugin = createLayerZeroUsdt0TronToSolana({
  apiKey: "test-key",
  fetch: async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/quotes")) return json(QUOTES);
    if (path.endsWith("/build-user-steps")) return json(USER_STEPS);
    return json(STATUS);
  },
  // A permissive policy is correct for a contract test and must never ship.
  // Production preparation fails closed without a real USDT0 allowlist.
  validateTronTransaction: async () => {},
});

for (const item of fundingProviderConformance({
  plugin,
  supportedIntent: tronIntent,
  unsupportedIntent: ethereumIntent,
  now,
})) {
  test(`USDT0 adapter: ${item.name}`, async () => {
    await item.run();
  });
}
