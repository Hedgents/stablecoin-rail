import {
  RailPluginError,
  defineFundingProvider,
  type AssetDescriptor,
  type FundingIntent,
  type FundingQuote,
  type FundingQuoteDraft,
  type JsonValue,
  type TransactionReference,
  type WalletStep,
} from "@hedgents/stablecoin-rail";
import {
  LAYERZERO_TRON_USDT_ADDRESS,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_USDT,
  SOLANA_USDT_MINT,
  TRON_MAINNET_CHAIN_ID,
  TRON_USDT,
} from "./assets.js";
import { LayerZeroTransferApi } from "./http.js";
import type {
  LayerZeroExecutionEvent,
  LayerZeroQuote,
  LayerZeroTransferApiOptions,
} from "./types.js";

const PLUGIN_ID = "layerzero-usdt0-tron-solana";
const OPAQUE_SCHEMA = "hedgents.layerzero.usdt0.tron-solana.v1";
const QUOTE_ID = /^0x[0-9a-fA-F]{64}$/;
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const INTEGER = /^\d+$/;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameAsset(left: AssetDescriptor, right: AssetDescriptor) {
  return (
    left.chainId === right.chainId &&
    left.assetId === right.assetId &&
    left.decimals === right.decimals
  );
}

function supportsRoute(intent: FundingIntent) {
  return (
    intent.source.account.chainId === TRON_MAINNET_CHAIN_ID &&
    TRON_ADDRESS.test(intent.source.account.address) &&
    sameAsset(intent.source.asset, TRON_USDT) &&
    intent.destination.account.chainId === SOLANA_MAINNET_CHAIN_ID &&
    SOLANA_ADDRESS.test(intent.destination.account.address) &&
    sameAsset(intent.destination.settlementAsset, SOLANA_USDT)
  );
}

function amount(value: unknown, field: string) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !INTEGER.test(text) || BigInt(text) <= 0n) {
    throw new RailPluginError(PLUGIN_ID, "INVALID_UPSTREAM_RESPONSE", `${field} is invalid.`);
  }
  return text;
}

function expiresAt(value: unknown) {
  if (typeof value !== "string") {
    throw new RailPluginError(PLUGIN_ID, "INVALID_UPSTREAM_RESPONSE", "Quote expiry is missing.");
  }
  const numeric = INTEGER.test(value) ? Number(value) : Number.NaN;
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RailPluginError(PLUGIN_ID, "INVALID_UPSTREAM_RESPONSE", "Quote expiry is invalid.");
  }
  return new Date(timestamp).toISOString();
}

function etaSeconds(quote: LayerZeroQuote) {
  const raw = quote.duration?.estimated;
  if (raw == null) return 0;
  const milliseconds = Number(raw);
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? Math.ceil(milliseconds / 1_000)
    : 0;
}

function chooseQuote(quotes: LayerZeroQuote[], exactSourceAmount: string) {
  const valid = quotes.filter((quote) => {
    try {
      return (
        QUOTE_ID.test(quote.id) &&
        amount(quote.srcAmount, "srcAmount") === exactSourceAmount &&
        BigInt(amount(quote.dstAmount, "dstAmount")) >=
          BigInt(amount(quote.dstAmountMin, "dstAmountMin")) &&
        !(quote.routeSteps ?? []).some((step) => step.type === "SWAP")
      );
    } catch {
      return false;
    }
  });
  valid.sort((left, right) => {
    const leftMinimum = BigInt(amount(left.dstAmountMin, "dstAmountMin"));
    const rightMinimum = BigInt(amount(right.dstAmountMin, "dstAmountMin"));
    if (leftMinimum !== rightMinimum) return leftMinimum > rightMinimum ? -1 : 1;
    return etaSeconds(left) - etaSeconds(right);
  });
  return valid[0] ?? null;
}

function opaqueRecord(quote: FundingQuote) {
  if (!isRecord(quote.opaqueData)) {
    throw new RailPluginError(PLUGIN_ID, "INVALID_QUOTE_DATA", "LayerZero quote data is missing.");
  }
  return quote.opaqueData;
}

function requirePinnedQuote(intent: FundingIntent, quote: FundingQuote) {
  const data = opaqueRecord(quote);
  const pins = {
    schema: OPAQUE_SCHEMA,
    quoteId: quote.id,
    sourceSigner: intent.source.account.address,
    destinationRecipient: intent.destination.account.address,
    sourceAmount: intent.inputAmountBaseUnits,
    sourceToken: LAYERZERO_TRON_USDT_ADDRESS,
    destinationToken: SOLANA_USDT_MINT,
  };
  for (const [key, expected] of Object.entries(pins)) {
    if (data[key] !== expected) {
      throw new RailPluginError(
        PLUGIN_ID,
        "QUOTE_PIN_MISMATCH",
        `The prepared LayerZero quote changed ${key}.`,
      );
    }
  }
  if (!QUOTE_ID.test(quote.id)) {
    throw new RailPluginError(PLUGIN_ID, "INVALID_QUOTE_DATA", "LayerZero quote ID is invalid.");
  }
  return data;
}

function jsonRecord(value: unknown) {
  if (!isRecord(value)) {
    throw new RailPluginError(
      PLUGIN_ID,
      "INVALID_UPSTREAM_RESPONSE",
      "LayerZero returned no structured TRON transaction.",
    );
  }
  try {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    if (!isRecord(normalized) || Object.keys(normalized).length === 0) throw new Error("empty");
    return normalized as { [key: string]: JsonValue };
  } catch (cause) {
    throw new RailPluginError(
      PLUGIN_ID,
      "INVALID_UPSTREAM_RESPONSE",
      "LayerZero returned an invalid TRON transaction.",
      { cause },
    );
  }
}

function zeroValue(value: unknown) {
  return value === undefined || value === 0 || value === "0";
}

function assertUnsignedTronEnvelope(transaction: { [key: string]: JsonValue }) {
  if (Array.isArray(transaction.signature) && transaction.signature.length > 0) {
    throw new RailPluginError(
      PLUGIN_ID,
      "PRE_SIGNED_TRANSACTION",
      "LayerZero returned a TRON transaction that is already signed.",
    );
  }
  const rawData = transaction.raw_data;
  if (!isRecord(rawData) || !Array.isArray(rawData.contract) || rawData.contract.length === 0) {
    throw new RailPluginError(
      PLUGIN_ID,
      "INVALID_TRON_TRANSACTION",
      "LayerZero returned a TRON transaction without contract calls.",
    );
  }
  if (rawData.contract.length > 4) {
    throw new RailPluginError(
      PLUGIN_ID,
      "INVALID_TRON_TRANSACTION",
      "LayerZero returned too many TRON contract calls.",
    );
  }
  for (const call of rawData.contract) {
    if (!isRecord(call) || call.type !== "TriggerSmartContract" || !isRecord(call.parameter)) {
      throw new RailPluginError(
        PLUGIN_ID,
        "UNEXPECTED_TRON_CALL",
        "The TRON wallet request contains an unexpected contract call.",
      );
    }
    const value = call.parameter.value;
    if (!isRecord(value) || typeof value.owner_address !== "string") {
      throw new RailPluginError(
        PLUGIN_ID,
        "INVALID_TRON_TRANSACTION",
        "The TRON contract call has no owner address.",
      );
    }
    if (!zeroValue(value.call_value) || !zeroValue(value.call_token_value)) {
      throw new RailPluginError(
        PLUGIN_ID,
        "UNEXPECTED_TRX_VALUE",
        "The TRON contract call attempts to transfer TRX or a TRC-10 token.",
      );
    }
  }
}

function submittedAt(event: LayerZeroExecutionEvent, fallback: string) {
  const value = event.transaction.timestamp;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(milliseconds).toISOString();
}

function destinationReference(
  history: LayerZeroExecutionEvent[],
  checkedAt: string,
): TransactionReference | null {
  const delivered = [...history]
    .reverse()
    .find((event) => event.event === "DELIVERED" && event.transaction.chainKey === "solana");
  if (!delivered || delivered.transaction.hash.length === 0) return null;
  return {
    chainId: SOLANA_MAINNET_CHAIN_ID,
    txId: delivered.transaction.hash,
    submittedAt: submittedAt(delivered, checkedAt),
  };
}

export function createLayerZeroUsdt0TronToSolana(options: LayerZeroTransferApiOptions) {
  const api = new LayerZeroTransferApi(options);

  return defineFundingProvider({
    manifest: {
      id: PLUGIN_ID,
      name: "USDT0 Legacy Mesh",
      version: "0.1.0",
      apiVersion: 1,
      kind: "funding-provider",
      homepage: "https://usdt0.to/transfer",
    },
    supports: supportsRoute,
    quote: async (intent, context): Promise<FundingQuoteDraft | null> => {
      if (!supportsRoute(intent)) return null;
      const selected = chooseQuote(
        await api.quote(
          {
            amount: intent.inputAmountBaseUnits,
            srcWalletAddress: intent.source.account.address,
            dstWalletAddress: intent.destination.account.address,
            srcTokenAddress: LAYERZERO_TRON_USDT_ADDRESS,
            dstTokenAddress: SOLANA_USDT_MINT,
          },
          context.signal,
        ),
        intent.inputAmountBaseUnits,
      );
      if (!selected) return null;
      const sourceAmount = amount(selected.srcAmount, "srcAmount");
      if (sourceAmount !== intent.inputAmountBaseUnits) {
        throw new RailPluginError(
          PLUGIN_ID,
          "QUOTE_AMOUNT_MISMATCH",
          "LayerZero changed the exact source amount.",
        );
      }
      const expectedOutput = amount(selected.dstAmount, "dstAmount");
      const minimumOutput = amount(selected.dstAmountMin, "dstAmountMin");
      return {
        id: selected.id,
        input: { asset: intent.source.asset, amountBaseUnits: sourceAmount },
        expectedOutput: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: expectedOutput,
        },
        minimumOutput: {
          asset: intent.destination.settlementAsset,
          amountBaseUnits: minimumOutput,
        },
        fees: [],
        etaSeconds: etaSeconds(selected),
        expiresAt: expiresAt(selected.expiresAt),
        executionMode: "two-phase",
        opaqueData: {
          schema: OPAQUE_SCHEMA,
          quoteId: selected.id,
          sourceChainKey: "tron",
          destinationChainKey: "solana",
          sourceSigner: intent.source.account.address,
          destinationRecipient: intent.destination.account.address,
          sourceAmount,
          expectedOutput,
          minimumOutput,
          sourceToken: LAYERZERO_TRON_USDT_ADDRESS,
          destinationToken: SOLANA_USDT_MINT,
          routeTypes: (selected.routeSteps ?? []).map((step) => step.type),
          feeUsd: selected.feeUsd ?? null,
          feePercent: selected.feePercent ?? null,
        },
      };
    },
    prepare: async ({ intent, quote }, context): Promise<WalletStep[]> => {
      requirePinnedQuote(intent, quote);
      const upstreamSteps = await api.buildUserSteps(quote.id, context.signal);
      if (upstreamSteps.length === 0) {
        throw new RailPluginError(
          PLUGIN_ID,
          "EMPTY_USER_STEPS",
          "LayerZero returned no wallet steps.",
        );
      }
      return Promise.all(
        upstreamSteps.map(async (step, index) => {
          if (step.type !== "TRANSACTION") {
            throw new RailPluginError(
              PLUGIN_ID,
              "UNSUPPORTED_USER_STEP",
              "This route requires a signature format the TRON adapter does not support.",
            );
          }
          if (step.chainKey !== "tron" || step.chainType !== "TRON") {
            throw new RailPluginError(
              PLUGIN_ID,
              "UNEXPECTED_SOURCE_CHAIN",
              "LayerZero returned a wallet step outside TRON.",
            );
          }
          if (step.signerAddress !== intent.source.account.address) {
            throw new RailPluginError(
              PLUGIN_ID,
              "SIGNER_MISMATCH",
              "LayerZero returned a TRON transaction for another signer.",
            );
          }
          const description = step.description ?? "Fund Solana with USDT";
          const transaction = jsonRecord(step.transaction.encoded);
          assertUnsignedTronEnvelope(transaction);
          if (!options.validateTronTransaction) {
            throw new RailPluginError(
              PLUGIN_ID,
              "TRANSACTION_POLICY_REQUIRED",
              "Configure an independent USDT0 TRON contract/recipient allowlist before preparing wallet requests.",
            );
          }
          await options.validateTronTransaction({
            intent,
            quote,
            signerAddress: step.signerAddress,
            transaction,
          });
          return {
            id: `layerzero-tron-${index + 1}`,
            kind: /approv/i.test(description) ? "approval" : "funding",
            chainId: TRON_MAINNET_CHAIN_ID,
            label: description,
            description: "Move canonical USDT from TRON to canonical USDT on Solana.",
            request: {
              namespace: "tron",
              chainId: TRON_MAINNET_CHAIN_ID,
              signerAddress: step.signerAddress,
              transaction,
            },
          };
        }),
      );
    },
    getStatus: async ({ intent, quote, reference }, context) => {
      requirePinnedQuote(intent, quote);
      if (reference.chainId !== TRON_MAINNET_CHAIN_ID) {
        throw new RailPluginError(
          PLUGIN_ID,
          "REFERENCE_CHAIN_MISMATCH",
          "The LayerZero source reference must be a TRON transaction.",
        );
      }
      const upstream = await api.status(quote.id, reference.txId, context.signal);
      const history = Array.isArray(upstream.executionHistory) ? upstream.executionHistory : [];
      const checkedAt = new Date(context.now()).toISOString();
      const refunded = history.some((event) => event.event === "REFUNDED");
      const delivery = destinationReference(history, checkedAt);
      const state = refunded
        ? "refunded"
        : upstream.status === "SUCCEEDED" && delivery
          ? "completed"
          : upstream.status === "FAILED"
            ? "failed"
            : "pending";
      return {
        state,
        reference,
        destinationReference: delivery,
        received: null,
        detail:
          state === "completed"
            ? "LayerZero reports canonical USDT delivered on Solana."
            : state === "refunded"
              ? "LayerZero reports the source transfer was refunded."
              : state === "failed"
                ? "LayerZero reports the transfer failed."
                : upstream.status === "SUCCEEDED"
                  ? "LayerZero reports success, but Solana delivery evidence is not indexed yet."
                  : upstream.status === "UNKNOWN"
                    ? "LayerZero has not indexed this transfer yet."
                    : "USDT is moving from TRON to Solana.",
        checkedAt,
      };
    },
  });
}
