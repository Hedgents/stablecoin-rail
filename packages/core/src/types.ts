export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface AccountDescriptor {
  chainId: string;
  address: string;
}

export interface AssetDescriptor {
  chainId: string;
  assetId: string;
  symbol: string;
  decimals: number;
}

export interface AssetAmount {
  asset: AssetDescriptor;
  amountBaseUnits: string;
}

export interface DestinationActionRequest {
  pluginId: string;
  params?: JsonValue;
}

export interface FundingIntent {
  id: string;
  source: {
    account: AccountDescriptor;
    asset: AssetDescriptor;
  };
  destination: {
    account: AccountDescriptor;
    settlementAsset: AssetDescriptor;
  };
  inputAmountBaseUnits: string;
  slippageBps: number;
  /**
   * Omit for funding-only intents. When omitted the rail settles the stablecoin
   * into the destination account and ranks routes by guaranteed settlement
   * output rather than by application output.
   */
  action?: DestinationActionRequest;
  metadata?: JsonValue;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  kind: "funding-provider" | "destination-action";
  homepage?: string;
}

export interface RailFee {
  type: "provider" | "network" | "forwarding" | "application" | "other";
  label: string;
  amount: AssetAmount;
}

export interface FundingQuoteDraft {
  id: string;
  input: AssetAmount;
  expectedOutput: AssetAmount;
  minimumOutput: AssetAmount;
  fees: RailFee[];
  etaSeconds: number;
  expiresAt: string;
  executionMode: "two-phase";
  opaqueData?: JsonValue;
}

export interface FundingQuote extends FundingQuoteDraft {
  providerId: string;
  providerName: string;
}

export interface DestinationActionQuoteDraft {
  id: string;
  input: AssetAmount;
  expectedOutput: AssetAmount;
  minimumOutput: AssetAmount;
  fees: RailFee[];
  expiresAt: string;
  opaqueData?: JsonValue;
}

export interface DestinationActionQuote extends DestinationActionQuoteDraft {
  pluginId: string;
  pluginName: string;
}

export interface IntentQuote {
  id: string;
  intent: FundingIntent;
  funding: FundingQuote;
  /** Null for funding-only intents. */
  action: DestinationActionQuote | null;
  expiresAt: string;
  totalEtaSeconds: number;
}

export interface QuoteFailure {
  pluginId: string;
  stage: "supports" | "funding-quote" | "action-quote" | "validation";
  code: string;
  message: string;
}

export interface QuoteBatch {
  intentId: string;
  quotedAt: string;
  quotes: IntentQuote[];
  failures: QuoteFailure[];
}

export interface PluginContext {
  now: () => number;
  signal?: AbortSignal;
}

export interface PreparationContext {
  connectedAccounts?: AccountDescriptor[];
  metadata?: JsonValue;
}

export interface EvmTransactionRequest {
  namespace: "evm";
  chainId: string;
  numericChainId: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
}

export interface SolanaTransactionRequest {
  namespace: "solana";
  chainId: string;
  transactionBase64: string;
  lastValidBlockHeight?: number;
}

/**
 * An unsigned TRON transaction object returned by a funding provider.
 *
 * TRON wallet extensions sign the structured transaction produced by a full
 * node or routing API. Keeping it structured lets the host render and verify
 * the signer before handing it to `tronWeb.trx.sign`.
 */
export interface TronTransactionRequest {
  namespace: "tron";
  chainId: string;
  signerAddress: string;
  transaction: { [key: string]: JsonValue };
}

export type WalletRequest =
  | EvmTransactionRequest
  | SolanaTransactionRequest
  | TronTransactionRequest;

/**
 * One unsigned request for the user's wallet.
 *
 * Steps are ORDERED and may depend on one another: an `approval` must be mined
 * before the `funding` step that spends it. A host that merely sends them in
 * order without awaiting confirmation will see the dependent step revert,
 * because wallet send methods resolve on broadcast rather than on inclusion.
 */
export interface WalletStep {
  id: string;
  kind: "approval" | "funding" | "destination-action";
  chainId: string;
  label: string;
  description?: string;
  request: WalletRequest;
}

export interface TransactionReference {
  chainId: string;
  txId: string;
  submittedAt: string;
}

export interface FundingStatus {
  state: "pending" | "completed" | "refunded" | "failed";
  reference: TransactionReference;
  destinationReference: TransactionReference | null;
  received: AssetAmount | null;
  detail: string;
  checkedAt: string;
}

export interface DestinationActionStatus {
  state: "pending" | "completed" | "failed";
  reference: TransactionReference;
  received: AssetAmount | null;
  detail: string;
  checkedAt: string;
}

export interface FundingProviderPlugin {
  manifest: PluginManifest & { kind: "funding-provider" };
  supports(intent: FundingIntent): boolean | Promise<boolean>;
  quote(intent: FundingIntent, context: PluginContext): Promise<FundingQuoteDraft | null>;
  prepare(
    request: {
      intent: FundingIntent;
      quote: FundingQuote;
      preparation?: PreparationContext;
    },
    context: PluginContext,
  ): Promise<WalletStep[]>;
  getStatus(
    request: {
      intent: FundingIntent;
      quote: FundingQuote;
      reference: TransactionReference;
    },
    context: PluginContext,
  ): Promise<FundingStatus>;
}

export interface DestinationActionPlugin {
  manifest: PluginManifest & { kind: "destination-action" };
  supports(request: {
    intent: FundingIntent;
    fundingQuote: FundingQuote;
  }): boolean | Promise<boolean>;
  quote(
    request: {
      intent: FundingIntent;
      fundingQuote: FundingQuote;
    },
    context: PluginContext,
  ): Promise<DestinationActionQuoteDraft | null>;
  prepare(
    request: {
      intent: FundingIntent;
      fundingQuote: FundingQuote;
      actionQuote: DestinationActionQuote;
      preparation?: PreparationContext;
    },
    context: PluginContext,
  ): Promise<WalletStep[]>;
  getStatus?(
    request: {
      intent: FundingIntent;
      fundingQuote: FundingQuote;
      actionQuote: DestinationActionQuote;
      reference: TransactionReference;
    },
    context: PluginContext,
  ): Promise<DestinationActionStatus>;
}

/**
 * Independently confirms what actually landed on the destination chain.
 *
 * A provider's own status API usually proves delivery happened, not how much
 * arrived. Without this, the destination action is sized from the quoted
 * minimum and a short delivery would go unnoticed.
 *
 * Return `null` when the transfer cannot be verified yet, which preserves the
 * quoted-minimum fallback rather than breaking the flow on an indexing lag.
 */
export interface SettlementVerifier {
  verify(
    request: {
      intent: FundingIntent;
      quote: FundingQuote;
      status: FundingStatus;
    },
    context: PluginContext,
  ): Promise<AssetAmount | null>;
}

export interface RailClientOptions {
  fundingProviders: FundingProviderPlugin[];
  destinationActions?: DestinationActionPlugin[];
  settlementVerifier?: SettlementVerifier;
  now?: () => number;
}

export interface RailCallOptions {
  signal?: AbortSignal;
}
