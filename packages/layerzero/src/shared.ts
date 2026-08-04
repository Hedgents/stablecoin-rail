import {
  RailPluginError,
  type AssetDescriptor,
  type TransactionReference,
} from "@hedgents/stablecoin-rail";
import type { LayerZeroExecutionEvent, LayerZeroQuote } from "./types.js";

/**
 * Route-agnostic pieces of a LayerZero transfer.
 *
 * Every route quotes, ranks, and detects delivery the same way; only the
 * source-chain signing envelope differs. Keeping this shared means a fix to
 * quote selection or delivery detection cannot land on one route and silently
 * miss another.
 */

export const QUOTE_ID = /^0x[0-9a-fA-F]{64}$/;
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
export const INTEGER = /^\d+$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sameAsset(left: AssetDescriptor, right: AssetDescriptor) {
  return (
    left.chainId === right.chainId &&
    left.assetId === right.assetId &&
    left.decimals === right.decimals
  );
}

export function amount(pluginId: string, value: unknown, field: string) {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !INTEGER.test(text) || BigInt(text) <= 0n) {
    throw new RailPluginError(pluginId, "INVALID_UPSTREAM_RESPONSE", `${field} is invalid.`);
  }
  return text;
}

export function expiresAt(pluginId: string, value: unknown) {
  if (typeof value !== "string") {
    throw new RailPluginError(pluginId, "INVALID_UPSTREAM_RESPONSE", "Quote expiry is missing.");
  }
  const numeric = INTEGER.test(value) ? Number(value) : Number.NaN;
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RailPluginError(pluginId, "INVALID_UPSTREAM_RESPONSE", "Quote expiry is invalid.");
  }
  return new Date(timestamp).toISOString();
}

export function etaSeconds(quote: LayerZeroQuote) {
  const raw = quote.duration?.estimated;
  if (raw == null) return 0;
  const milliseconds = Number(raw);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds / 1_000) : 0;
}

/**
 * Best quote that keeps the stablecoin family intact.
 *
 * A `SWAP` step means the provider would convert the token on the way, which
 * the rail refuses by default: the user asked to move a stablecoin, not to
 * trade it. The exact source amount must also survive untouched.
 *
 * Every route this module serves is a like-for-like transfer of the same
 * token with the same decimals on both ends, so an honest quote can never
 * promise MORE out than in: fees only subtract. An output above the input is
 * a units bug or a tampered response, and because ranking sorts by
 * `dstAmountMin` descending, such a quote would otherwise always win. It is
 * rejected instead.
 */
export function chooseQuote(
  pluginId: string,
  quotes: LayerZeroQuote[],
  exactSourceAmount: string,
): LayerZeroQuote | null {
  const source = BigInt(exactSourceAmount);
  const valid = quotes.filter((quote) => {
    try {
      const destination = BigInt(amount(pluginId, quote.dstAmount, "dstAmount"));
      const destinationMinimum = BigInt(amount(pluginId, quote.dstAmountMin, "dstAmountMin"));
      return (
        QUOTE_ID.test(quote.id) &&
        amount(pluginId, quote.srcAmount, "srcAmount") === exactSourceAmount &&
        destination >= destinationMinimum &&
        destination <= source &&
        !(quote.routeSteps ?? []).some((step) => step.type === "SWAP")
      );
    } catch {
      return false;
    }
  });
  valid.sort((left, right) => {
    const leftMinimum = BigInt(amount(pluginId, left.dstAmountMin, "dstAmountMin"));
    const rightMinimum = BigInt(amount(pluginId, right.dstAmountMin, "dstAmountMin"));
    if (leftMinimum !== rightMinimum) return leftMinimum > rightMinimum ? -1 : 1;
    return etaSeconds(left) - etaSeconds(right);
  });
  return valid[0] ?? null;
}

/** ERC-20 `approve(address,uint256)`, the first 4 selector bytes in hex. */
export const APPROVE_SELECTOR = "095ea7b3";

/**
 * Wallet-step kind derived from what the calldata DOES.
 *
 * The upstream `description` is optional display text and a rewording must
 * never change execution semantics: `kind` is what tells a host to wait for
 * the approval receipt before broadcasting the spend, so it is read from the
 * function selector instead.
 */
export function stepKindFromCallData(data: string): "approval" | "funding" {
  return data.replace(/^0x/, "").slice(0, 8).toLowerCase() === APPROVE_SELECTOR
    ? "approval"
    : "funding";
}

/**
 * Steps are an ordered, dependent sequence: every approval must precede the
 * spend it authorizes. An approval arriving after a funding step means the
 * upstream response cannot be executed in order, which is a fail-closed stop
 * rather than something to silently reorder.
 */
export function assertApprovalOrdering(pluginId: string, kinds: Array<"approval" | "funding">) {
  const firstFunding = kinds.indexOf("funding");
  if (firstFunding !== -1 && kinds.slice(firstFunding).includes("approval")) {
    throw new RailPluginError(
      pluginId,
      "INVALID_STEP_ORDER",
      "LayerZero returned an approval step after the funding step.",
    );
  }
}

function submittedAt(event: LayerZeroExecutionEvent, fallback: string) {
  const value = event.transaction.timestamp;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  return new Date(milliseconds).toISOString();
}

/**
 * The destination transaction, once the provider has actually delivered.
 *
 * A `SUCCEEDED` status alone is not delivery evidence, so completion is only
 * reported when a DELIVERED event names a transaction on the destination.
 */
export function destinationReference(
  history: LayerZeroExecutionEvent[],
  checkedAt: string,
  destinationChainKey: string,
  destinationChainId: string,
): TransactionReference | null {
  const delivered = [...history]
    .reverse()
    .find(
      (event) => event.event === "DELIVERED" && event.transaction.chainKey === destinationChainKey,
    );
  if (!delivered || delivered.transaction.hash.length === 0) return null;
  return {
    chainId: destinationChainId,
    txId: delivered.transaction.hash,
    submittedAt: submittedAt(delivered, checkedAt),
  };
}
