export interface CctpFeeTier {
  finalityThreshold: number;
  minimumFeeBps: number;
  forwardFee: bigint;
}

const INTEGER = /^\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseUnits(value: unknown, field: string): bigint {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !INTEGER.test(text)) {
    throw new Error(`Circle returned an invalid ${field}.`);
  }
  return BigInt(text);
}

/**
 * Pick a tier from Circle's fee schedule.
 *
 * `preferred` is a finality threshold: 1000 is the fast tier, 2000 standard.
 * A schedule that does not carry the requested tier falls back to the first
 * entry rather than failing, but anything structurally unexpected throws:
 * guessing at a fee shape is how a burn ends up underfunded.
 */
export function selectFeeTier(payload: unknown, preferred: number): CctpFeeTier {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("Circle returned an empty or malformed fee schedule.");
  }
  const entries = payload.filter(isRecord);
  const chosen = entries.find((entry) => entry.finalityThreshold === preferred) ?? entries[0];
  if (!chosen) throw new Error("Circle returned no usable fee tier.");

  const finalityThreshold = chosen.finalityThreshold;
  if (!Number.isInteger(finalityThreshold)) {
    throw new Error("Circle returned an invalid finalityThreshold.");
  }
  const minimumFee = chosen.minimumFee;
  if (!Number.isInteger(minimumFee) || (minimumFee as number) < 0) {
    throw new Error("Circle returned an invalid minimumFee.");
  }
  const forwardFee = isRecord(chosen.forwardFee) ? chosen.forwardFee.med : undefined;

  return {
    finalityThreshold: finalityThreshold as number,
    minimumFeeBps: minimumFee as number,
    forwardFee: baseUnits(forwardFee, "forwardFee.med"),
  };
}

/**
 * Circle's protocol fee in base units, rounded UP.
 *
 * Rounding down would let `maxFee` fall a base unit below what Circle charges,
 * which makes the burn unusable. Erring high costs the user at most one base
 * unit.
 */
export function protocolFee(amount: bigint, minimumFeeBps: number): bigint {
  if (!Number.isInteger(minimumFeeBps) || minimumFeeBps < 0) {
    throw new Error("The CCTP minimum fee must be a non-negative integer in basis points.");
  }
  const numerator = amount * BigInt(minimumFeeBps);
  return numerator === 0n ? 0n : (numerator + 9_999n) / 10_000n;
}
