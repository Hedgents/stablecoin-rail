import assert from "node:assert/strict";
import test from "node:test";
import { RailClient, RailPluginError, defineFundingProvider } from "../dist/index.js";
import { createRailHandler, createRemoteFundingProvider } from "../dist/remote/index.js";
import { fundingProviderConformance } from "../dist/testing/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const expiresAt = new Date(NOW + 60_000).toISOString();
const checkedAt = new Date(NOW).toISOString();
const ENDPOINT = "https://app.test/api/rail";

const ethereumUsdc = {
  chainId: "eip155:1",
  assetId: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  symbol: "USDC",
  decimals: 6,
};
const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "USDC",
  decimals: 6,
};

const intent = {
  id: "remote-1",
  source: {
    account: { chainId: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    asset: ethereumUsdc,
  },
  destination: {
    account: { chainId: "solana:mainnet", address: "DestinationWallet111111111111111111111111111" },
    settlementAsset: solanaUsdc,
  },
  inputAmountBaseUnits: "100000000",
  slippageBps: 50,
};

const foreignIntent = {
  ...intent,
  id: "remote-foreign",
  source: {
    account: { chainId: "eip155:999", address: "0x3333333333333333333333333333333333333333" },
    asset: { ...ethereumUsdc, chainId: "eip155:999", assetId: "eip155:999/erc20:0xdead" },
  },
};

const serves = (candidate) => candidate.source.account.chainId === "eip155:1";

/** A secret that must never appear in anything the client can observe. */
const SECRET = "super-secret-provider-key";

function origin(overrides = {}) {
  return defineFundingProvider({
    manifest: {
      id: "origin",
      name: "Origin",
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    supports: serves,
    quote: async (candidate) => {
      if (!serves(candidate)) return null;
      return {
        id: "origin-quote",
        input: { asset: ethereumUsdc, amountBaseUnits: candidate.inputAmountBaseUnits },
        expectedOutput: { asset: solanaUsdc, amountBaseUnits: "99500000" },
        minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
        fees: [],
        etaSeconds: 30,
        expiresAt,
        executionMode: "two-phase",
        opaqueData: { schema: "origin.v1" },
      };
    },
    prepare: async () => [
      {
        id: "origin-step",
        kind: "funding",
        chainId: "eip155:1",
        label: "Fund",
        request: {
          namespace: "evm",
          chainId: "eip155:1",
          numericChainId: 1,
          to: "0x2222222222222222222222222222222222222222",
          data: "0x",
          value: "0",
        },
      },
    ],
    getStatus: async ({ reference }) => {
      if (reference.chainId !== "eip155:1") throw new Error("wrong chain");
      return {
        state: "pending",
        reference,
        destinationReference: null,
        received: null,
        detail: "moving",
        checkedAt,
      };
    },
    ...overrides,
  });
}

/** Wires the client half straight to the server half, with no real network. */
function wire(handlerOptions = {}, clientOptions = {}) {
  const seen = [];
  const handle = createRailHandler({ fundingProviders: [origin()], now, ...handlerOptions });
  const remote = createRemoteFundingProvider({
    manifest: {
      id: "origin",
      name: "Origin",
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    endpoint: ENDPOINT,
    fetch: async (url, init) => {
      assert.equal(String(url), ENDPOINT);
      const body = JSON.parse(init.body);
      seen.push(body);
      const result = await handle(body);
      return new Response(JSON.stringify(result), {
        headers: { "content-type": "application/json" },
      });
    },
    ...clientOptions,
  });
  return { remote, seen };
}

test("a remote provider passes the same conformance suite as a direct one", async () => {
  const { remote } = wire();
  for (const item of fundingProviderConformance({
    plugin: remote,
    supportedIntent: intent,
    unsupportedIntent: foreignIntent,
    now,
  })) {
    await item.run();
  }
});

test("a full quote runs through RailClient over the transport", async () => {
  const { remote } = wire();
  const client = new RailClient({ fundingProviders: [remote], now });
  const batch = await client.quote(intent);
  assert.equal(batch.quotes.length, 1);
  assert.equal(batch.quotes[0].funding.minimumOutput.amountBaseUnits, "99000000");
  assert.equal(batch.quotes[0].funding.providerId, "origin");
});

test("plugin error codes survive the network hop", async () => {
  const { remote } = wire({
    fundingProviders: [
      origin({
        quote: async () => {
          throw new RailPluginError("origin", "PROVIDER_DOWN", "Upstream is unavailable.");
        },
      }),
    ],
  });
  await assert.rejects(
    () => remote.quote(intent, { now }),
    (error) => {
      assert.equal(error.code, "PROVIDER_DOWN");
      assert.match(error.message, /Upstream is unavailable/);
      return true;
    },
  );
});

test("a server-side secret never crosses the boundary", async () => {
  const { remote, seen } = wire({
    fundingProviders: [
      origin({
        quote: async () => {
          const failure = new Error("boom");
          failure.cause = { apiKey: SECRET };
          throw failure;
        },
      }),
    ],
  });
  await assert.rejects(
    () => remote.quote(intent, { now }),
    (error) => {
      // Only code and message cross; a cause chain that might carry
      // credentials is dropped by the handler.
      assert.ok(!JSON.stringify(error.message).includes(SECRET));
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  assert.ok(!JSON.stringify(seen).includes(SECRET));
});

test("the authorize hook can reject a request before any plugin runs", async () => {
  let ran = false;
  const { remote } = wire({
    fundingProviders: [
      origin({
        quote: async () => {
          ran = true;
          return null;
        },
      }),
    ],
    authorize: () => {
      throw new RailPluginError("origin", "RATE_LIMITED", "Too many requests.");
    },
  });
  await assert.rejects(
    () => remote.quote(intent, { now }),
    (error) => {
      assert.equal(error.code, "RATE_LIMITED");
      return true;
    },
  );
  assert.equal(ran, false, "authorize must run before the plugin");
});

test("an unknown plugin id is rejected by the server", async () => {
  const handle = createRailHandler({ fundingProviders: [origin()], now });
  const response = await handle({
    protocol: 1,
    kind: "funding",
    pluginId: "nope",
    method: "quote",
    intent,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "FUNDING_PLUGIN_NOT_FOUND");
});

test("a mismatched protocol version is rejected rather than guessed at", async () => {
  const handle = createRailHandler({ fundingProviders: [origin()], now });
  const response = await handle({ protocol: 99, kind: "funding", pluginId: "origin", method: "quote", intent });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "UNSUPPORTED_REMOTE_PROTOCOL");
});

test("a malformed body is rejected rather than passed to a plugin", async () => {
  const handle = createRailHandler({ fundingProviders: [origin()], now });
  for (const body of [null, "nope", { protocol: 1 }, { protocol: 1, kind: "funding", pluginId: "origin" }]) {
    const response = await handle(body);
    assert.equal(response.ok, false);
  }
});

test("a local supports predicate avoids a round trip", async () => {
  const { remote, seen } = wire({}, { supports: serves });
  assert.equal(await remote.supports(intent), true);
  assert.equal(await remote.supports(foreignIntent), false);
  assert.equal(seen.length, 0, "supports must not hit the network when answered locally");
});

test("an unreachable endpoint fails closed with a distinct code", async () => {
  const remote = createRemoteFundingProvider({
    manifest: {
      id: "origin",
      name: "Origin",
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    endpoint: ENDPOINT,
    fetch: async () => {
      throw new Error("network down");
    },
  });
  await assert.rejects(
    () => remote.quote(intent, { now }),
    (error) => {
      assert.equal(error.code, "REMOTE_UNREACHABLE");
      return true;
    },
  );
});

test("a non-JSON response fails closed", async () => {
  const remote = createRemoteFundingProvider({
    manifest: {
      id: "origin",
      name: "Origin",
      version: "1.0.0",
      apiVersion: 1,
      kind: "funding-provider",
    },
    endpoint: ENDPOINT,
    fetch: async () => new Response("<html>502</html>", { status: 502 }),
  });
  await assert.rejects(
    () => remote.quote(intent, { now }),
    (error) => {
      assert.equal(error.code, "REMOTE_MALFORMED_RESPONSE");
      return true;
    },
  );
});
