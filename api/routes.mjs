import { routes, support, SIGNING_ENABLED } from "../examples/bridge-demo/rail-config.mjs";

export default function handler(request, response) {
  response.setHeader("cache-control", "no-store");
  response.status(200).json({ routes, support, signingEnabled: SIGNING_ENABLED });
}
