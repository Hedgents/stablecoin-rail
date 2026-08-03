import { RailPluginError } from "../errors.js";
import { defineDestinationAction, defineFundingProvider } from "../plugins.js";
import type {
  DestinationActionPlugin,
  DestinationActionQuoteDraft,
  FundingIntent,
  FundingProviderPlugin,
  FundingQuoteDraft,
  FundingStatus,
  DestinationActionStatus,
  JsonValue,
  PluginContext,
  PluginManifest,
  WalletStep,
} from "../types.js";
import {
  RAIL_REMOTE_PROTOCOL,
  type RailRemoteRequestBody,
  type RailRemoteResponse,
} from "./types.js";

export interface RemotePluginOptions {
  /**
   * Where the server handler is mounted. Everything secret, from provider API
   * keys to allowlists and rate limits, lives behind it.
   */
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export interface RemoteFundingProviderOptions extends RemotePluginOptions {
  manifest: PluginManifest & { kind: "funding-provider" };
  /**
   * Optional local predicate. Route shape is not secret, so answering it in
   * process avoids a round trip per provider on every quote. Omit to ask the
   * server. A local `true` is still re-checked server-side by the real plugin.
   */
  supports?: (intent: FundingIntent) => boolean;
}

export interface RemoteDestinationActionOptions extends RemotePluginOptions {
  manifest: PluginManifest & { kind: "destination-action" };
  supports?: (request: { intent: FundingIntent; fundingQuote: JsonValue }) => boolean;
}

async function call(
  options: RemotePluginOptions,
  pluginId: string,
  request: RailRemoteRequestBody,
  context: PluginContext,
): Promise<JsonValue | null> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify({ protocol: RAIL_REMOTE_PROTOCOL, ...request }),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  } catch (cause) {
    throw new RailPluginError(pluginId, "REMOTE_UNREACHABLE", "The rail endpoint could not be reached.", {
      cause,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new RailPluginError(pluginId, "REMOTE_MALFORMED_RESPONSE", "The rail endpoint returned invalid JSON.", {
      cause,
    });
  }
  if (typeof payload !== "object" || payload === null) {
    throw new RailPluginError(pluginId, "REMOTE_MALFORMED_RESPONSE", "The rail endpoint returned an invalid body.");
  }

  const body = payload as RailRemoteResponse;
  if (body.ok === false) {
    const code = typeof body.error?.code === "string" ? body.error.code : "REMOTE_ERROR";
    const message =
      typeof body.error?.message === "string" ? body.error.message : "The rail endpoint reported an error.";
    // Rethrown with the original code so fail-closed behaviour survives the hop.
    throw new RailPluginError(pluginId, code, message);
  }
  if (body.ok !== true) {
    throw new RailPluginError(pluginId, "REMOTE_MALFORMED_RESPONSE", "The rail endpoint returned no outcome.");
  }
  return body.result ?? null;
}

/**
 * A funding provider that lives on a server.
 *
 * The browser sees only the plugin contract; credentials, target allowlists,
 * and abuse controls stay behind the endpoint. The manifest is supplied
 * locally because plugin registration is synchronous.
 */
export function createRemoteFundingProvider(
  options: RemoteFundingProviderOptions,
): FundingProviderPlugin {
  const id = options.manifest.id;
  return defineFundingProvider({
    manifest: options.manifest,
    supports: async (intent) => {
      if (options.supports) return options.supports(intent);
      const result = await call(options, id, { kind: "funding", pluginId: id, method: "supports", intent }, {
        now: Date.now,
      });
      return result === true;
    },
    quote: async (intent, context) =>
      (await call(options, id, { kind: "funding", pluginId: id, method: "quote", intent }, context)) as
        | FundingQuoteDraft
        | null,
    prepare: async ({ intent, quote, preparation }, context) =>
      (await call(
        options,
        id,
        {
          kind: "funding",
          pluginId: id,
          method: "prepare",
          intent,
          quote,
          ...(preparation ? { preparation } : {}),
        },
        context,
      )) as unknown as WalletStep[],
    getStatus: async ({ intent, quote, reference }, context) =>
      (await call(
        options,
        id,
        { kind: "funding", pluginId: id, method: "getStatus", intent, quote, reference },
        context,
      )) as unknown as FundingStatus,
  });
}

/** A destination action that lives on a server. */
export function createRemoteDestinationAction(
  options: RemoteDestinationActionOptions,
): DestinationActionPlugin {
  const id = options.manifest.id;
  return defineDestinationAction({
    manifest: options.manifest,
    supports: async ({ intent, fundingQuote }) => {
      if (options.supports) {
        return options.supports({ intent, fundingQuote: fundingQuote as unknown as JsonValue });
      }
      const result = await call(
        options,
        id,
        { kind: "action", pluginId: id, method: "supports", intent, fundingQuote },
        { now: Date.now },
      );
      return result === true;
    },
    quote: async ({ intent, fundingQuote }, context) =>
      (await call(
        options,
        id,
        { kind: "action", pluginId: id, method: "quote", intent, fundingQuote },
        context,
      )) as DestinationActionQuoteDraft | null,
    prepare: async ({ intent, fundingQuote, actionQuote, preparation }, context) =>
      (await call(
        options,
        id,
        {
          kind: "action",
          pluginId: id,
          method: "prepare",
          intent,
          fundingQuote,
          actionQuote,
          ...(preparation ? { preparation } : {}),
        },
        context,
      )) as unknown as WalletStep[],
    getStatus: async ({ intent, fundingQuote, actionQuote, reference }, context) =>
      (await call(
        options,
        id,
        { kind: "action", pluginId: id, method: "getStatus", intent, fundingQuote, actionQuote, reference },
        context,
      )) as unknown as DestinationActionStatus,
  });
}
