import test from "node:test";
import { fundingProviderConformance } from "@hedgents/stablecoin-rail/testing";
import { ETHEREUM_MAINNET, SOLANA_MAINNET, createCctpToSolana } from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const RPC = "https://rpc.test";
const API = "https://iris.test";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const supportedIntent = {
  id: "cctp-conformance",
  source: {
    account: { chainId: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    asset: {
      chainId: "eip155:1",
      assetId: `eip155:1/erc20:${ETHEREUM_MAINNET.usdcAddress.toLowerCase()}`,
      symbol: "USDC",
      decimals: 6,
    },
  },
  destination: {
    account: { chainId: "solana:mainnet", address: WALLET },
    settlementAsset: {
      chainId: "solana:mainnet",
      assetId: `solana:mainnet/spl:${SOLANA_MAINNET.usdcMint}`,
      symbol: "USDC",
      decimals: 6,
    },
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

// BNB Chain's common USDC is Binance-Peg, not a CCTP source asset. This
// package must decline it so it can never be mislabelled as native CCTP.
const bnbIntent = {
  ...supportedIntent,
  id: "bnb-conformance",
  source: {
    account: { chainId: "eip155:56", address: "0x1111111111111111111111111111111111111111" },
    asset: {
      chainId: "eip155:56",
      assetId: "eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      symbol: "USDC",
      decimals: 18,
    },
  },
};

function json(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

const plugin = createCctpToSolana({
  sources: [ETHEREUM_MAINNET],
  solana: SOLANA_MAINNET,
  rpcUrl: RPC,
  apiBaseUrl: API,
  fetch: async (input) => {
    const url = String(input);
    if (url === RPC) {
      return json({ jsonrpc: "2.0", id: 1, result: { value: { amount: "5000000", decimals: 6 } } });
    }
    if (url.includes("/v2/burn/")) {
      return json([
        {
          finalityThreshold: 1000,
          minimumFee: 1,
          forwardFee: { low: "1100000", med: "1200000", high: "1300000" },
        },
      ]);
    }
    return json({ messages: [] });
  },
});

for (const item of fundingProviderConformance({
  plugin,
  supportedIntent,
  unsupportedIntent: bnbIntent,
  now,
})) {
  test(`CCTP provider: ${item.name}`, async () => {
    await item.run();
  });
}
