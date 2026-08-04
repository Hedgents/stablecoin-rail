export interface CctpSourceChain {
  /** CAIP-2 identifier, for example "eip155:1". */
  chainId: string;
  numericChainId: number;
  cctpDomain: number;
  usdcAddress: `0x${string}`;
  tokenMessengerV2: `0x${string}`;
}

export interface CctpSolanaSettlement {
  chainId: string;
  usdcMint: string;
  cctpDomain: number;
  /**
   * Programs whose presence marks a transaction as a CCTP delivery. Defaults
   * to Circle's MessageTransmitterV2 and TokenMessengerMinterV2 (identical on
   * mainnet and devnet). Delivery is only ever attributed to a transaction
   * involving one of these, so an unrelated deposit cannot complete a flow.
   */
  deliveryProgramIds?: string[];
}

export interface CctpOptions {
  sources: CctpSourceChain[];
  solana: CctpSolanaSettlement;
  /** Solana RPC, used to read the recipient's token account. */
  rpcUrl: string;
  apiBaseUrl?: string;
  /** 1000 is Circle's fast tier, 2000 standard. */
  finalityThreshold?: number;
  quoteTtlSeconds?: number;
  /** Refuse amounts that do not clear fees by at least this margin. */
  minimumBufferBaseUnits?: bigint;
  /** How many recent recipient-account transactions the delivery scan reads. */
  deliveryScanLimit?: number;
  fetch?: typeof globalThis.fetch;
}
