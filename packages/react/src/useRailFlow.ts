import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type {
  DestinationActionStatus,
  FundingIntent,
  PersistedRailFlow,
  PreparationContext,
  RailClient,
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

export function useRailFlow(client: RailClient, options?: UseRailFlowOptions) {
  const initial = useRef(options?.persisted ?? null);
  const flow = useMemo(
    () => (initial.current ? client.hydrateFlow(initial.current) : client.createFlow()),
    [client],
  );
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
