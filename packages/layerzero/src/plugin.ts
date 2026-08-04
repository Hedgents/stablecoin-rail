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
  amount,
  assertApprovalOrdering,
  chooseQuote,
  destinationReference,
  etaSeconds,
  expiresAt,
  isRecord,
  QUOTE_ID,
  sameAsset,
  SOLANA_ADDRESS,
  stepKindFromCallData,
  TRON_ADDRESS,
} from "./shared.js";
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

/**
 * Contract addresses a TRON envelope will call, in the hex form TRON uses
 * on the wire.
 *
 * A TRON transaction buries its target in
 * raw_data.contract[].parameter.value.contract_address, where neither a user
 * nor a wallet UI will notice it. Surfacing it is what makes an optional
 * allowlist a reasonable default rather than a blind spot.
 */
export function readTronContractTargets(transaction: { [key: string]: JsonValue }): string[] {
  const rawData = transaction.raw_data;
  if (!isRecord(rawData) || !Array.isArray(rawData.contract)) return [];
  const targets: string[] = [];
  for (const call of rawData.contract) {
    if (!isRecord(call) || !isRecord(call.parameter) || !isRecord(call.parameter.value)) continue;
    const target = call.parameter.value.contract_address;
    if (typeof target === "string" && target.length > 0) targets.push(target);
  }
  return targets;
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

/**
 * A TRON envelope's kind, derived from the function selectors its contract
 * calls actually carry. An envelope is an approval only when EVERY call is an
 * ERC-20 `approve`; anything else moves value and must be treated as the
 * funding step so a host waits for approvals before broadcasting it.
 */
function tronStepKind(transaction: { [key: string]: JsonValue }): "approval" | "funding" {
  const rawData = transaction.raw_data;
  const calls = isRecord(rawData) && Array.isArray(rawData.contract) ? rawData.contract : [];
  const selectors = calls.map((call) => {
    const value = isRecord(call) && isRecord(call.parameter) ? call.parameter.value : null;
    const data = isRecord(value) && typeof value.data === "string" ? value.data : "";
    return stepKindFromCallData(data);
  });
  return selectors.length > 0 && selectors.every((kind) => kind === "approval")
    ? "approval"
    : "funding";
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
        PLUGIN_ID,
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
      const sourceAmount = amount(PLUGIN_ID, selected.srcAmount, "srcAmount");
      if (sourceAmount !== intent.inputAmountBaseUnits) {
        throw new RailPluginError(
          PLUGIN_ID,
          "QUOTE_AMOUNT_MISMATCH",
          "LayerZero changed the exact source amount.",
        );
      }
      const expectedOutput = amount(PLUGIN_ID, selected.dstAmount, "dstAmount");
      const minimumOutput = amount(PLUGIN_ID, selected.dstAmountMin, "dstAmountMin");
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
        expiresAt: expiresAt(PLUGIN_ID, selected.expiresAt),
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
      const steps = await Promise.all(
        upstreamSteps.map(async (step, index): Promise<WalletStep> => {
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
          const targets = readTronContractTargets(transaction);
          /*
           * An allowlist is optional hardening rather than a precondition.
           *
           * It was mandatory because USDT0 warns that Legacy Mesh contracts
           * migrate wholesale. That warning is aimed at integrators who hardcode
           * addresses in their own contracts; this adapter instead asks
           * LayerZero to build the transaction and then checks its structure.
           * Requiring an allowlist here while the structurally identical EVM
           * route needs none was an inconsistency, not a safety property.
           *
           * The structural checks above still stand: unsigned envelope,
           * TriggerSmartContract only, no TRX or TRC-10 movement, and a signer
           * that matches the intent. Supply a policy to additionally pin the
           * contract, which a production deployment should.
           */
          if (options.validateTronTransaction) {
            await options.validateTronTransaction({
              intent,
              quote,
              signerAddress: step.signerAddress,
              transaction,
            });
          }
          // Kind comes from the contract calls' selectors, never from the
          // optional upstream display text.
          const kind = tronStepKind(transaction);
          const summary =
            kind === "approval"
              ? "Allowance for the USDT0 bridge contract. No USDT moves in this step."
              : "Move canonical USDT from TRON to canonical USDT on Solana.";
          return {
            id: `layerzero-tron-${index + 1}`,
            kind,
            chainId: TRON_MAINNET_CHAIN_ID,
            label: description,
            description: targets.length ? `${summary} Calls ${targets.join(", ")}.` : summary,
            request: {
              namespace: "tron",
              chainId: TRON_MAINNET_CHAIN_ID,
              signerAddress: step.signerAddress,
              transaction,
            },
          };
        }),
      );
      assertApprovalOrdering(PLUGIN_ID, steps.map((step) => step.kind as "approval" | "funding"));
      return steps;
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
      const delivery = destinationReference(history, checkedAt, "solana", SOLANA_MAINNET_CHAIN_ID);
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
