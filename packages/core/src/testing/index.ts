import { RailError } from "../errors.js";
import type {
  DestinationActionPlugin,
  FundingIntent,
  FundingProviderPlugin,
  FundingQuote,
  PluginContext,
} from "../types.js";
import {
  parseAmount,
  validateActionQuote,
  validateFundingQuote,
  validateManifest,
  validateWalletSteps,
} from "../validation.js";

/**
 * One contract assertion. Runner-agnostic on purpose: provider authors should
 * not have to adopt node:test to prove their plugin behaves.
 *
 *   for (const item of fundingProviderConformance({ ... })) {
 *     test(item.name, () => item.run());
 *   }
 */
export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export interface FundingProviderConformanceSetup {
  plugin: FundingProviderPlugin;
  /** An intent this provider is expected to serve. */
  supportedIntent: FundingIntent;
  /** An intent on a chain or asset this provider must decline. */
  unsupportedIntent: FundingIntent;
  now?: () => number;
}

export interface DestinationActionConformanceSetup {
  plugin: DestinationActionPlugin;
  intent: FundingIntent;
  fundingQuote: FundingQuote;
  /** A funding quote settling an asset this action must decline. */
  unsupportedFundingQuote: FundingQuote;
  now?: () => number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RailError("CONFORMANCE_FAILED", message);
}

export function fundingProviderConformance(
  setup: FundingProviderConformanceSetup,
): ConformanceCase[] {
  const now = setup.now ?? Date.now;
  const context: PluginContext = { now };
  const { plugin, supportedIntent, unsupportedIntent } = setup;

  const quoteOnce = async () => {
    const draft = await plugin.quote(supportedIntent, context);
    assert(draft !== null, "quote returned null for the supported intent.");
    return draft;
  };

  const asQuote = (draft: Awaited<ReturnType<typeof quoteOnce>>): FundingQuote => ({
    ...draft,
    providerId: plugin.manifest.id,
    providerName: plugin.manifest.name,
  });

  return [
    {
      name: "manifest declares a funding provider on API version 1",
      run: async () => {
        validateManifest(plugin.manifest, "funding-provider");
      },
    },
    {
      name: "supports accepts the supported intent",
      run: async () => {
        assert(await plugin.supports(supportedIntent), "supports rejected the supported intent.");
      },
    },
    {
      name: "supports rejects a foreign intent",
      run: async () => {
        assert(
          !(await plugin.supports(unsupportedIntent)),
          "supports accepted an intent on an unsupported chain or asset.",
        );
      },
    },
    {
      name: "quote returns null for a foreign intent instead of throwing",
      run: async () => {
        const draft = await plugin.quote(unsupportedIntent, context);
        assert(draft === null, "quote returned a draft for an unsupported intent.");
      },
    },
    {
      name: "quote satisfies the core funding-quote contract",
      run: async () => {
        validateFundingQuote(await quoteOnce(), supportedIntent, now());
      },
    },
    {
      name: "quote never promises a minimum above its expected output",
      run: async () => {
        const draft = await quoteOnce();
        assert(
          parseAmount(draft.minimumOutput.amountBaseUnits) <=
            parseAmount(draft.expectedOutput.amountBaseUnits),
          "minimumOutput exceeds expectedOutput.",
        );
      },
    },
    {
      name: "quote is two-phase and does not claim atomicity",
      run: async () => {
        const draft = await quoteOnce();
        assert(
          draft.executionMode === "two-phase",
          "quote claimed an execution mode the rail does not support.",
        );
      },
    },
    {
      name: "prepare returns valid wallet steps for its own quote",
      run: async () => {
        const steps = await plugin.prepare(
          { intent: supportedIntent, quote: asQuote(await quoteOnce()) },
          context,
        );
        validateWalletSteps(steps);
      },
    },
    {
      name: "getStatus rejects a reference from the wrong chain",
      run: async () => {
        const quote = asQuote(await quoteOnce());
        let threw = false;
        try {
          await plugin.getStatus(
            {
              intent: supportedIntent,
              quote,
              reference: {
                chainId: "eip155:987654",
                txId: "0xdeadbeef",
                submittedAt: new Date(now()).toISOString(),
              },
            },
            context,
          );
        } catch {
          threw = true;
        }
        assert(threw, "getStatus accepted a reference from an unrelated chain.");
      },
    },
  ];
}

export function destinationActionConformance(
  setup: DestinationActionConformanceSetup,
): ConformanceCase[] {
  const now = setup.now ?? Date.now;
  const context: PluginContext = { now };
  const { plugin, intent, fundingQuote, unsupportedFundingQuote } = setup;

  const quoteOnce = async () => {
    const draft = await plugin.quote({ intent, fundingQuote }, context);
    assert(draft !== null, "quote returned null for a supported funding route.");
    return draft;
  };

  return [
    {
      name: "manifest declares a destination action on API version 1",
      run: async () => {
        validateManifest(plugin.manifest, "destination-action");
      },
    },
    {
      name: "supports accepts its own settlement asset and rejects a foreign one",
      run: async () => {
        assert(
          await plugin.supports({ intent, fundingQuote }),
          "supports rejected its own settlement asset.",
        );
        assert(
          !(await plugin.supports({ intent, fundingQuote: unsupportedFundingQuote })),
          "supports accepted a foreign settlement asset.",
        );
      },
    },
    {
      name: "quote is sized from the funding route's guaranteed minimum",
      run: async () => {
        validateActionQuote(await quoteOnce(), fundingQuote, now());
      },
    },
    {
      name: "quote never promises a minimum above its expected output",
      run: async () => {
        const draft = await quoteOnce();
        assert(
          parseAmount(draft.minimumOutput.amountBaseUnits) <=
            parseAmount(draft.expectedOutput.amountBaseUnits),
          "minimumOutput exceeds expectedOutput.",
        );
      },
    },
    {
      name: "prepare returns valid wallet steps for its own quote",
      run: async () => {
        const draft = await quoteOnce();
        const steps = await plugin.prepare(
          {
            intent,
            fundingQuote,
            actionQuote: {
              ...draft,
              pluginId: plugin.manifest.id,
              pluginName: plugin.manifest.name,
            },
          },
          context,
        );
        validateWalletSteps(steps);
      },
    },
  ];
}
