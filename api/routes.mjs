import { createRequire } from "node:module";

/*
 * Loads a pre-bundled CJS build of the rail config rather than importing the
 * providers directly.
 *
 * Mayan's SDK depends on @mysten/sui, which is ESM-only. Vercel transpiles
 * these functions to CJS, so any surviving module boundary to that package
 * throws ERR_REQUIRE_ESM at import time. esbuild inlines the whole graph into
 * one self-contained CJS file, which leaves no boundary to mismatch.
 */
const { routes, support, SIGNING_ENABLED } = createRequire(import.meta.url)(
  "../examples/bridge-demo/server-bundle.cjs",
);

export default function handler(request, response) {
  response.setHeader("cache-control", "no-store");
  response.status(200).json({ routes, support, signingEnabled: SIGNING_ENABLED });
}
