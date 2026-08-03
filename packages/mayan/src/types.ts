export interface MayanToken {
  contract: string;
  decimals?: number;
  symbol?: string;
}

/** The subset of Mayan's Quote this adapter relies on. */
export interface MayanQuote {
  type?: string;
  effectiveAmountIn64?: string;
  expectedAmountOut: number;
  minAmountOut?: number;
  minReceived: number;
  etaSeconds?: number;
  toToken?: MayanToken;
  [key: string]: unknown;
}

export interface MayanSdk {
  fetchQuote(params: Record<string, unknown>): Promise<MayanQuote[]>;
  getSwapFromEvmTxPayload(
    quote: MayanQuote,
    swapperAddress: string,
    destinationAddress: string,
    referrerAddresses: unknown,
    signerAddress: string,
    signerChainId: number | string,
    payload: unknown,
    permit: unknown,
    options?: { apiKey?: string },
  ): Promise<{ to?: unknown; data?: unknown; value?: unknown }>;
}

export interface MayanOptions {
  /** Mayan's SDK, injected so the adapter is testable without network access. */
  sdk: MayanSdk;
  /** Solana RPC, used to prove delivery into the destination token account. */
  rpcUrl: string;
  apiKey?: string;
  explorerBaseUrl?: string;
  sourceToken?: string;
  settlementMint?: string;
  solanaChainId?: string;
  quoteTtlSeconds?: number;
  fetch?: typeof globalThis.fetch;
}
