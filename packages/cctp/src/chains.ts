import type { CctpSolanaSettlement, CctpSourceChain } from "./types.js";

/** Deployed at the same address on every supported EVM chain via CREATE2. */
export const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;

export const ETHEREUM_MAINNET: CctpSourceChain = Object.freeze({
  chainId: "eip155:1",
  numericChainId: 1,
  cctpDomain: 0,
  usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  tokenMessengerV2: TOKEN_MESSENGER_V2,
});

export const BASE_MAINNET: CctpSourceChain = Object.freeze({
  chainId: "eip155:8453",
  numericChainId: 8453,
  cctpDomain: 6,
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenMessengerV2: TOKEN_MESSENGER_V2,
});

export const ARBITRUM_MAINNET: CctpSourceChain = Object.freeze({
  chainId: "eip155:42161",
  numericChainId: 42161,
  cctpDomain: 3,
  usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  tokenMessengerV2: TOKEN_MESSENGER_V2,
});

export const SOLANA_MAINNET: CctpSolanaSettlement = Object.freeze({
  chainId: "solana:mainnet",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  cctpDomain: 5,
});
