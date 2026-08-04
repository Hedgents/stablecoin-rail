import { createServer } from "node:http";
import { createRailHandler } from "@hedgents/stablecoin-rail/remote";
import { createAllbridgePoolReader } from "@hedgents/stablecoin-rail-allbridge";
import {
  ARBITRUM_MAINNET,
  BASE_MAINNET,
  ETHEREUM_MAINNET,
  SOLANA_MAINNET,
  createCctpToSolana,
} from "@hedgents/stablecoin-rail-cctp";
import { createMayanBnbToSolana } from "@hedgents/stablecoin-rail-mayan";
import {
  ROBINHOOD_USDG_ADDRESS,
  SOLANA_USDG_MINT,
  createLayerZeroUsdgRobinhoodToSolana,
  createLayerZeroUsdt0TronToSolana,
} from "@hedgents/stablecoin-rail-layerzero";
import { fetchQuote, getSwapFromEvmTxPayload } from "@mayanfinance/swap-sdk";

/**
 * The server half of the demo.
 *
 * Everything secret lives here: RPC URLs, provider API keys, and the USDT0
 * contract allowlist. The browser only ever sees the plugin contract.
 */

const PORT = Number(process.env.PORT ?? 8787);
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const MAYAN_API_KEY = process.env.MAYAN_API_KEY;
const LAYERZERO_API_KEY = process.env.LAYERZERO_API_KEY;
// Optional. Unset means the support prompt never renders at all.
const DONATION_ADDRESS = process.env.DONATION_ADDRESS ?? null;
const DONATION_USD = Number(process.env.DONATION_USD ?? 5);
const USDT0_ALLOWLIST = (process.env.USDT0_TRON_ALLOWLIST ?? "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);

const fundingProviders = [];
const routes = [];

// ---------------------------------------------------------------- CCTP (USDC)

const cctp = createCctpToSolana({
  sources: [ETHEREUM_MAINNET, BASE_MAINNET, ARBITRUM_MAINNET],
  solana: SOLANA_MAINNET,
  rpcUrl: RPC_URL,
});
fundingProviders.push(cctp);

for (const [label, chain] of [
  ["Ethereum", ETHEREUM_MAINNET],
  ["Base", BASE_MAINNET],
  ["Arbitrum", ARBITRUM_MAINNET],
]) {
  routes.push({
    id: `cctp-${chain.numericChainId}`,
    pluginId: cctp.manifest.id,
    providerName: cctp.manifest.name,
    namespace: "evm",
    label,
    chainId: chain.chainId,
    numericChainId: chain.numericChainId,
    token: { address: chain.usdcAddress, symbol: "USDC", decimals: 6 },
    assetId: `${chain.chainId}/erc20:${chain.usdcAddress.toLowerCase()}`,
    settlement: { symbol: "USDC", mint: SOLANA_MAINNET.usdcMint, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_MAINNET.usdcMint}`,
    native: true,
    status: "live",
    note: "Native Circle USDC via CCTP V2 and the Forwarding Service.",
  });
}

// -------------------------------------------------------- Mayan (Binance-Peg)

// Bundled into the function by esbuild, so no ESM/CJS boundary survives to
// runtime. See the note in vercel.json's build command.
const mayanSdk = { fetchQuote, getSwapFromEvmTxPayload };

const BNB_USDC = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d";
if (mayanSdk) {
  const mayan = createMayanBnbToSolana({
    sdk: mayanSdk,
    rpcUrl: RPC_URL,
    ...(MAYAN_API_KEY ? { apiKey: MAYAN_API_KEY } : {}),
  });
  fundingProviders.push(mayan);
  routes.push({
    id: "mayan-56",
    pluginId: mayan.manifest.id,
    providerName: mayan.manifest.name,
    namespace: "evm",
    label: "BNB Chain",
    chainId: "eip155:56",
    numericChainId: 56,
    token: { address: BNB_USDC, symbol: "USDC", decimals: 18 },
    assetId: `eip155:56/erc20:${BNB_USDC.toLowerCase()}`,
    settlement: { symbol: "USDC", mint: SOLANA_MAINNET.usdcMint, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_MAINNET.usdcMint}`,
    native: false,
    status: "live",
    note: "Adapter route. Binance-Peg USDC is issued by Binance, not Circle, and Mayan swaps it. Not CCTP.",
  });
} else {
  routes.push({
    id: "mayan-56",
    namespace: "evm",
    label: "BNB Chain",
    chainId: "eip155:56",
    numericChainId: 56,
    token: { address: BNB_USDC, symbol: "USDC", decimals: 18 },
    assetId: `eip155:56/erc20:${BNB_USDC.toLowerCase()}`,
    settlement: { symbol: "USDC", mint: SOLANA_MAINNET.usdcMint, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_MAINNET.usdcMint}`,
    native: false,
    status: "unavailable",
    note: "Install @mayanfinance/swap-sdk to enable this route. The rail injects it rather than bundling it.",
  });
}

// ------------------------------------------------------------ USDT0 (TRON)

const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SOLANA_USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

if (LAYERZERO_API_KEY) {
  /*
   * The allowlist is optional hardening, not a precondition. Without one the
   * adapter still enforces its structural checks and surfaces the contract it
   * will call; with one it additionally pins the target, which a production
   * deployment should do.
   */
  const usdt0 = createLayerZeroUsdt0TronToSolana({
    apiKey: LAYERZERO_API_KEY,
    ...(USDT0_ALLOWLIST.length > 0
      ? {
          validateTronTransaction: ({ transaction }) => {
            for (const call of transaction.raw_data.contract) {
              const target = String(call?.parameter?.value?.contract_address ?? "").toLowerCase();
              if (!USDT0_ALLOWLIST.includes(target)) {
                throw new Error(`TRON contract ${target} is not in the configured USDT0 allowlist.`);
              }
            }
          },
        }
      : {}),
  });
  fundingProviders.push(usdt0);
  routes.push({
    id: "usdt0-tron",
    pluginId: usdt0.manifest.id,
    providerName: usdt0.manifest.name,
    namespace: "tron",
    label: "TRON",
    chainId: "tron:mainnet",
    token: { address: TRON_USDT, symbol: "USDT", decimals: 6 },
    assetId: `tron:mainnet/trc20:${TRON_USDT}`,
    settlement: { symbol: "USDT", mint: SOLANA_USDT, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_USDT}`,
    native: true,
    status: "live",
    note:
      USDT0_ALLOWLIST.length > 0
        ? "Canonical USDT via USDT0 Legacy Mesh, with a pinned contract allowlist."
        : "Canonical USDT via USDT0 Legacy Mesh. No contract allowlist configured; set USDT0_TRON_ALLOWLIST to pin the target.",
  });
} else {
  routes.push({
    id: "usdt0-tron",
    namespace: "tron",
    label: "TRON",
    chainId: "tron:mainnet",
    token: { address: TRON_USDT, symbol: "USDT", decimals: 6 },
    assetId: `tron:mainnet/trc20:${TRON_USDT}`,
    settlement: { symbol: "USDT", mint: SOLANA_USDT, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_USDT}`,
    native: true,
    status: "gated",
    note: "Needs LAYERZERO_API_KEY. USDT0_TRON_ALLOWLIST is optional hardening on top.",
  });
}

// -------------------------------------------------------- USDG (Robinhood)

/*
 * Unlike the TRON route this needs no contract allowlist: it is an OFT send on
 * an ordinary EVM chain, and the adapter validates LayerZero's returned target,
 * calldata, signer, and zero native value itself. So it opens as soon as an API
 * key exists.
 */
if (LAYERZERO_API_KEY) {
  const usdg = createLayerZeroUsdgRobinhoodToSolana({ apiKey: LAYERZERO_API_KEY });
  fundingProviders.push(usdg);
  routes.push({
    id: "usdg-robinhood",
    pluginId: usdg.manifest.id,
    providerName: usdg.manifest.name,
    namespace: "evm",
    label: "Robinhood Chain",
    chainId: "eip155:4663",
    numericChainId: 4663,
    token: { address: ROBINHOOD_USDG_ADDRESS, symbol: "USDG", decimals: 6 },
    assetId: `eip155:4663/erc20:${ROBINHOOD_USDG_ADDRESS.toLowerCase()}`,
    settlement: { symbol: "USDG", mint: SOLANA_USDG_MINT, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_USDG_MINT}`,
    native: true,
    status: "live",
    note: "Canonical USDG via LayerZero OFT. Same issuer on both ends, no swap.",
  });
} else {
  routes.push({
    id: "usdg-robinhood",
    namespace: "evm",
    label: "Robinhood Chain",
    chainId: "eip155:4663",
    numericChainId: 4663,
    token: { address: ROBINHOOD_USDG_ADDRESS, symbol: "USDG", decimals: 6 },
    assetId: `eip155:4663/erc20:${ROBINHOOD_USDG_ADDRESS.toLowerCase()}`,
    settlement: { symbol: "USDG", mint: SOLANA_USDG_MINT, decimals: 6 },
    settlementAssetId: `solana:mainnet/spl:${SOLANA_USDG_MINT}`,
    native: true,
    status: "gated",
    note: "Needs LAYERZERO_API_KEY. No contract allowlist required, unlike the TRON route.",
  });
}

// Signing is opt-in per deployment. No route has completed a mainnet transfer,
// so a public instance defaults to quote-only until an operator turns it on.
const SIGNING_ENABLED = process.env.RAIL_DEMO_SIGNING === "enabled";

const handle = createRailHandler({
  fundingProviders,
  authorize: (request) => {
    // Where a production host puts authentication, per-user rate limits, and
    // order-size caps. The SDK ships none of those on purpose.
    if (request.kind !== "funding") throw new Error("This demo only exposes funding routes.");
    if (!SIGNING_ENABLED && request.method === "prepare") {
      throw new Error(
        "Signing is disabled on this deployment. No route has completed a mainnet transfer yet.",
      );
    }
  },
});

/*
 * Pool-liquidity assessment, exposed separately from the rail.
 *
 * Only pool-based routes have this risk, so it is not a rail concept: CCTP and
 * OFT routes have no pool and inventing a score for them would be dishonest.
 * The registry is public and needs no key.
 */
const poolReader = createAllbridgePoolReader();

export async function assessPool({ symbol, amountBaseUnits }) {
  return poolReader.assess({
    sourceChainKey: "TRX",
    destinationChainKey: "SOL",
    symbol,
    amountBaseUnits: BigInt(amountBaseUnits),
  });
}

export { handle, routes, SIGNING_ENABLED };
export const support = DONATION_ADDRESS
  ? { address: DONATION_ADDRESS, suggestedUsd: DONATION_USD }
  : null;
