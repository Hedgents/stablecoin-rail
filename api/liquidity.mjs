import { createRequire } from "node:module";

/* See api/routes.mjs for why this loads a pre-bundled CJS build. */
const { assessPool } = createRequire(import.meta.url)("../examples/bridge-demo/server-bundle.cjs");

export default async function handler(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const symbol = url.searchParams.get("symbol") ?? "USDT";
  const amount = url.searchParams.get("amount") ?? "0";
  response.setHeader("cache-control", "no-store");
  if (!/^\d+$/.test(amount) || amount === "0") {
    return response.status(400).json({ error: "amount must be a positive base-unit integer" });
  }
  try {
    const assessment = await assessPool({ symbol, amountBaseUnits: amount });
    // bigint is not JSON-serialisable; depth is reported as base-unit strings.
    response.status(200).json({
      band: assessment.band,
      reason: assessment.reason,
      destinationSharePct: assessment.destinationSharePct,
      source: {
        chainKey: assessment.source.chainKey,
        tokenBaseUnits: assessment.source.tokenBaseUnits.toString(),
        tokenSharePct: assessment.source.tokenSharePct,
        decimals: assessment.source.decimals,
      },
      destination: {
        chainKey: assessment.destination.chainKey,
        tokenBaseUnits: assessment.destination.tokenBaseUnits.toString(),
        tokenSharePct: assessment.destination.tokenSharePct,
        decimals: assessment.destination.decimals,
      },
    });
  } catch (cause) {
    response.status(502).json({ error: cause instanceof Error ? cause.message : "unavailable" });
  }
}
