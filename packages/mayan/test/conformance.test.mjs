import test from "node:test";
import { fundingProviderConformance } from "@hedgents/stablecoin-rail/testing";
import { BNB_PEG_USDC, MAYAN_FORWARDER, SOLANA_USDC_MINT, createMayanBnbToSolana } from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const RPC = "https://rpc.test";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIGNER = "0x1111111111111111111111111111111111111111";

const supportedIntent = {
  id: "mayan-conformance",
  source: {
    account: { chainId: "eip155:56", address: SIGNER },
    asset: {
      chainId: "eip155:56",
      assetId: `eip155:56/erc20:${BNB_PEG_USDC.toLowerCase()}`,
      symbol: "USDC",
      decimals: 18,
    },
  },
  destination: {
    account: { chainId: "solana:mainnet", address: WALLET },
    settlementAsset: {
      chainId: "solana:mainnet",
      assetId: `solana:mainnet/spl:${SOLANA_USDC_MINT}`,
      symbol: "USDC",
      decimals: 6,
    },
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

// Native Ethereum USDC belongs to the CCTP provider, not this adapter.
const ethereumIntent = {
  ...supportedIntent,
  id: "ethereum-conformance",
  source: {
    account: { chainId: "eip155:1", address: SIGNER },
    asset: {
      chainId: "eip155:1",
      assetId: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      symbol: "USDC",
      decimals: 6,
    },
  },
};

function json(value) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

const plugin = createMayanBnbToSolana({
  sdk: {
    fetchQuote: async () => [
      {
        type: "SWIFT",
        effectiveAmountIn64: "100000000",
        expectedAmountOut: 99.5,
        minReceived: 99.1,
        etaSeconds: 42,
        toToken: { contract: SOLANA_USDC_MINT, decimals: 6 },
      },
    ],
    getSwapFromEvmTxPayload: async () => ({
      to: MAYAN_FORWARDER,
      data: `0x${"cd".repeat(200)}`,
      value: 0,
    }),
  },
  rpcUrl: RPC,
  explorerBaseUrl: "https://explorer.test",
  fetch: async (input) =>
    String(input) === RPC
      ? json({ jsonrpc: "2.0", id: 1, result: { value: { amount: "0" } } })
      : json({ status: "INITIATED_ON_EVM" }),
});

for (const item of fundingProviderConformance({
  plugin,
  supportedIntent,
  unsupportedIntent: ethereumIntent,
  now,
})) {
  test(`Mayan adapter: ${item.name}`, async () => {
    await item.run();
  });
}
