import {
  RailPluginError,
  defineDestinationAction,
  defineFundingProvider,
  type DestinationActionQuoteDraft,
  type DestinationActionStatus,
  type FundingQuoteDraft,
  type FundingStatus,
  type JsonValue,
  type TransactionReference,
  type WalletStep,
} from "@hedgents/stablecoin-rail";

interface ServerPluginOptions {
  baseUrl: string;
  headers?: () => Record<string, string>;
}

async function postJson<T>(
  options: ServerPluginOptions,
  path: string,
  body: JsonValue,
  signal?: AbortSignal,
) {
  const response = await fetch(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...options.headers?.(),
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new RailPluginError(
      path,
      "UPSTREAM_REJECTED",
      detail || `The integration server returned ${response.status}.`,
    );
  }
  return response.json() as Promise<T>;
}

function serializable(value: unknown) {
  return value as JsonValue;
}

export function createCircleCctpPlugin(options: ServerPluginOptions) {
  return defineFundingProvider({
    manifest: {
      id: "circle-cctp-v2",
      name: "Circle CCTP V2",
      version: "0.1.0",
      apiVersion: 1,
      kind: "funding-provider",
      homepage: "https://www.circle.com/cross-chain-transfer-protocol",
    },
    supports: (intent) =>
      intent.source.account.chainId === "eip155:1" &&
      intent.source.asset.symbol === "USDC" &&
      intent.destination.account.chainId.startsWith("solana:") &&
      intent.destination.settlementAsset.symbol === "USDC",
    quote: (intent, context) =>
      postJson<FundingQuoteDraft>(
        options,
        "/funding/cctp/quote",
        serializable({ intent }),
        context.signal,
      ),
    prepare: ({ intent, quote, preparation }, context) =>
      postJson<WalletStep[]>(
        options,
        "/funding/cctp/prepare",
        serializable({ intent, quote, preparation: preparation ?? null }),
        context.signal,
      ),
    getStatus: ({ intent, quote, reference }, context) =>
      postJson<FundingStatus>(
        options,
        "/funding/cctp/status",
        serializable({ intent, quote, reference }),
        context.signal,
      ),
  });
}

export function createMayanBnbPlugin(options: ServerPluginOptions) {
  return defineFundingProvider({
    manifest: {
      id: "mayan-bnb-solana",
      name: "Mayan BNB → Solana",
      version: "0.1.0",
      apiVersion: 1,
      kind: "funding-provider",
      homepage: "https://mayan.finance",
    },
    supports: (intent) =>
      intent.source.account.chainId === "eip155:56" &&
      intent.source.asset.symbol === "USDC" &&
      intent.destination.account.chainId.startsWith("solana:") &&
      intent.destination.settlementAsset.symbol === "USDC",
    quote: (intent, context) =>
      postJson<FundingQuoteDraft>(
        options,
        "/funding/mayan/quote",
        serializable({ intent }),
        context.signal,
      ),
    prepare: ({ intent, quote, preparation }, context) =>
      postJson<WalletStep[]>(
        options,
        "/funding/mayan/prepare",
        serializable({ intent, quote, preparation: preparation ?? null }),
        context.signal,
      ),
    getStatus: ({ intent, quote, reference }, context) =>
      postJson<FundingStatus>(
        options,
        "/funding/mayan/status",
        serializable({ intent, quote, reference }),
        context.signal,
      ),
  });
}

export function createJupiterActionPlugin(options: ServerPluginOptions) {
  return defineDestinationAction({
    manifest: {
      id: "jupiter-swap",
      name: "Jupiter Swap",
      version: "0.1.0",
      apiVersion: 1,
      kind: "destination-action",
      homepage: "https://jup.ag",
    },
    supports: ({ intent, fundingQuote }) =>
      intent.destination.account.chainId.startsWith("solana:") &&
      fundingQuote.minimumOutput.asset.symbol === "USDC",
    quote: ({ intent, fundingQuote }, context) =>
      postJson<DestinationActionQuoteDraft>(
        options,
        "/actions/jupiter/quote",
        serializable({ intent, fundingQuote }),
        context.signal,
      ),
    prepare: ({ intent, fundingQuote, actionQuote, preparation }, context) =>
      postJson<WalletStep[]>(
        options,
        "/actions/jupiter/prepare",
        serializable({
          intent,
          fundingQuote,
          actionQuote,
          preparation: preparation ?? null,
        }),
        context.signal,
      ),
    getStatus: ({ intent, fundingQuote, actionQuote, reference }, context) =>
      postJson<DestinationActionStatus>(
        options,
        "/actions/jupiter/status",
        serializable({ intent, fundingQuote, actionQuote, reference }),
        context.signal,
      ),
  });
}

export function transactionReference(
  chainId: string,
  txId: string,
  submittedAt = new Date().toISOString(),
): TransactionReference {
  return { chainId, txId, submittedAt };
}
