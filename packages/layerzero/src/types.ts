import type {
  FundingIntent,
  FundingQuote,
  JsonValue,
} from "@hedgents/stablecoin-rail";

export interface TronTransactionPolicyContext {
  intent: FundingIntent;
  quote: FundingQuote;
  signerAddress: string;
  transaction: { [key: string]: JsonValue };
}

export interface LayerZeroTransferApiOptions {
  /** LayerZero Value Transfer API key. Keep this adapter on a server. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Maximum route fee percentage accepted by the upstream API. */
  feeTolerancePercent?: number;
  /**
   * Required before transaction preparation. Decode the TRON call and verify
   * its current USDT0 target/recipient against an independently maintained
   * allowlist. USDT0 asks direct integrators to coordinate contract migrations.
   */
  validateTronTransaction?: (
    context: TronTransactionPolicyContext,
  ) => void | Promise<void>;
}

export interface LayerZeroRouteStep {
  type: string;
  srcChainKey: string;
  description?: string;
  duration?: { estimated?: string | null };
}

export interface LayerZeroQuote {
  id: string;
  routeSteps?: LayerZeroRouteStep[];
  duration?: { estimated?: string | null };
  feeUsd?: string;
  feePercent?: string;
  expiresAt: string;
  srcAmount: string | number;
  dstAmount: string | number;
  dstAmountMin: string | number;
}

export interface LayerZeroTransactionUserStep {
  type: "TRANSACTION";
  description?: string;
  chainKey: string;
  chainType: string;
  signerAddress: string;
  transaction: {
    encoded: unknown;
  };
}

export interface LayerZeroSignatureUserStep {
  type: "SIGNATURE";
  description?: string;
  chainKey?: string;
  chainType?: string;
}

export type LayerZeroUserStep =
  | LayerZeroTransactionUserStep
  | LayerZeroSignatureUserStep;

export interface LayerZeroExecutionEvent {
  event: "SENT" | "BUS_RODE" | "DELIVERED" | "REFUNDED";
  transaction: {
    chainKey: string;
    hash: string;
    timestamp?: number;
  };
}

export interface LayerZeroStatus {
  status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  explorerUrl?: string;
  executionHistory: LayerZeroExecutionEvent[];
}
