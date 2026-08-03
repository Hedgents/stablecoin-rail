import type { RailClient } from "./client.js";
import { errorDetails, RailError } from "./errors.js";
import type {
  DestinationActionStatus,
  FundingIntent,
  FundingStatus,
  IntentQuote,
  PreparationContext,
  QuoteBatch,
  TransactionReference,
  WalletStep,
} from "./types.js";

export type RailFlowPhase =
  | "idle"
  | "quoting"
  | "quote-ready"
  | "preparing-funding"
  | "awaiting-source-signature"
  | "funding-pending"
  | "destination-ready"
  | "preparing-action"
  | "awaiting-destination-signature"
  | "action-pending"
  | "completed"
  | "refunded"
  | "failed";

export interface RailFlowError {
  code: string;
  message: string;
}

export interface RailFlowSnapshot {
  revision: number;
  phase: RailFlowPhase;
  intent: FundingIntent | null;
  batch: QuoteBatch | null;
  selectedQuoteId: string | null;
  fundingSteps: WalletStep[];
  fundingReference: TransactionReference | null;
  fundingStatus: FundingStatus | null;
  actionSteps: WalletStep[];
  actionReference: TransactionReference | null;
  actionStatus: DestinationActionStatus | null;
  error: RailFlowError | null;
}

type Listener = () => void;

const INITIAL: RailFlowSnapshot = Object.freeze({
  revision: 0,
  phase: "idle",
  intent: null,
  batch: null,
  selectedQuoteId: null,
  fundingSteps: [],
  fundingReference: null,
  fundingStatus: null,
  actionSteps: [],
  actionReference: null,
  actionStatus: null,
  error: null,
});

export class RailFlow {
  private snapshot: RailFlowSnapshot = INITIAL;
  private readonly listeners = new Set<Listener>();
  private activeOperation = 0;
  private abortController: AbortController | null = null;

  constructor(private readonly client: RailClient) {}

  getSnapshot = () => this.snapshot;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get selectedQuote(): IntentQuote | null {
    const id = this.snapshot.selectedQuoteId;
    return id ? (this.snapshot.batch?.quotes.find((quote) => quote.id === id) ?? null) : null;
  }

  async quote(intent: FundingIntent) {
    const operation = this.beginOperation();
    this.update({
      phase: "quoting",
      intent,
      batch: null,
      selectedQuoteId: null,
      fundingSteps: [],
      fundingReference: null,
      fundingStatus: null,
      actionSteps: [],
      actionReference: null,
      actionStatus: null,
      error: null,
    });
    try {
      const batch = await this.client.quote(intent, { signal: operation.signal });
      if (!this.isCurrent(operation.id)) return this.snapshot;
      if (batch.quotes.length === 0) {
        throw new RailError("NO_ROUTES", "No complete funding and destination-action route is available.");
      }
      this.update({
        phase: "quote-ready",
        batch,
        selectedQuoteId: batch.quotes[0]?.id ?? null,
      });
      return this.snapshot;
    } catch (error) {
      return this.failOperation(operation.id, error);
    }
  }

  selectQuote(quoteId: string) {
    if (!this.snapshot.batch?.quotes.some((quote) => quote.id === quoteId)) {
      throw new RailError("QUOTE_NOT_FOUND", `Quote ${quoteId} is not part of the current batch.`);
    }
    if (this.snapshot.phase !== "quote-ready") {
      throw new RailError("INVALID_FLOW_PHASE", "A route can only be selected before funding begins.");
    }
    this.update({ selectedQuoteId: quoteId, error: null });
    return this.snapshot;
  }

  async prepareFunding(preparation?: PreparationContext) {
    const quote = this.requireSelectedQuote();
    if (this.snapshot.phase !== "quote-ready") {
      throw new RailError("INVALID_FLOW_PHASE", "Funding can only be prepared from a fresh quote.");
    }
    const operation = this.beginOperation();
    this.update({ phase: "preparing-funding", error: null });
    try {
      const steps = await this.client.prepareFunding(quote, preparation, {
        signal: operation.signal,
      });
      if (!this.isCurrent(operation.id)) return this.snapshot;
      this.update({ phase: "awaiting-source-signature", fundingSteps: steps });
      return this.snapshot;
    } catch (error) {
      return this.failOperation(operation.id, error);
    }
  }

  markFundingSubmitted(reference: TransactionReference) {
    if (this.snapshot.phase !== "awaiting-source-signature") {
      throw new RailError("INVALID_FLOW_PHASE", "The flow is not waiting for a funding signature.");
    }
    this.update({ phase: "funding-pending", fundingReference: reference, error: null });
    return this.snapshot;
  }

  async refreshFunding() {
    const quote = this.requireSelectedQuote();
    const reference = this.snapshot.fundingReference;
    if (!reference || this.snapshot.phase !== "funding-pending") {
      throw new RailError("INVALID_FLOW_PHASE", "No pending funding transaction can be checked.");
    }
    const operation = this.beginOperation();
    try {
      const status = await this.client.getFundingStatus(quote, reference, {
        signal: operation.signal,
      });
      if (!this.isCurrent(operation.id)) return this.snapshot;
      this.update({
        phase:
          status.state === "completed"
            ? "destination-ready"
            : status.state === "refunded"
              ? "refunded"
              : status.state === "failed"
                ? "failed"
                : "funding-pending",
        fundingStatus: status,
        error:
          status.state === "failed"
            ? { code: "FUNDING_FAILED", message: status.detail }
            : null,
      });
      return this.snapshot;
    } catch (error) {
      return this.failOperation(operation.id, error);
    }
  }

  async prepareAction(preparation?: PreparationContext) {
    const selectedQuote = this.requireSelectedQuote();
    if (this.snapshot.phase !== "destination-ready") {
      throw new RailError("INVALID_FLOW_PHASE", "The destination action requires confirmed funding.");
    }
    const operation = this.beginOperation();
    this.update({ phase: "preparing-action", error: null });
    try {
      const quote = await this.client.refreshActionQuote(
        selectedQuote,
        this.snapshot.fundingStatus?.received,
        { signal: operation.signal },
      );
      if (!this.isCurrent(operation.id)) return this.snapshot;
      this.replaceSelectedQuote(quote);
      const steps = await this.client.prepareAction(quote, preparation, {
        signal: operation.signal,
      });
      if (!this.isCurrent(operation.id)) return this.snapshot;
      this.update({ phase: "awaiting-destination-signature", actionSteps: steps });
      return this.snapshot;
    } catch (error) {
      return this.failOperation(operation.id, error);
    }
  }

  markActionSubmitted(reference: TransactionReference) {
    if (this.snapshot.phase !== "awaiting-destination-signature") {
      throw new RailError("INVALID_FLOW_PHASE", "The flow is not waiting for a destination signature.");
    }
    this.update({ phase: "action-pending", actionReference: reference, error: null });
    return this.snapshot;
  }

  async refreshAction() {
    const quote = this.requireSelectedQuote();
    const reference = this.snapshot.actionReference;
    if (!reference || this.snapshot.phase !== "action-pending") {
      throw new RailError("INVALID_FLOW_PHASE", "No pending destination action can be checked.");
    }
    const operation = this.beginOperation();
    try {
      const status = await this.client.getActionStatus(quote, reference, {
        signal: operation.signal,
      });
      if (!this.isCurrent(operation.id)) return this.snapshot;
      this.update({
        phase: status.state === "completed" ? "completed" : status.state === "failed" ? "failed" : "action-pending",
        actionStatus: status,
        error:
          status.state === "failed"
            ? { code: "ACTION_FAILED", message: status.detail }
            : null,
      });
      return this.snapshot;
    } catch (error) {
      return this.failOperation(operation.id, error);
    }
  }

  completeAction(status: DestinationActionStatus) {
    if (this.snapshot.phase !== "action-pending") {
      throw new RailError("INVALID_FLOW_PHASE", "The destination action is not awaiting verification.");
    }
    if (status.state !== "completed") {
      throw new RailError("ACTION_NOT_CONFIRMED", "Completion requires a verified completed status.");
    }
    if (
      !this.snapshot.actionReference ||
      status.reference.chainId !== this.snapshot.actionReference.chainId ||
      status.reference.txId !== this.snapshot.actionReference.txId
    ) {
      throw new RailError("STATUS_REFERENCE_MISMATCH", "Completion refers to another action transaction.");
    }
    this.update({ phase: "completed", actionStatus: status, error: null });
    return this.snapshot;
  }

  reset() {
    this.cancelActiveOperation();
    this.snapshot = Object.freeze({ ...INITIAL, revision: this.snapshot.revision + 1 });
    this.emit();
    return this.snapshot;
  }

  dispose() {
    this.cancelActiveOperation();
    this.listeners.clear();
  }

  private requireSelectedQuote() {
    const quote = this.selectedQuote;
    if (!quote) throw new RailError("QUOTE_NOT_SELECTED", "Select an end-to-end quote first.");
    return quote;
  }

  private replaceSelectedQuote(quote: IntentQuote) {
    const batch = this.snapshot.batch;
    if (!batch) throw new RailError("QUOTE_NOT_SELECTED", "No quote batch can be refreshed.");
    this.update({
      batch: {
        ...batch,
        quotes: batch.quotes.map((candidate) =>
          candidate.id === this.snapshot.selectedQuoteId ? quote : candidate,
        ),
      },
      selectedQuoteId: quote.id,
    });
  }

  private beginOperation() {
    this.abortController?.abort();
    this.abortController = new AbortController();
    return { id: ++this.activeOperation, signal: this.abortController.signal };
  }

  private cancelActiveOperation() {
    this.abortController?.abort();
    this.abortController = null;
    this.activeOperation += 1;
  }

  private isCurrent(operation: number) {
    return operation === this.activeOperation;
  }

  private failOperation(operation: number, error: unknown) {
    if (!this.isCurrent(operation)) return this.snapshot;
    const detail = errorDetails(error);
    this.update({ phase: "failed", error: detail });
    return this.snapshot;
  }

  private update(patch: Partial<RailFlowSnapshot>) {
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    });
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
