import { createRequire } from "node:module";

/* See api/routes.mjs for why this loads a pre-bundled CJS build. */
const { handle } = createRequire(import.meta.url)("../examples/bridge-demo/server-bundle.cjs");

export default async function handler(request, response) {
  if (request.method !== "POST") {
    return response.status(405).json({ ok: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only." } });
  }
  // The handler never throws: it returns { ok: false, error } so the client can
  // rethrow with the original code.
  response.setHeader("cache-control", "no-store");
  response.status(200).json(await handle(request.body));
}
