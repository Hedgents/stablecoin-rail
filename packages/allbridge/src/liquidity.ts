/**
 * Pool-liquidity assessment for Allbridge Core routes.
 *
 * Allbridge Core is pool-based rather than canonical: your token enters a pool
 * on the source chain and a different token leaves a pool on the destination.
 * A transfer therefore *withdraws* from the destination pool, which makes that
 * side the binding constraint even when the source side looks deep.
 *
 * A rail that ranks by guaranteed output already protects the user
 * numerically. This module exists to explain WHY a number looks the way it
 * does, before they commit.
 */

/** Allbridge reports pool balances at a fixed 3-decimal system precision. */
export const SYSTEM_PRECISION = 3;

export const DEFAULT_API_BASE_URL = "https://core.api.allbridgecoreapi.net";

/** A balanced pool sits near 50% token share; below this it is token-poor. */
export const DEPLETED_TOKEN_SHARE_PCT = 25;

/**
 * Transfer size as a percentage of destination pool depth.
 *
 * Thresholds are deliberately conservative and stated here rather than in a
 * UI, so a caller cannot quietly redefine what "high" means.
 */
export const BANDS = { low: 1, moderate: 5, high: 15 } as const;

export type LiquidityBand = "low" | "moderate" | "high" | "severe";

export interface PoolDepth {
  chainKey: string;
  symbol: string;
  /** Actual token sitting in the pool, in the token's own base units. */
  tokenBaseUnits: bigint;
  /** The pool's virtual-USD side, in the token's own base units. */
  vUsdBaseUnits: bigint;
  /** Pool size invariant, in the token's own base units. */
  dBaseUnits: bigint;
  /** Token as a percentage of token + vUSD. 50 is balanced, lower is token-poor. */
  tokenSharePct: number;
  decimals: number;
}

export interface LiquidityAssessment {
  source: PoolDepth;
  destination: PoolDepth;
  /** The transfer as a percentage of destination pool depth. */
  destinationSharePct: number;
  band: LiquidityBand;
  /** Plain-language reason, safe to show a non-technical user. */
  reason: string;
}

interface AllbridgePoolInfo {
  tokenBalance?: unknown;
  vUsdBalance?: unknown;
  dValue?: unknown;
}

interface AllbridgeToken {
  symbol?: unknown;
  decimals?: unknown;
  poolInfo?: AllbridgePoolInfo;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function systemToBaseUnits(value: unknown, decimals: number, field: string): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text)) {
    throw new Error(`Allbridge returned an invalid ${field}.`);
  }
  if (decimals < SYSTEM_PRECISION) {
    throw new Error(`A token with fewer than ${SYSTEM_PRECISION} decimals is not supported.`);
  }
  return BigInt(text) * 10n ** BigInt(decimals - SYSTEM_PRECISION);
}

/** Percentage with two decimals, computed without floating-point division. */
function percent(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return Number.POSITIVE_INFINITY;
  return Number((numerator * 10_000n) / denominator) / 100;
}

export function readPoolDepth(token: AllbridgeToken, chainKey: string): PoolDepth {
  const decimals = token.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals)) {
    throw new Error("Allbridge returned a token without decimals.");
  }
  const pool = token.poolInfo;
  if (!isRecord(pool)) throw new Error("Allbridge returned a token without pool information.");

  const tokenBaseUnits = systemToBaseUnits(pool.tokenBalance, decimals, "tokenBalance");
  const vUsdBaseUnits = systemToBaseUnits(pool.vUsdBalance, decimals, "vUsdBalance");
  const dBaseUnits = systemToBaseUnits(pool.dValue, decimals, "dValue");
  const total = tokenBaseUnits + vUsdBaseUnits;

  return {
    chainKey,
    symbol: typeof token.symbol === "string" ? token.symbol : "",
    tokenBaseUnits,
    vUsdBaseUnits,
    dBaseUnits,
    tokenSharePct: total > 0n ? percent(tokenBaseUnits, total) : 0,
    decimals,
  };
}

/** The same nominal amount expressed in another token's base units. */
function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals >= fromDecimals) return amount * 10n ** BigInt(toDecimals - fromDecimals);
  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}

export function assessLiquidity(
  source: PoolDepth,
  destination: PoolDepth,
  amountBaseUnits: bigint,
): LiquidityAssessment {
  // The amount arrives in SOURCE-token base units; the destination pool depth
  // is in the destination token's own base units, and Allbridge lists the
  // same symbol with different decimals per chain (BSC stables are 18, TRX
  // and Solana are 6). Comparing without rescaling would be off by 10^12 on a
  // 6-to-18 route, inverting the warning this module exists to give.
  const amountInDestinationUnits = rescale(amountBaseUnits, source.decimals, destination.decimals);
  const destinationSharePct = percent(amountInDestinationUnits, destination.tokenBaseUnits);
  const depleted = destination.tokenSharePct < DEPLETED_TOKEN_SHARE_PCT;

  let band: LiquidityBand;
  if (destinationSharePct > BANDS.high || depleted) band = "severe";
  else if (destinationSharePct > BANDS.moderate) band = "high";
  else if (destinationSharePct > BANDS.low) band = "moderate";
  else band = "low";

  const share = Number.isFinite(destinationSharePct) ? `${destinationSharePct.toFixed(2)}%` : "all";
  const reason = depleted
    ? `The ${destination.chainKey} pool is low on ${destination.symbol} (${destination.tokenSharePct.toFixed(0)}% of its balance), so payouts are unusually expensive right now.`
    : band === "low"
      ? `Your transfer is ${share} of the ${destination.chainKey} pool, which is comfortably deep enough.`
      : band === "moderate"
        ? `Your transfer is ${share} of the ${destination.chainKey} pool. Expect a slightly worse rate.`
        : band === "high"
          ? `Your transfer is ${share} of the ${destination.chainKey} pool. Expect a noticeably worse rate.`
          : `Your transfer is ${share} of the ${destination.chainKey} pool. A transfer this large relative to available liquidity will be expensive.`;

  return { source, destination, destinationSharePct, band, reason };
}

export interface AllbridgePoolReaderOptions {
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface AssessRequest {
  sourceChainKey: string;
  destinationChainKey: string;
  symbol: string;
  /**
   * The transfer amount in the SOURCE token's base units, matching the
   * intent's `inputAmountBaseUnits`. Rescaled internally before it is
   * compared against destination pool depth.
   */
  amountBaseUnits: bigint;
}

/**
 * Reads Allbridge's public token registry. No API key is required, and the
 * bridge contract addresses are published in the same response, which is why
 * this route needs no privately negotiated allowlist.
 */
export function createAllbridgePoolReader(options: AllbridgePoolReaderOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async assess(request: AssessRequest): Promise<LiquidityAssessment> {
      const response = await fetchImpl(`${baseUrl}/token-info`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Allbridge token registry returned ${response.status}.`);
      const payload: unknown = await response.json();
      if (!isRecord(payload)) throw new Error("Allbridge returned a malformed token registry.");

      const pick = (chainKey: string): AllbridgeToken => {
        const chain = payload[chainKey];
        if (!isRecord(chain) || !Array.isArray(chain.tokens)) {
          throw new Error(`Allbridge does not list chain ${chainKey}.`);
        }
        const token = (chain.tokens as AllbridgeToken[]).find((t) => t.symbol === request.symbol);
        if (!token) throw new Error(`Allbridge does not list ${request.symbol} on ${chainKey}.`);
        return token;
      };

      return assessLiquidity(
        readPoolDepth(pick(request.sourceChainKey), request.sourceChainKey),
        readPoolDepth(pick(request.destinationChainKey), request.destinationChainKey),
        request.amountBaseUnits,
      );
    },
  };
}
