import type { AssetDescriptor } from "@hedgents/stablecoin-rail";

export const TRON_MAINNET_CHAIN_ID = "tron:mainnet";
export const SOLANA_MAINNET_CHAIN_ID = "solana:mainnet";

export const TRON_USDT_BASE58_ADDRESS = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

/** The same TRC-20 contract in the 20-byte form used by LayerZero discovery. */
export const LAYERZERO_TRON_USDT_ADDRESS =
  "0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C";

export const SOLANA_USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export const TRON_USDT: AssetDescriptor = Object.freeze({
  chainId: TRON_MAINNET_CHAIN_ID,
  assetId: `${TRON_MAINNET_CHAIN_ID}/trc20:${TRON_USDT_BASE58_ADDRESS}`,
  symbol: "USDT",
  decimals: 6,
});

export const SOLANA_USDT: AssetDescriptor = Object.freeze({
  chainId: SOLANA_MAINNET_CHAIN_ID,
  assetId: `${SOLANA_MAINNET_CHAIN_ID}/spl:${SOLANA_USDT_MINT}`,
  symbol: "USDT",
  decimals: 6,
});
