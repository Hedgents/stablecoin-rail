import type {
  FundingIntent,
  FundingQuote,
  DestinationActionQuote,
  JsonValue,
  PreparationContext,
  TransactionReference,
} from "../types.js";

/** Bumped only on a breaking change to the envelope itself. */
export const RAIL_REMOTE_PROTOCOL = 1;

export type RailRemoteRequest =
  | { protocol: number; kind: "funding"; pluginId: string; method: "supports"; intent: FundingIntent }
  | { protocol: number; kind: "funding"; pluginId: string; method: "quote"; intent: FundingIntent }
  | {
      protocol: number;
      kind: "funding";
      pluginId: string;
      method: "prepare";
      intent: FundingIntent;
      quote: FundingQuote;
      preparation?: PreparationContext;
    }
  | {
      protocol: number;
      kind: "funding";
      pluginId: string;
      method: "getStatus";
      intent: FundingIntent;
      quote: FundingQuote;
      reference: TransactionReference;
    }
  | {
      protocol: number;
      kind: "action";
      pluginId: string;
      method: "supports" | "quote";
      intent: FundingIntent;
      fundingQuote: FundingQuote;
    }
  | {
      protocol: number;
      kind: "action";
      pluginId: string;
      method: "prepare";
      intent: FundingIntent;
      fundingQuote: FundingQuote;
      actionQuote: DestinationActionQuote;
      preparation?: PreparationContext;
    }
  | {
      protocol: number;
      kind: "action";
      pluginId: string;
      method: "getStatus";
      intent: FundingIntent;
      fundingQuote: FundingQuote;
      actionQuote: DestinationActionQuote;
      reference: TransactionReference;
    };

export type RailRemoteResponse =
  | { ok: true; result: JsonValue | null }
  | { ok: false; error: { code: string; message: string } };

/**
 * `Omit` over a union collapses it to the shared keys, which would erase every
 * per-method field. Distributing preserves each variant.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A remote request before the envelope stamps its protocol version. */
export type RailRemoteRequestBody = DistributiveOmit<RailRemoteRequest, "protocol">;
