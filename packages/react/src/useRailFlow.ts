import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  DestinationActionStatus,
  FundingIntent,
  PreparationContext,
  RailClient,
  TransactionReference,
} from "@hedgents/stablecoin-rail";

export function useRailFlow(client: RailClient) {
  const flow = useMemo(() => client.createFlow(), [client]);
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
    reset,
  };
}
