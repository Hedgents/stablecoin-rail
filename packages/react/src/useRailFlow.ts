import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  DestinationActionStatus,
  FundingIntent,
  PersistedRailFlow,
  PreparationContext,
  RailClient,
  RailFlow,
  TransactionReference,
} from "@hedgents/stablecoin-rail";

export interface UseRailFlowOptions {
  /**
   * A previously serialized flow to resume. Read once on mount, so a changing
   * value can never silently replace a live flow.
   *
   * Hydration revalidates the snapshot and drops any unsigned wallet steps, so
   * a resumed flow must prepare again before asking for a signature.
   */
  persisted?: PersistedRailFlow | null;
}

/**
 * Where a rebuilt flow's state comes from. When a live flow exists, its OWN
 * serialized state wins over the mount-time blob: resurrecting the original
 * snapshot would rewind past progress the user already made (including a
 * submitted funding transaction) and re-arm the phase guards protecting it.
 *
 * The rebuilt flow follows the restore contract: money-bearing phases survive
 * with their references, post-settlement phases return to `destination-ready`,
 * quote-only phases degrade to `quote-ready` or `idle`. If the new client no
 * longer registers a plugin the live flow uses, this throws rather than
 * silently dropping the flow.
 *
 * Exported for tests; not part of the package's public surface.
 */
export function rebuildFlow(
  client: RailClient,
  live: RailFlow | null,
  initial: PersistedRailFlow | null,
): RailFlow {
  const persisted = live ? live.serialize() : initial;
  return persisted ? client.hydrateFlow(persisted) : client.createFlow();
}

export function useRailFlow(client: RailClient, options?: UseRailFlowOptions) {
  const initial = useRef(options?.persisted ?? null);
  const live = useRef<RailFlow | null>(null);
  const lastClient = useRef<RailClient | null>(null);
  const flow = useMemo(() => {
    // Pass a memoized client to avoid rebuilds entirely. (StrictMode
    // re-invokes this with the same client, which is why the warning checks
    // identity.)
    if (live.current && lastClient.current !== client && typeof console !== "undefined") {
      console.warn(
        "useRailFlow: the RailClient identity changed, so the flow was rebuilt from its live state. Memoize the client to avoid this.",
      );
    }
    lastClient.current = client;
    const next = rebuildFlow(client, live.current, initial.current);
    live.current = next;
    return next;
  }, [client]);
  const snapshot = useSyncExternalStore(flow.subscribe, flow.getSnapshot, flow.getSnapshot);

  useEffect(() => () => flow.dispose(), [flow]);

  const quote = useCallback((intent: FundingIntent) => flow.quote(intent), [flow]);
  const selectQuote = useCallback((quoteId: string) => flow.selectQuote(quoteId), [flow]);
  const prepareFunding = useCallback(
    (preparation?: PreparationContext) => flow.prepareFunding(preparation),
    [flow],
  );
  const markFundingSubmitted = useCallback(
    (reference: TransactionReference) => flow.markFundingSubmitted(reference),
    [flow],
  );
  const refreshFunding = useCallback(() => flow.refreshFunding(), [flow]);
  const prepareAction = useCallback(
    (preparation?: PreparationContext) => flow.prepareAction(preparation),
    [flow],
  );
  const markActionSubmitted = useCallback(
    (reference: TransactionReference) => flow.markActionSubmitted(reference),
    [flow],
  );
  const refreshAction = useCallback(() => flow.refreshAction(), [flow]);
  const completeAction = useCallback(
    (status: DestinationActionStatus) => flow.completeAction(status),
    [flow],
  );
  const serialize = useCallback(() => flow.serialize(), [flow]);
  const reset = useCallback(() => flow.reset(), [flow]);

  return {
    flow,
    snapshot,
    selectedQuote: flow.selectedQuote,
    quote,
    selectQuote,
    prepareFunding,
    markFundingSubmitted,
    refreshFunding,
    prepareAction,
    markActionSubmitted,
    refreshAction,
    completeAction,
    serialize,
    reset,
  };
}
