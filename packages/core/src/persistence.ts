import { RailError } from "./errors.js";
import type { RailFlowPhase, RailFlowSnapshot } from "./flow.js";
import type { IntentQuote } from "./types.js";

/**
 * A serialized flow. The host owns storage: localStorage, IndexedDB, or a
 * server row are all fine. The rail owns the shape and the rules for what may
 * safely be restored.
 */
export interface PersistedRailFlow {
  version: 1;
  persistedAt: string;
  snapshot: RailFlowSnapshot;
}

/**
 * Phases where a real on-chain reference exists, or where the outcome is
 * already decided. These restore as they were.
 */
const RESUMABLE = new Set<RailFlowPhase>([
  "funding-pending",
  "destination-ready",
  "action-pending",
  "completed",
  "refunded",
  "failed",
]);

/**
 * Phases holding nothing but a quote and, at most, unsigned wallet steps.
 * They fall back to a re-quotable state while the quote is still fresh.
 */
const DEGRADES_TO_QUOTE_READY = new Set<RailFlowPhase>([
  "quote-ready",
  "preparing-funding",
  "awaiting-source-signature",
]);

/**
 * Phases reached only AFTER funding settled on mainnet. The funding evidence
 * is the record that real money already moved, so it must survive a restore;
 * only the unsigned destination-action steps are safely droppable. Rewinding
 * these any further would re-arm funding for a transfer the user already paid.
 */
const DEGRADES_TO_DESTINATION_READY = new Set<RailFlowPhase>([
  "preparing-action",
  "awaiting-destination-signature",
]);

export interface PluginRegistry {
  hasFundingProvider(id: string): boolean;
  hasDestinationAction(id: string): boolean;
}

function invalid(message: string): never {
  throw new RailError("INVALID_PERSISTED_SNAPSHOT", message);
}

function selectedQuote(snapshot: RailFlowSnapshot): IntentQuote {
  const quote = snapshot.batch?.quotes.find(
    (candidate) => candidate.id === snapshot.selectedQuoteId,
  );
  if (!quote) invalid("The persisted snapshot has no resolvable selected quote.");
  return quote;
}

export function restoreSnapshot(
  persisted: PersistedRailFlow,
  registry: PluginRegistry,
  now: number,
  initial: RailFlowSnapshot,
): RailFlowSnapshot {
  if (!persisted || persisted.version !== 1) {
    throw new RailError(
      "UNSUPPORTED_PERSISTED_VERSION",
      "This persisted rail flow was written by an incompatible version.",
    );
  }
  const snapshot = persisted.snapshot;
  if (!snapshot || typeof snapshot.phase !== "string") {
    invalid("The persisted snapshot is malformed.");
  }
  const revision = Number.isSafeInteger(snapshot.revision) ? snapshot.revision : 0;
  const bare: RailFlowSnapshot = { ...initial, revision };

  if (snapshot.phase === "idle") return Object.freeze(bare);

  // A flow serialized mid-`quoting`, or after a quote() that failed, holds no
  // selected quote. That is a legitimate serialize() output, and nothing
  // on-chain can exist without a quote, so it restores as a fresh flow. A
  // snapshot claiming funding happened without a resolvable quote is corrupt.
  if (!snapshot.batch || !snapshot.selectedQuoteId) {
    if (snapshot.fundingReference || snapshot.fundingStatus) {
      invalid("The persisted snapshot claims funding without a resolvable quote.");
    }
    return Object.freeze(bare);
  }

  const quote = selectedQuote(snapshot);
  if (!registry.hasFundingProvider(quote.funding.providerId)) {
    throw new RailError(
      "FUNDING_PLUGIN_NOT_FOUND",
      `Funding provider ${quote.funding.providerId} is missing.`,
    );
  }
  if (quote.action && !registry.hasDestinationAction(quote.action.pluginId)) {
    throw new RailError(
      "ACTION_PLUGIN_NOT_FOUND",
      `Destination action ${quote.action.pluginId} is missing.`,
    );
  }

  // Unsigned wallet steps carry stale Solana blockhashes and TRON reference
  // blocks. Restoring one would let a user sign an expired request, so they are
  // always dropped and the caller must prepare again.
  const withoutSteps: RailFlowSnapshot = {
    ...snapshot,
    revision,
    fundingSteps: [],
    actionSteps: [],
  };

  if (RESUMABLE.has(snapshot.phase)) return Object.freeze(withoutSteps);

  if (DEGRADES_TO_DESTINATION_READY.has(snapshot.phase)) {
    // A snapshot claiming a post-settlement phase without funding evidence is
    // corrupt. Restoring it as pre-funding would invite a second payment, so
    // refuse it instead.
    if (!snapshot.fundingReference || !snapshot.fundingStatus) {
      invalid("A post-settlement phase was persisted without its funding evidence.");
    }
    return Object.freeze({
      ...withoutSteps,
      phase: "destination-ready" as const,
      actionReference: null,
      actionStatus: null,
      error: null,
    });
  }

  if (DEGRADES_TO_QUOTE_READY.has(snapshot.phase) && Date.parse(quote.expiresAt) > now) {
    return Object.freeze({
      ...withoutSteps,
      phase: "quote-ready",
      fundingReference: null,
      fundingStatus: null,
      actionReference: null,
      actionStatus: null,
      error: null,
    });
  }

  return Object.freeze(bare);
}
