import {
  RailPluginError,
  defineFundingProvider,
  type FundingIntent,
  type FundingQuote,
  type FundingQuoteDraft,
  type WalletStep,
} from "@hedgents/stablecoin-rail";
import {
  ROBINHOOD_MAINNET_CHAIN_ID,
  ROBINHOOD_NUMERIC_CHAIN_ID,
  ROBINHOOD_USDG,
  ROBINHOOD_USDG_ADDRESS,
  SOLANA_MAINNET_CHAIN_ID,
  SOLANA_USDG,
  SOLANA_USDG_MINT,
} from "./assets.js";
import { LayerZeroTransferApi } from "./http.js";
import {
  amount,
  assertApprovalOrdering,
  chooseQuote,
  destinationReference,
  etaSeconds,
  EVM_ADDRESS,
  expiresAt,
  isRecord,
  QUOTE_ID,
  sameAsset,
  SOLANA_ADDRESS,
  stepKindFromCallData,
} from "./shared.js";
import type { LayerZeroTransferApiOptions } from "./types.js";

const PLUGIN_ID = "layerzero-usdg-robinhood-solana";
const OPAQUE_SCHEMA = "hedgents.layerzero.usdg.robinhood-solana.v1";
const HEX = /^0x[0-9a-fA-F]*$/;

function fail(code: string, message: string): never {
  throw new RailPluginError(PLUGIN_ID, code, message);
}

function supportsRoute(intent: FundingIntent) {
  return (
    intent.source.account.chainId === ROBINHOOD_MAINNET_CHAIN_ID &&
    EVM_ADDRESS.test(intent.source.account.address) &&
    sameAsset(intent.source.asset, ROBINHOOD_USDG) &&
    intent.destination.account.chainId === SOLANA_MAINNET_CHAIN_ID &&
    SOLANA_ADDRESS.test(intent.destination.account.address) &&
    sameAsset(intent.destination.settlementAsset, SOLANA_USDG)
  );
}

function requirePinnedQuote(intent: FundingIntent, quote: FundingQuote) {
  if (!isRecord(quote.opaqueData)) {
    fail("INVALID_QUOTE_DATA", "The LayerZero USDG quote is missing its pinned data.");
  }
  const data = quote.opaqueData;
  const pins: Record<string, unknown> = {
    schema: OPAQUE_SCHEMA,
    quoteId: quote.id,
    sourceSigner: intent.source.account.address,
    destinationRecipient: intent.destination.account.address,
    sourceAmount: intent.inputAmountBaseUnits,
    sourceToken: ROBINHOOD_USDG_ADDRESS,
    destinationToken: SOLANA_USDG_MINT,
  };
  for (const [key, expected] of Object.entries(pins)) {
    if (data[key] !== expected) {
      fail("QUOTE_PIN_MISMATCH", `The prepared LayerZero USDG quote changed ${key}.`);
    }
  }
  if (!QUOTE_ID.test(quote.id)) {
    fail("INVALID_QUOTE_DATA", "The LayerZero quote ID is invalid.");
  }
  return data;
}

/**
 * Decode the EVM transaction LayerZero hands back for a Robinhood step.
 *
 * The upstream shape is not pinned by contract, so every field is checked
 * before it can reach a wallet: the target must be an address, the calldata
 * must be whole bytes, and the value must be zero. An OFT send of an ERC-20
 * never needs native currency, so a non-zero value means the payload is not
 * what we asked for.
 */
function decodeEvmTransaction(encoded: unknown) {
  if (!isRecord(encoded)) {
    fail("INVALID_UPSTREAM_RESPONSE", "LayerZero returned no structured EVM transaction.");
  }
  const to = encoded.to;
  const data = encoded.data;
  if (typeof to !== "string" || !EVM_ADDRESS.test(to)) {
    fail("INVALID_EVM_TRANSACTION", "LayerZero returned an EVM transaction without a valid target.");
  }
  if (typeof data !== "string" || !HEX.test(data) || data.length < 10) {
    fail("INVALID_EVM_TRANSACTION", "LayerZero returned malformed EVM call data.");
  }
  const rawValue = encoded.value;
  const value =
    rawValue == null || rawValue === "" ? 0n : BigInt(typeof rawValue === "number" ? String(rawValue) : String(rawValue));
  if (value !== 0n) {
    fail("UNEXPECTED_NATIVE_VALUE", "LayerZero asked to send native currency on an ERC-20 route.");
  }
  return { to: to as `0x${string}`, data: data as `0x${string}` };
}

/**
 * Canonical USDG on Robinhood Chain to canonical USDG on Solana, over
 * LayerZero's OFT mesh.
 *
 * Same stablecoin family on both ends and no swap step, so unlike the BNB
 * adapter this is a like-for-like transfer with no issuer change. Robinhood
 * Chain is an Arbitrum Orbit L2, so the source leg is an ordinary EVM
 * signature rather than TRON's structured envelope.
 */
export function createLayerZeroUsdgRobinhoodToSolana(options: LayerZeroTransferApiOptions) {
  const api = new LayerZeroTransferApi(options);

  return defineFundingProvider({
    manifest: {
      id: PLUGIN_ID,
      name: "LayerZero OFT (USDG)",
      version: "0.1.0",
      apiVersion: 1,
      kind: "funding-provider",
      homepage: "https://docs.layerzero.network/v2/developers/value-transfer-api",
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
            srcTokenAddress: ROBINHOOD_USDG_ADDRESS,
            dstTokenAddress: SOLANA_USDG_MINT,
          },
          context.signal,
        ),
        intent.inputAmountBaseUnits,
      );
      if (!selected) return null;

      const sourceAmount = amount(PLUGIN_ID, selected.srcAmount, "srcAmount");
      if (sourceAmount !== intent.inputAmountBaseUnits) {
        fail("QUOTE_AMOUNT_MISMATCH", "LayerZero changed the exact source amount.");
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
          sourceChainKey: "robinhood",
          destinationChainKey: "solana",
          sourceSigner: intent.source.account.address,
          destinationRecipient: intent.destination.account.address,
          sourceAmount,
          expectedOutput,
          minimumOutput,
          sourceToken: ROBINHOOD_USDG_ADDRESS,
          destinationToken: SOLANA_USDG_MINT,
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
        fail("EMPTY_USER_STEPS", "LayerZero returned no wallet steps.");
      }

      const steps = upstreamSteps.map((step, index): WalletStep => {
        if (step.type !== "TRANSACTION") {
          fail(
            "UNSUPPORTED_USER_STEP",
            "This route requires a signature format the USDG adapter does not support.",
          );
        }
        if (step.chainKey !== "robinhood" || step.chainType !== "EVM") {
          fail("UNEXPECTED_SOURCE_CHAIN", "LayerZero returned a wallet step outside Robinhood Chain.");
        }
        if (step.signerAddress.toLowerCase() !== intent.source.account.address.toLowerCase()) {
          fail("SIGNER_MISMATCH", "LayerZero returned a transaction for another signer.");
        }
        const description = step.description ?? "Send USDG to Solana";
        const { to, data } = decodeEvmTransaction(step.transaction.encoded);
        // Kind comes from the calldata, never from optional display text.
        const kind = stepKindFromCallData(data);
        if (kind === "approval" && to.toLowerCase() !== ROBINHOOD_USDG_ADDRESS.toLowerCase()) {
          fail("UNEXPECTED_APPROVAL_TARGET", "The approval does not target the USDG token contract.");
        }
        return {
          id: `layerzero-usdg-${index + 1}`,
          kind,
          chainId: ROBINHOOD_MAINNET_CHAIN_ID,
          label: description,
          description:
            kind === "approval"
              ? "Allowance for the USDG bridge contract. No USDG moves in this step."
              : "Move canonical USDG from Robinhood Chain to canonical USDG on Solana.",
          request: {
            namespace: "evm",
            chainId: ROBINHOOD_MAINNET_CHAIN_ID,
            numericChainId: ROBINHOOD_NUMERIC_CHAIN_ID,
            to,
            data,
            value: "0",
          },
        };
      });
      assertApprovalOrdering(PLUGIN_ID, steps.map((step) => step.kind as "approval" | "funding"));
      return steps;
    },

    getStatus: async ({ intent, quote, reference }, context) => {
      requirePinnedQuote(intent, quote);
      if (reference.chainId !== ROBINHOOD_MAINNET_CHAIN_ID) {
        fail("REFERENCE_CHAIN_MISMATCH", "The source reference must be a Robinhood Chain transaction.");
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
        // The status API does not prove the exact destination balance delta, so
        // the rail keeps its quoted-minimum fallback until a verifier supplies
        // the real figure.
        received: null,
        detail:
          state === "completed"
            ? "LayerZero reports canonical USDG delivered on Solana."
            : state === "refunded"
              ? "LayerZero reports the source transfer was refunded."
              : state === "failed"
                ? "LayerZero reports the transfer failed."
                : upstream.status === "SUCCEEDED"
                  ? "LayerZero reports success, but Solana delivery evidence is not indexed yet."
                  : "USDG is moving from Robinhood Chain to Solana.",
        checkedAt,
      };
    },
  });
}
