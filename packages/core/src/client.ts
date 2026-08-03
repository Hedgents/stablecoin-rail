import { errorDetails, RailError } from "./errors.js";
import { restoreSnapshot, type PersistedRailFlow } from "./persistence.js";
import type {
  DestinationActionPlugin,
  DestinationActionQuote,
  AssetAmount,
  FundingIntent,
  FundingProviderPlugin,
  FundingQuote,
  IntentQuote,
  PluginContext,
  PreparationContext,
  QuoteBatch,
  QuoteFailure,
  RailCallOptions,
  RailClientOptions,
  TransactionReference,
} from "./types.js";
import {
  assertQuoteFresh,
  parseAmount,
  sameAsset,
  validateActionQuote,
  validateActionStatus,
  validateFundingQuote,
  validateFundingStatus,
  validateIntent,
  validateManifest,
  validateReference,
  validateWalletSteps,
} from "./validation.js";

function context(now: () => number, options?: RailCallOptions): PluginContext {
  return options?.signal ? { now, signal: options.signal } : { now };
}

function quoteFailure(
  pluginId: string,
  stage: QuoteFailure["stage"],
  error: unknown,
): QuoteFailure {
  const detail = errorDetails(error);
  return { pluginId, stage, code: detail.code, message: detail.message };
}

/**
 * Routes are ranked by the outcome the user actually receives: the destination
 * action's guaranteed output when there is one, and the guaranteed settlement
 * output otherwise. Action presence is a property of the intent, so every quote
 * in a batch has the same shape and mixed-shape ranking cannot occur.
 */
function rankingAmount(quote: IntentQuote): AssetAmount {
  return quote.action?.minimumOutput ?? quote.funding.minimumOutput;
}

function compareQuotes(left: IntentQuote, right: IntentQuote) {
  const leftOutput = parseAmount(rankingAmount(left).amountBaseUnits);
  const rightOutput = parseAmount(rankingAmount(right).amountBaseUnits);
  if (leftOutput !== rightOutput) return leftOutput > rightOutput ? -1 : 1;
  if (left.totalEtaSeconds !== right.totalEtaSeconds) {
    return left.totalEtaSeconds - right.totalEtaSeconds;
  }
  return left.id.localeCompare(right.id);
}

export class RailClient {
  readonly fundingProviders: ReadonlyMap<string, FundingProviderPlugin>;
  readonly destinationActions: ReadonlyMap<string, DestinationActionPlugin>;
  /** Injectable clock, public so a flow can timestamp its serialized form. */
  readonly now: () => number;

  constructor(options: RailClientOptions) {
    this.now = options.now ?? Date.now;
    const fundingProviders = new Map<string, FundingProviderPlugin>();
    const destinationActions = new Map<string, DestinationActionPlugin>();

    for (const plugin of options.fundingProviders) {
      validateManifest(plugin.manifest, "funding-provider");
      if (fundingProviders.has(plugin.manifest.id)) {
        throw new RailError("DUPLICATE_PLUGIN", `Funding provider ${plugin.manifest.id} is duplicated.`);
      }
      fundingProviders.set(plugin.manifest.id, plugin);
    }
    for (const plugin of options.destinationActions ?? []) {
      validateManifest(plugin.manifest, "destination-action");
      if (destinationActions.has(plugin.manifest.id)) {
        throw new RailError("DUPLICATE_PLUGIN", `Destination action ${plugin.manifest.id} is duplicated.`);
      }
      destinationActions.set(plugin.manifest.id, plugin);
    }
    if (fundingProviders.size === 0) {
      throw new RailError("NO_FUNDING_PROVIDERS", "Register at least one funding provider.");
    }

    this.fundingProviders = fundingProviders;
    this.destinationActions = destinationActions;
  }

  async quote(intent: FundingIntent, options?: RailCallOptions): Promise<QuoteBatch> {
    validateIntent(intent);
    const actionRequest = intent.action;
    const actionPlugin = actionRequest
      ? this.destinationActions.get(actionRequest.pluginId)
      : undefined;
    if (actionRequest && !actionPlugin) {
      throw new RailError(
        "ACTION_PLUGIN_NOT_FOUND",
        `Destination action ${actionRequest.pluginId} is not registered.`,
      );
    }

    const quotedAtMs = this.now();
    const pluginContext = context(this.now, options);
    const outcomes = await Promise.all(
      [...this.fundingProviders.values()].map(async (provider) => {
        try {
          if (!(await provider.supports(intent))) return { quote: null, failure: null };
        } catch (error) {
          return {
            quote: null,
            failure: quoteFailure(provider.manifest.id, "supports", error),
          };
        }

        let draft;
        try {
          draft = await provider.quote(intent, pluginContext);
          if (!draft) return { quote: null, failure: null };
          validateFundingQuote(draft, intent, quotedAtMs);
        } catch (error) {
          return {
            quote: null,
            failure: quoteFailure(provider.manifest.id, "funding-quote", error),
          };
        }

        const funding: FundingQuote = {
          ...draft,
          providerId: provider.manifest.id,
          providerName: provider.manifest.name,
        };

        if (!actionPlugin) {
          const quote: IntentQuote = {
            id: `${provider.manifest.id}:${draft.id}`,
            intent,
            funding,
            action: null,
            expiresAt: funding.expiresAt,
            totalEtaSeconds: funding.etaSeconds,
          };
          return { quote, failure: null };
        }

        try {
          if (!(await actionPlugin.supports({ intent, fundingQuote: funding }))) {
            return {
              quote: null,
              failure: {
                pluginId: actionPlugin.manifest.id,
                stage: "supports" as const,
                code: "UNSUPPORTED_ACTION",
                message: "The destination action does not support this funding route.",
              },
            };
          }
          const actionDraft = await actionPlugin.quote(
            { intent, fundingQuote: funding },
            pluginContext,
          );
          if (!actionDraft) {
            return {
              quote: null,
              failure: {
                pluginId: actionPlugin.manifest.id,
                stage: "action-quote" as const,
                code: "NO_ACTION_QUOTE",
                message: "The destination action returned no executable quote.",
              },
            };
          }
          validateActionQuote(actionDraft, funding, quotedAtMs);
          const action: DestinationActionQuote = {
            ...actionDraft,
            pluginId: actionPlugin.manifest.id,
            pluginName: actionPlugin.manifest.name,
          };
          const quote: IntentQuote = {
            id: `${provider.manifest.id}:${draft.id}:${actionPlugin.manifest.id}:${actionDraft.id}`,
            intent,
            funding,
            action,
            expiresAt: new Date(
              Math.min(Date.parse(funding.expiresAt), Date.parse(action.expiresAt)),
            ).toISOString(),
            totalEtaSeconds: funding.etaSeconds,
          };
          return { quote, failure: null };
        } catch (error) {
          return {
            quote: null,
            failure: quoteFailure(actionPlugin.manifest.id, "action-quote", error),
          };
        }
      }),
    );

    const quotes = outcomes.flatMap((outcome) => (outcome.quote ? [outcome.quote] : []));
    const failures = outcomes.flatMap((outcome) => (outcome.failure ? [outcome.failure] : []));
    const first = quotes[0];
    const referenceAsset = first ? rankingAmount(first).asset : null;
    const validQuotes: IntentQuote[] = [];
    for (const quote of quotes) {
      if (referenceAsset && !sameAsset(referenceAsset, rankingAmount(quote).asset)) {
        failures.push({
          pluginId: quote.action?.pluginId ?? quote.funding.providerId,
          stage: "validation",
          code: "INCOMPARABLE_OUTPUT",
          message: "The action returned an output asset that cannot be ranked with the other routes.",
        });
      } else {
        validQuotes.push(quote);
      }
    }

    return {
      intentId: intent.id,
      quotedAt: new Date(quotedAtMs).toISOString(),
      quotes: validQuotes.sort(compareQuotes),
      failures,
    };
  }

  async prepareFunding(
    quote: IntentQuote,
    preparation?: PreparationContext,
    options?: RailCallOptions,
  ) {
    assertQuoteFresh(quote.expiresAt, this.now());
    const provider = this.requireFundingProvider(quote.funding.providerId);
    const request = preparation
      ? { intent: quote.intent, quote: quote.funding, preparation }
      : { intent: quote.intent, quote: quote.funding };
    const steps = await provider.prepare(request, context(this.now, options));
    validateWalletSteps(steps);
    return steps;
  }

  async getFundingStatus(
    quote: IntentQuote,
    reference: TransactionReference,
    options?: RailCallOptions,
  ) {
    validateReference(reference);
    const provider = this.requireFundingProvider(quote.funding.providerId);
    const status = await provider.getStatus(
      { intent: quote.intent, quote: quote.funding, reference },
      context(this.now, options),
    );
    validateFundingStatus(status, reference, quote.intent.destination.settlementAsset);
    return status;
  }

  async refreshActionQuote(
    quote: IntentQuote,
    received?: AssetAmount | null,
    options?: RailCallOptions,
  ): Promise<IntentQuote> {
    const action = this.requireDestinationAction(this.requireActionQuote(quote).pluginId);
    if (received && !sameAsset(received.asset, quote.funding.minimumOutput.asset)) {
      throw new RailError(
        "STATUS_ASSET_MISMATCH",
        "The settled funding asset cannot be used by the destination action.",
      );
    }
    const funding: FundingQuote = received
      ? {
          ...quote.funding,
          expectedOutput: received,
          minimumOutput: received,
        }
      : quote.funding;
    if (!(await action.supports({ intent: quote.intent, fundingQuote: funding }))) {
      throw new RailError(
        "UNSUPPORTED_ACTION",
        "The destination action no longer supports the settled funding route.",
      );
    }
    const draft = await action.quote(
      { intent: quote.intent, fundingQuote: funding },
      context(this.now, options),
    );
    if (!draft) {
      throw new RailError("NO_ACTION_QUOTE", "The destination action returned no fresh quote.");
    }
    validateActionQuote(draft, funding, this.now());
    const actionQuote: DestinationActionQuote = {
      ...draft,
      pluginId: action.manifest.id,
      pluginName: action.manifest.name,
    };
    return {
      ...quote,
      id: `${funding.providerId}:${funding.id}:${action.manifest.id}:${draft.id}`,
      funding,
      action: actionQuote,
      expiresAt: draft.expiresAt,
    };
  }

  async prepareAction(
    quote: IntentQuote,
    preparation?: PreparationContext,
    options?: RailCallOptions,
  ) {
    const actionQuote = this.requireActionQuote(quote);
    assertQuoteFresh(quote.expiresAt, this.now());
    const action = this.requireDestinationAction(actionQuote.pluginId);
    const request = preparation
      ? {
          intent: quote.intent,
          fundingQuote: quote.funding,
          actionQuote,
          preparation,
        }
      : {
          intent: quote.intent,
          fundingQuote: quote.funding,
          actionQuote,
        };
    const steps = await action.prepare(request, context(this.now, options));
    validateWalletSteps(steps);
    return steps;
  }

  async getActionStatus(
    quote: IntentQuote,
    reference: TransactionReference,
    options?: RailCallOptions,
  ) {
    const actionQuote = this.requireActionQuote(quote);
    validateReference(reference);
    const action = this.requireDestinationAction(actionQuote.pluginId);
    if (!action.getStatus) {
      throw new RailError(
        "ACTION_STATUS_UNSUPPORTED",
        `Destination action ${action.manifest.id} does not expose status verification.`,
      );
    }
    const status = await action.getStatus(
      {
        intent: quote.intent,
        fundingQuote: quote.funding,
        actionQuote,
        reference,
      },
      context(this.now, options),
    );
    validateActionStatus(status, reference, actionQuote.minimumOutput.asset);
    return status;
  }

  createFlow() {
    return new RailFlow(this);
  }

  /**
   * Rebuild a flow from storage. Fails closed on an unknown version, a
   * malformed snapshot, or a plugin that is no longer registered. Wallet steps
   * are never restored; the caller prepares again.
   */
  hydrateFlow(persisted: PersistedRailFlow) {
    const snapshot = restoreSnapshot(
      persisted,
      {
        hasFundingProvider: (id) => this.fundingProviders.has(id),
        hasDestinationAction: (id) => this.destinationActions.has(id),
      },
      this.now(),
      INITIAL_SNAPSHOT,
    );
    return new RailFlow(this, snapshot);
  }

  private requireFundingProvider(id: string) {
    const plugin = this.fundingProviders.get(id);
    if (!plugin) throw new RailError("FUNDING_PLUGIN_NOT_FOUND", `Funding provider ${id} is missing.`);
    return plugin;
  }

  private requireActionQuote(quote: IntentQuote): DestinationActionQuote {
    if (!quote.action) {
      throw new RailError("ACTION_NOT_CONFIGURED", "This quote has no destination action.");
    }
    return quote.action;
  }

  private requireDestinationAction(id: string) {
    const plugin = this.destinationActions.get(id);
    if (!plugin) throw new RailError("ACTION_PLUGIN_NOT_FOUND", `Destination action ${id} is missing.`);
    return plugin;
  }
}

// Imported at the bottom on purpose: flow.ts imports RailClient as a type, and
// hoisting this to the top reintroduces a value-level import cycle.
import { INITIAL_SNAPSHOT, RailFlow } from "./flow.js";
