import { errorDetails, RailError } from "../errors.js";
import type {
  DestinationActionPlugin,
  FundingProviderPlugin,
  JsonValue,
  PluginContext,
} from "../types.js";
import { RAIL_REMOTE_PROTOCOL, type RailRemoteRequest, type RailRemoteResponse } from "./types.js";

export interface RailHandlerOptions {
  fundingProviders?: FundingProviderPlugin[];
  destinationActions?: DestinationActionPlugin[];
  now?: () => number;
  /**
   * Called before any plugin runs. Throw to reject.
   *
   * This is where a host puts authentication, per-user rate limits, order-size
   * caps, and jurisdiction policy. The SDK deliberately ships none of those: it
   * cannot know your rules, and pretending otherwise would invite integrators
   * to assume protection they do not have.
   */
  authorize?: (request: RailRemoteRequest) => void | Promise<void>;
}

export interface RailHandlerCallOptions {
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new RailError("INVALID_REMOTE_REQUEST", message);
}

function parseRequest(body: unknown): RailRemoteRequest {
  if (!isRecord(body)) invalid("The rail request body must be an object.");
  if (body.protocol !== RAIL_REMOTE_PROTOCOL) {
    throw new RailError(
      "UNSUPPORTED_REMOTE_PROTOCOL",
      `This endpoint speaks rail remote protocol ${RAIL_REMOTE_PROTOCOL}.`,
    );
  }
  if (body.kind !== "funding" && body.kind !== "action") invalid("Unknown rail request kind.");
  if (typeof body.pluginId !== "string" || body.pluginId.length === 0) invalid("A pluginId is required.");
  if (typeof body.method !== "string") invalid("A method is required.");
  if (!isRecord(body.intent)) invalid("An intent is required.");
  return body as unknown as RailRemoteRequest;
}

/**
 * Framework-neutral server half of the rail's remote transport.
 *
 * Takes an already-parsed request body and returns a plain response object, so
 * it drops into a Next.js route handler, an Express endpoint, a Worker, or a
 * test with no adaptation. It never touches HTTP itself.
 *
 * Errors are returned as `{ ok: false, error }` rather than thrown, so the
 * client can rethrow them with their original code and fail-closed behaviour
 * survives the network hop. Only the code and message cross the boundary; a
 * cause chain that might carry credentials never does.
 */
export function createRailHandler(options: RailHandlerOptions) {
  const now = options.now ?? Date.now;
  const funding = new Map((options.fundingProviders ?? []).map((p) => [p.manifest.id, p]));
  const actions = new Map((options.destinationActions ?? []).map((p) => [p.manifest.id, p]));

  return async function handle(
    body: unknown,
    callOptions?: RailHandlerCallOptions,
  ): Promise<RailRemoteResponse> {
    try {
      const request = parseRequest(body);
      if (options.authorize) await options.authorize(request);

      const context: PluginContext = callOptions?.signal
        ? { now, signal: callOptions.signal }
        : { now };

      if (request.kind === "funding") {
        const plugin = funding.get(request.pluginId);
        if (!plugin) {
          throw new RailError("FUNDING_PLUGIN_NOT_FOUND", `Funding provider ${request.pluginId} is missing.`);
        }
        switch (request.method) {
          case "supports":
            return { ok: true, result: (await plugin.supports(request.intent)) as JsonValue };
          case "quote":
            return { ok: true, result: ((await plugin.quote(request.intent, context)) ?? null) as JsonValue };
          case "prepare":
            return {
              ok: true,
              result: (await plugin.prepare(
                {
                  intent: request.intent,
                  quote: request.quote,
                  ...(request.preparation ? { preparation: request.preparation } : {}),
                },
                context,
              )) as unknown as JsonValue,
            };
          case "getStatus":
            return {
              ok: true,
              result: (await plugin.getStatus(
                { intent: request.intent, quote: request.quote, reference: request.reference },
                context,
              )) as unknown as JsonValue,
            };
          default:
            invalid("Unknown funding provider method.");
        }
      }

      const plugin = actions.get(request.pluginId);
      if (!plugin) {
        throw new RailError("ACTION_PLUGIN_NOT_FOUND", `Destination action ${request.pluginId} is missing.`);
      }
      switch (request.method) {
        case "supports":
          return {
            ok: true,
            result: (await plugin.supports({
              intent: request.intent,
              fundingQuote: request.fundingQuote,
            })) as JsonValue,
          };
        case "quote":
          return {
            ok: true,
            result: ((await plugin.quote(
              { intent: request.intent, fundingQuote: request.fundingQuote },
              context,
            )) ?? null) as JsonValue,
          };
        case "prepare":
          return {
            ok: true,
            result: (await plugin.prepare(
              {
                intent: request.intent,
                fundingQuote: request.fundingQuote,
                actionQuote: request.actionQuote,
                ...(request.preparation ? { preparation: request.preparation } : {}),
              },
              context,
            )) as unknown as JsonValue,
          };
        case "getStatus": {
          if (!plugin.getStatus) {
            throw new RailError(
              "ACTION_STATUS_UNSUPPORTED",
              `Destination action ${plugin.manifest.id} does not expose status verification.`,
            );
          }
          return {
            ok: true,
            result: (await plugin.getStatus(
              {
                intent: request.intent,
                fundingQuote: request.fundingQuote,
                actionQuote: request.actionQuote,
                reference: request.reference,
              },
              context,
            )) as unknown as JsonValue,
          };
        }
        default:
          invalid("Unknown destination action method.");
      }
    } catch (error) {
      return { ok: false, error: errorDetails(error) };
    }
  };
}
