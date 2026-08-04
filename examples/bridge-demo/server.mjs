import { createServer } from "node:http";
import { assessPool, handle, routes, support, SIGNING_ENABLED } from "./rail-config.mjs";

/** Local development server. On Vercel the same config is served by /api. */

const PORT = Number(process.env.PORT ?? 8787);

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

createServer((request, response) => {
  if (request.method === "GET" && request.url === "/api/routes") {
    return json(response, 200, { routes, support, signingEnabled: SIGNING_ENABLED });
  }
  if (request.method === "GET" && request.url?.startsWith("/api/liquidity")) {
    const url = new URL(request.url, "http://localhost");
    const amount = url.searchParams.get("amount") ?? "0";
    if (!/^\d+$/.test(amount) || amount === "0") {
      return json(response, 400, { error: "amount must be a positive base-unit integer" });
    }
    return assessPool({ symbol: url.searchParams.get("symbol") ?? "USDT", amountBaseUnits: amount })
      .then((a) =>
        json(response, 200, {
          band: a.band,
          reason: a.reason,
          destinationSharePct: a.destinationSharePct,
          source: { chainKey: a.source.chainKey, tokenBaseUnits: a.source.tokenBaseUnits.toString(), tokenSharePct: a.source.tokenSharePct, decimals: a.source.decimals },
          destination: { chainKey: a.destination.chainKey, tokenBaseUnits: a.destination.tokenBaseUnits.toString(), tokenSharePct: a.destination.tokenSharePct, decimals: a.destination.decimals },
        }),
      )
      .catch((cause) => json(response, 502, { error: cause?.message ?? "unavailable" }));
  }
  if (request.method !== "POST" || request.url !== "/api/rail") {
    return json(response, 404, { error: "Not found" });
  }
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(response, 400, { ok: false, error: { code: "INVALID_JSON", message: "Malformed body." } });
    }
    json(response, 200, await handle(body));
  });
}).listen(PORT, () => {
  const live = routes.filter((route) => route.status === "live").length;
  console.log(`rail demo on http://127.0.0.1:${PORT}  (${live}/${routes.length} routes live)`);
  console.log(`signing: ${SIGNING_ENABLED ? "ENABLED" : "disabled (quote-only)"}`);
});
