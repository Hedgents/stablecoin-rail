# Rail Core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship core `0.2.0` with an optional destination action, a resumable flow, and settlement verification, plus a new `@hedgents/stablecoin-rail-solana` package and a runner-agnostic plugin conformance suite.

**Architecture:** Core stays zero-dependency and owns contracts, validation, ranking, and the flow state machine. Chain-specific I/O lives in provider packages. A new `-solana` package supplies pure address helpers and a `SettlementVerifier` that reads a token-account balance delta over plain JSON-RPC, which is what finally makes `FundingStatus.received` non-null on every Solana route.

**Tech Stack:** TypeScript (NodeNext, ES2022), npm workspaces, `node --test` with `.mjs` test files importing from `dist/`, `@noble/hashes` and `@noble/curves` in `-solana` only.

## Global Constraints

- Spec: `docs/specs/2026-08-03-rail-completion-design.md`. This plan covers phases **P1, P2, and P3** only.
- **Never edit anything outside `stablecoin-rail/`.** `frontend/` belongs to another engineer.
- `packages/core` must keep **zero runtime dependencies**. No exceptions.
- `tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. Indexed access yields `T | undefined`, and you may not assign an explicit `undefined` to an optional property. Build with `npm run build -w <package>` before running that package's tests; the test script already does this.
- Tests are `test/*.test.mjs`, import from `../dist/index.js`, and use `node:assert/strict` plus `node:test`. Match the style in `packages/core/test/client.test.mjs`.
- No test may perform real network I/O. Inject a fake `fetch`.
- Fail closed. When a check cannot be satisfied, throw a `RailError` with an explicit code rather than degrading silently, except where this plan states that returning `null` is the defined fallback.
- Do not mark any route Implemented in any document. No route has moved real value.
- Commit after each task with the message given in that task's final step.

---

## File Structure

**Modified**
- `packages/core/src/types.ts` — `FundingIntent.action` optional, `IntentQuote.action` nullable, `RailClientOptions.destinationActions` optional plus `settlementVerifier`, new `SettlementVerifier` and `PersistedRailFlow` types.
- `packages/core/src/validation.ts` — intent validation tolerates a missing action.
- `packages/core/src/client.ts` — optional-action quoting, ranking helpers, verifier wiring, `hydrateFlow`, public `now`.
- `packages/core/src/flow.ts` — funding-only terminal phase, action guards, `serialize`, snapshot-accepting constructor.
- `packages/core/src/index.ts` — export the new types and helpers.
- `packages/core/package.json` — version `0.2.0`, `./testing` subpath export.

**Created**
- `packages/core/src/persistence.ts` — rehydration rules, isolated so the phase table has one home.
- `packages/core/src/testing/index.ts` — conformance suite.
- `packages/core/test/optional-action.test.mjs`
- `packages/core/test/persistence.test.mjs`
- `packages/core/test/settlement-verifier.test.mjs`
- `packages/core/test/conformance.test.mjs`
- `packages/solana/` — full package: `package.json`, `tsconfig.json`, `LICENSE`, `README.md`, `src/base58.ts`, `src/addresses.ts`, `src/verifier.ts`, `src/index.ts`, `test/base58.test.mjs`, `test/addresses.test.mjs`, `test/verifier.test.mjs`.

---

## Task 1: Optional destination action

Types, validation, client, and flow change together. Splitting them would leave the build red between tasks, because `client.ts` dereferences `intent.action.pluginId` today.

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/validation.ts:57`
- Modify: `packages/core/src/client.ts`
- Modify: `packages/core/src/flow.ts`
- Test: `packages/core/test/optional-action.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `FundingIntent.action?: DestinationActionRequest`; `IntentQuote.action: DestinationActionQuote | null`; `RailClientOptions.destinationActions?: DestinationActionPlugin[]`; error code `ACTION_NOT_CONFIGURED`; `RailClient.now: () => number` becomes public readonly.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/optional-action.test.mjs`. Copy the asset and provider fixtures from `test/client.test.mjs` lines 10 to 45, then omit `action` from the intent.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { RailClient, RailError, defineFundingProvider } from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;
const expiresAt = new Date(NOW + 60_000).toISOString();
const checkedAt = new Date(NOW).toISOString();

const ethereumUsdc = {
  chainId: "eip155:1",
  assetId: "eip155:1/erc20:0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  symbol: "USDC",
  decimals: 6,
};
const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  symbol: "USDC",
  decimals: 6,
};

const fundingOnlyIntent = {
  id: "intent-funding-only",
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

function provider(id, minimumOutput) {
  return defineFundingProvider({
    manifest: { id, name: id.toUpperCase(), version: "1.0.0", apiVersion: 1, kind: "funding-provider" },
    supports: () => true,
    quote: async () => ({
      id: `${id}-quote`,
      input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
      expectedOutput: { asset: solanaUsdc, amountBaseUnits: String(Number(minimumOutput) + 1000) },
      minimumOutput: { asset: solanaUsdc, amountBaseUnits: minimumOutput },
      fees: [],
      etaSeconds: 30,
      expiresAt,
      executionMode: "two-phase",
    }),
    prepare: async () => [
      {
        id: `${id}-step`,
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
    getStatus: async ({ reference }) => ({
      state: "completed",
      reference,
      destinationReference: { chainId: "solana:mainnet", txId: "solsig", submittedAt: checkedAt },
      received: null,
      detail: "settled",
      checkedAt,
    }),
  });
}

test("quotes a funding-only intent with no destination actions registered", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const batch = await client.quote(fundingOnlyIntent);
  assert.equal(batch.quotes.length, 1);
  assert.equal(batch.quotes[0].action, null);
  assert.equal(batch.quotes[0].id, "a:a-quote");
  assert.equal(batch.quotes[0].expiresAt, expiresAt);
});

test("ranks funding-only quotes by guaranteed settlement output", async () => {
  const client = new RailClient({
    fundingProviders: [provider("low", "98000000"), provider("high", "99500000")],
    now,
  });
  const batch = await client.quote(fundingOnlyIntent);
  assert.equal(batch.quotes.length, 2);
  assert.equal(batch.quotes[0].funding.providerId, "high");
});

test("a funding-only flow completes without a destination action", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  const snapshot = await flow.refreshFunding();
  assert.equal(snapshot.phase, "completed");
});

test("action entry points reject a funding-only flow", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await assert.rejects(() => flow.prepareAction(), (error) => {
    assert.ok(error instanceof RailError);
    assert.equal(error.code, "ACTION_NOT_CONFIGURED");
    return true;
  });
});

test("an intent naming an unregistered action still fails loudly", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  await assert.rejects(
    () => client.quote({ ...fundingOnlyIntent, action: { pluginId: "missing" } }),
    (error) => {
      assert.equal(error.code, "ACTION_PLUGIN_NOT_FOUND");
      return true;
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: FAIL. The constructor throws `NO_DESTINATION_ACTIONS` because no destination actions are registered.

- [ ] **Step 3: Loosen the types**

In `packages/core/src/types.ts`, make `action` optional on `FundingIntent`:

```ts
export interface FundingIntent {
  id: string;
  source: {
    account: AccountDescriptor;
    asset: AssetDescriptor;
  };
  destination: {
    account: AccountDescriptor;
    settlementAsset: AssetDescriptor;
  };
  inputAmountBaseUnits: string;
  slippageBps: number;
  action?: DestinationActionRequest;
  metadata?: JsonValue;
}
```

Make `IntentQuote.action` nullable:

```ts
export interface IntentQuote {
  id: string;
  intent: FundingIntent;
  funding: FundingQuote;
  action: DestinationActionQuote | null;
  expiresAt: string;
  totalEtaSeconds: number;
}
```

Make `destinationActions` optional in `RailClientOptions`:

```ts
export interface RailClientOptions {
  fundingProviders: FundingProviderPlugin[];
  destinationActions?: DestinationActionPlugin[];
  now?: () => number;
}
```

- [ ] **Step 4: Relax intent validation**

In `packages/core/src/validation.ts`, replace line 57:

```ts
  if (intent.action) requireText(intent.action.pluginId, "intent.action.pluginId");
```

- [ ] **Step 5: Update the client constructor and quoting**

In `packages/core/src/client.ts`, change the private clock to a public readonly one so later tasks can timestamp persistence:

```ts
  readonly now: () => number;
```

Iterate over a defaulted list and delete the `NO_DESTINATION_ACTIONS` guard entirely, keeping `NO_FUNDING_PROVIDERS`:

```ts
    for (const plugin of options.destinationActions ?? []) {
      validateManifest(plugin.manifest, "destination-action");
      if (destinationActions.has(plugin.manifest.id)) {
        throw new RailError("DUPLICATE_PLUGIN", `Destination action ${plugin.manifest.id} is duplicated.`);
      }
      destinationActions.set(plugin.manifest.id, plugin);
    }
    if (fundingProviders.size === 0) {
      throw new RailError("NO_FUNDING_PROVIDERS", "Register at least one funding provider.");
    }
```

Replace the action lookup at the top of `quote()`:

```ts
    const actionRequest = intent.action;
    const actionPlugin = actionRequest
      ? this.destinationActions.get(actionRequest.pluginId)
      : undefined;
    if (actionRequest && !actionPlugin) {
      throw new RailError(
        "ACTION_PLUGIN_NOT_FOUND",
        `Destination action ${actionRequest.pluginId} is not registered.`,
      );
    }
```

Immediately after the `const funding: FundingQuote = { ... }` assignment inside the provider map, short-circuit funding-only intents:

```ts
        if (!actionPlugin) {
          const quote: IntentQuote = {
            id: `${provider.manifest.id}:${draft.id}`,
            intent,
            funding,
            action: null,
            expiresAt: funding.expiresAt,
            totalEtaSeconds: funding.etaSeconds,
          };
          return { quote, failure: null };
        }
```

- [ ] **Step 6: Make ranking shape-agnostic**

Still in `client.ts`, add a helper above `compareQuotes` and use it in both places that read `action.minimumOutput`:

```ts
function rankingAmount(quote: IntentQuote): AssetAmount {
  return quote.action?.minimumOutput ?? quote.funding.minimumOutput;
}

function compareQuotes(left: IntentQuote, right: IntentQuote) {
  const leftOutput = parseAmount(rankingAmount(left).amountBaseUnits);
  const rightOutput = parseAmount(rankingAmount(right).amountBaseUnits);
  if (leftOutput !== rightOutput) return leftOutput > rightOutput ? -1 : 1;
  if (left.totalEtaSeconds !== right.totalEtaSeconds) {
    return left.totalEtaSeconds - right.totalEtaSeconds;
  }
  return left.id.localeCompare(right.id);
}
```

Replace the comparability block near the end of `quote()`. `noUncheckedIndexedAccess` makes `quotes[0]` possibly undefined, so guard it explicitly:

```ts
    const first = quotes[0];
    const referenceAsset = first ? rankingAmount(first).asset : null;
    const validQuotes: IntentQuote[] = [];
    for (const quote of quotes) {
      if (referenceAsset && !sameAsset(referenceAsset, rankingAmount(quote).asset)) {
        failures.push({
          pluginId: quote.action?.pluginId ?? quote.funding.providerId,
          stage: "validation",
          code: "INCOMPARABLE_OUTPUT",
          message: "The action returned an output asset that cannot be ranked with the other routes.",
        });
      } else {
        validQuotes.push(quote);
      }
    }
```

Add `AssetAmount` to the type import list at the top of `client.ts` if it is not already there.

- [ ] **Step 7: Guard the action methods on the client**

Add this guard as the first statement of `refreshActionQuote`, `prepareAction`, and `getActionStatus`:

```ts
    if (!quote.action) {
      throw new RailError("ACTION_NOT_CONFIGURED", "This quote has no destination action.");
    }
```

- [ ] **Step 8: Update the flow**

In `packages/core/src/flow.ts`, change the completed-funding transition inside `refreshFunding` so a funding-only intent terminates:

```ts
        phase:
          status.state === "completed"
            ? quote.intent.action
              ? "destination-ready"
              : "completed"
            : status.state === "refunded"
              ? "refunded"
              : status.state === "failed"
                ? "failed"
                : "funding-pending",
```

Add the same guard to the three action methods, before their phase checks so the error explains the real problem. In `prepareAction`:

```ts
    const selectedQuote = this.requireSelectedQuote();
    if (!selectedQuote.action) {
      throw new RailError("ACTION_NOT_CONFIGURED", "This flow has no destination action.");
    }
    if (this.snapshot.phase !== "destination-ready") {
```

In `markActionSubmitted` and `refreshAction`, add the same two lines using `this.requireSelectedQuote()` first. `markActionSubmitted` does not currently call it; adding the call is safe because the flow cannot reach `awaiting-destination-signature` without a selected quote.

- [ ] **Step 9: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: PASS, all five new tests plus the six existing ones.

- [ ] **Step 10: Verify nothing downstream broke**

Run: `npm run typecheck && npm test`
Expected: PASS. `-layerzero` and `-react` still compile against the widened types.

- [ ] **Step 11: Commit**

```bash
git add packages/core/src packages/core/test/optional-action.test.mjs
git commit -m "feat(core): make the destination action optional"
```

---

## Task 2: Resumable flow

**Files:**
- Create: `packages/core/src/persistence.ts`
- Modify: `packages/core/src/flow.ts`
- Modify: `packages/core/src/client.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/persistence.test.mjs`

**Interfaces:**
- Consumes: `RailClient.now` and `IntentQuote.action` nullability from Task 1.
- Produces: `PersistedRailFlow` (`{ version: 1; persistedAt: string; snapshot: RailFlowSnapshot }`); `RailFlow.serialize(): PersistedRailFlow`; `RailClient.hydrateFlow(persisted: PersistedRailFlow): RailFlow`; error codes `UNSUPPORTED_PERSISTED_VERSION` and `INVALID_PERSISTED_SNAPSHOT`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/persistence.test.mjs`. Reuse the fixtures and `provider()` factory from Task 1 by copying them into this file (do not import across test files).

```js
async function fundedFlow(client, intent) {
  const flow = client.createFlow();
  await flow.quote(intent);
  await flow.prepareFunding();
  flow.markFundingSubmitted({ chainId: "eip155:1", txId: "0xabc", submittedAt: checkedAt });
  return flow;
}

test("round-trips a pending funding flow", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client, fundingOnlyIntent);
  const persisted = flow.serialize();
  assert.equal(persisted.version, 1);
  assert.equal(persisted.snapshot.phase, "funding-pending");

  const resumed = client.hydrateFlow(persisted);
  assert.equal(resumed.getSnapshot().phase, "funding-pending");
  assert.equal(resumed.getSnapshot().fundingReference.txId, "0xabc");

  const snapshot = await resumed.refreshFunding();
  assert.equal(snapshot.phase, "completed");
});

test("drops wallet steps on rehydrate", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  assert.equal(flow.getSnapshot().fundingSteps.length, 1);

  const resumed = client.hydrateFlow(flow.serialize());
  assert.deepEqual(resumed.getSnapshot().fundingSteps, []);
  assert.equal(resumed.getSnapshot().phase, "quote-ready");
});

test("degrades an unsigned flow to idle once the quote has expired", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = client.createFlow();
  await flow.quote(fundingOnlyIntent);
  await flow.prepareFunding();
  const persisted = flow.serialize();

  const later = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    now: () => NOW + 120_000,
  });
  assert.equal(later.hydrateFlow(persisted).getSnapshot().phase, "idle");
});

test("rejects an unknown persisted version", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client, fundingOnlyIntent);
  const persisted = { ...flow.serialize(), version: 2 };
  assert.throws(() => client.hydrateFlow(persisted), (error) => {
    assert.equal(error.code, "UNSUPPORTED_PERSISTED_VERSION");
    return true;
  });
});

test("rejects a snapshot whose funding provider is no longer registered", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client, fundingOnlyIntent);
  const other = new RailClient({ fundingProviders: [provider("b", "99000000")], now });
  assert.throws(() => other.hydrateFlow(flow.serialize()), (error) => {
    assert.equal(error.code, "FUNDING_PLUGIN_NOT_FOUND");
    return true;
  });
});

test("restores terminal phases untouched", async () => {
  const client = new RailClient({ fundingProviders: [provider("a", "99000000")], now });
  const flow = await fundedFlow(client, fundingOnlyIntent);
  await flow.refreshFunding();
  assert.equal(client.hydrateFlow(flow.serialize()).getSnapshot().phase, "completed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: FAIL with `flow.serialize is not a function`.

- [ ] **Step 3: Write the rehydration rules**

Create `packages/core/src/persistence.ts`:

```ts
import { RailError } from "./errors.js";
import type { RailFlowPhase, RailFlowSnapshot } from "./flow.js";
import type { IntentQuote } from "./types.js";

export interface PersistedRailFlow {
  version: 1;
  persistedAt: string;
  snapshot: RailFlowSnapshot;
}

const RESUMABLE = new Set<RailFlowPhase>([
  "funding-pending",
  "destination-ready",
  "action-pending",
  "completed",
  "refunded",
  "failed",
]);

const DEGRADES_TO_QUOTE_READY = new Set<RailFlowPhase>([
  "quote-ready",
  "awaiting-source-signature",
  "awaiting-destination-signature",
]);

export interface PluginRegistry {
  hasFundingProvider(id: string): boolean;
  hasDestinationAction(id: string): boolean;
}

function invalid(message: string): never {
  throw new RailError("INVALID_PERSISTED_SNAPSHOT", message);
}

function selectedQuote(snapshot: RailFlowSnapshot): IntentQuote {
  const quote = snapshot.batch?.quotes.find((candidate) => candidate.id === snapshot.selectedQuoteId);
  if (!quote) invalid("The persisted snapshot has no resolvable selected quote.");
  return quote;
}

export function restoreSnapshot(
  persisted: PersistedRailFlow,
  registry: PluginRegistry,
  now: number,
  initial: RailFlowSnapshot,
): RailFlowSnapshot {
  if (!persisted || persisted.version !== 1) {
    throw new RailError(
      "UNSUPPORTED_PERSISTED_VERSION",
      "This persisted rail flow was written by an incompatible version.",
    );
  }
  const snapshot = persisted.snapshot;
  if (!snapshot || typeof snapshot.phase !== "string") {
    invalid("The persisted snapshot is malformed.");
  }
  const revision = Number.isSafeInteger(snapshot.revision) ? snapshot.revision : 0;
  const bare = { ...initial, revision };

  if (snapshot.phase === "idle") return Object.freeze(bare);

  const quote = selectedQuote(snapshot);
  if (!registry.hasFundingProvider(quote.funding.providerId)) {
    throw new RailError(
      "FUNDING_PLUGIN_NOT_FOUND",
      `Funding provider ${quote.funding.providerId} is missing.`,
    );
  }
  if (quote.action && !registry.hasDestinationAction(quote.action.pluginId)) {
    throw new RailError(
      "ACTION_PLUGIN_NOT_FOUND",
      `Destination action ${quote.action.pluginId} is missing.`,
    );
  }

  // Unsigned wallet steps carry stale blockhashes and TRON reference blocks.
  // They are never restored; the caller must prepare again.
  const withoutSteps: RailFlowSnapshot = {
    ...snapshot,
    revision,
    fundingSteps: [],
    actionSteps: [],
  };

  if (RESUMABLE.has(snapshot.phase)) return Object.freeze(withoutSteps);

  if (DEGRADES_TO_QUOTE_READY.has(snapshot.phase) && Date.parse(quote.expiresAt) > now) {
    return Object.freeze({
      ...withoutSteps,
      phase: "quote-ready",
      fundingReference: null,
      fundingStatus: null,
      actionReference: null,
      actionStatus: null,
      error: null,
    });
  }

  return Object.freeze(bare);
}
```

- [ ] **Step 4: Add serialize and a snapshot-accepting constructor**

In `packages/core/src/flow.ts`, import the type and accept an initial snapshot:

```ts
import type { PersistedRailFlow } from "./persistence.js";
```

```ts
  constructor(
    private readonly client: RailClient,
    snapshot?: RailFlowSnapshot,
  ) {
    if (snapshot) this.snapshot = snapshot;
  }

  serialize(): PersistedRailFlow {
    return {
      version: 1,
      persistedAt: new Date(this.client.now()).toISOString(),
      snapshot: this.snapshot,
    };
  }
```

Also export `INITIAL` so the client can pass it to `restoreSnapshot`:

```ts
export const INITIAL_SNAPSHOT: RailFlowSnapshot = INITIAL;
```

- [ ] **Step 5: Add hydrateFlow to the client**

In `packages/core/src/client.ts`, import `restoreSnapshot` from `./persistence.js` at the top of the file. Note that `client.ts` already imports `RailFlow` from `./flow.js` on its **last line**, deliberately, to break an import cycle. Add `INITIAL_SNAPSHOT` to that existing bottom import rather than creating a second one at the top:

```ts
import { INITIAL_SNAPSHOT, RailFlow } from "./flow.js";
```

Then add beside `createFlow()`:

```ts
  hydrateFlow(persisted: PersistedRailFlow) {
    const snapshot = restoreSnapshot(
      persisted,
      {
        hasFundingProvider: (id) => this.fundingProviders.has(id),
        hasDestinationAction: (id) => this.destinationActions.has(id),
      },
      this.now(),
      INITIAL_SNAPSHOT,
    );
    return new RailFlow(this, snapshot);
  }
```

- [ ] **Step 6: Export the new surface**

In `packages/core/src/index.ts`, add:

```ts
export type { PersistedRailFlow } from "./persistence.js";
```

- [ ] **Step 7: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: PASS, all six persistence tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src packages/core/test/persistence.test.mjs
git commit -m "feat(core): add resumable flow serialization and hydration"
```

---

## Task 3: Settlement verification

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/client.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/settlement-verifier.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SettlementVerifier` with `verify(request: { intent: FundingIntent; quote: FundingQuote; status: FundingStatus }, context: PluginContext): Promise<AssetAmount | null>`; `RailClientOptions.settlementVerifier?: SettlementVerifier`; error codes `SETTLEMENT_ASSET_MISMATCH` and `SETTLEMENT_BELOW_MINIMUM`. Task 6 implements this interface.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/settlement-verifier.test.mjs`, reusing the Task 1 fixtures. The provider's `getStatus` returns `received: null` and a `destinationReference`, exactly as `-layerzero` does.

```js
function verifier(amountBaseUnits, calls) {
  return {
    verify: async ({ status }) => {
      calls.push(status.reference.txId);
      return amountBaseUnits === null
        ? null
        : { asset: solanaUsdc, amountBaseUnits };
    },
  };
}

async function statusFor(client, intent) {
  const batch = await client.quote(intent);
  return client.getFundingStatus(batch.quotes[0], {
    chainId: "eip155:1",
    txId: "0xabc",
    submittedAt: checkedAt,
  });
}

test("splices a verified amount into the funding status", async () => {
  const calls = [];
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: verifier("99500000", calls),
    now,
  });
  const status = await statusFor(client, fundingOnlyIntent);
  assert.equal(status.received.amountBaseUnits, "99500000");
  assert.deepEqual(calls, ["0xabc"]);
});

test("rejects a delivery below the guaranteed minimum", async () => {
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: verifier("98000000", []),
    now,
  });
  await assert.rejects(() => statusFor(client, fundingOnlyIntent), (error) => {
    assert.equal(error.code, "SETTLEMENT_BELOW_MINIMUM");
    return true;
  });
});

test("rejects a verified amount in another asset", async () => {
  const foreign = { ...solanaUsdc, assetId: "solana:mainnet/spl:OtherMint", symbol: "USDT" };
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: { verify: async () => ({ asset: foreign, amountBaseUnits: "99500000" }) },
    now,
  });
  await assert.rejects(() => statusFor(client, fundingOnlyIntent), (error) => {
    assert.equal(error.code, "SETTLEMENT_ASSET_MISMATCH");
    return true;
  });
});

test("a null verification preserves the quoted-minimum fallback", async () => {
  const client = new RailClient({
    fundingProviders: [provider("a", "99000000")],
    settlementVerifier: verifier(null, []),
    now,
  });
  const status = await statusFor(client, fundingOnlyIntent);
  assert.equal(status.received, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: FAIL. `status.received` is null in the first test because nothing calls a verifier.

- [ ] **Step 3: Declare the interface**

In `packages/core/src/types.ts`, add above `RailClientOptions`:

```ts
export interface SettlementVerifier {
  verify(
    request: {
      intent: FundingIntent;
      quote: FundingQuote;
      status: FundingStatus;
    },
    context: PluginContext,
  ): Promise<AssetAmount | null>;
}
```

and extend the options:

```ts
export interface RailClientOptions {
  fundingProviders: FundingProviderPlugin[];
  destinationActions?: DestinationActionPlugin[];
  settlementVerifier?: SettlementVerifier;
  now?: () => number;
}
```

- [ ] **Step 4: Wire it into getFundingStatus**

In `packages/core/src/client.ts`, store it in the constructor:

```ts
  private readonly settlementVerifier: SettlementVerifier | null;
```

```ts
    this.settlementVerifier = options.settlementVerifier ?? null;
```

Then replace `getFundingStatus`:

```ts
  async getFundingStatus(
    quote: IntentQuote,
    reference: TransactionReference,
    options?: RailCallOptions,
  ) {
    validateReference(reference);
    const provider = this.requireFundingProvider(quote.funding.providerId);
    const pluginContext = context(this.now, options);
    const status = await provider.getStatus(
      { intent: quote.intent, quote: quote.funding, reference },
      pluginContext,
    );
    validateFundingStatus(status, reference, quote.intent.destination.settlementAsset);

    if (
      !this.settlementVerifier ||
      status.state !== "completed" ||
      status.received ||
      !status.destinationReference
    ) {
      return status;
    }

    const received = await this.settlementVerifier.verify(
      { intent: quote.intent, quote: quote.funding, status },
      pluginContext,
    );
    if (!received) return status;

    validateAssetAmount(received, "settlement.received");
    if (!sameAsset(received.asset, quote.funding.minimumOutput.asset)) {
      throw new RailError(
        "SETTLEMENT_ASSET_MISMATCH",
        "The verified settlement asset does not match the funding quote.",
      );
    }
    if (
      parseAmount(received.amountBaseUnits) <
      parseAmount(quote.funding.minimumOutput.amountBaseUnits)
    ) {
      throw new RailError(
        "SETTLEMENT_BELOW_MINIMUM",
        "The verified settlement amount is below the guaranteed minimum output.",
      );
    }

    const verified: FundingStatus = { ...status, received };
    validateFundingStatus(verified, reference, quote.intent.destination.settlementAsset);
    return verified;
  }
```

Add `validateAssetAmount` to the imports from `./validation.js`, and `FundingStatus` and `SettlementVerifier` to the type imports.

- [ ] **Step 5: Export the type**

In `packages/core/src/index.ts`, add `SettlementVerifier` to the exported type list, keeping alphabetical order.

- [ ] **Step 6: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: PASS, all four verifier tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/test/settlement-verifier.test.mjs
git commit -m "feat(core): verify settled funding amounts before the destination action"
```

---

## Task 4: `-solana` package scaffold and base58 codec

**Files:**
- Create: `packages/solana/package.json`, `packages/solana/tsconfig.json`, `packages/solana/README.md`, `packages/solana/LICENSE`, `packages/solana/src/base58.ts`, `packages/solana/src/index.ts`
- Test: `packages/solana/test/base58.test.mjs`
- Modify: root `package.json` scripts

**Interfaces:**
- Consumes: nothing.
- Produces: `decodeBase58(value: string): Uint8Array`; `encodeBase58(bytes: Uint8Array): string`; `toBytes32(address: string): \`0x${string}\``.

- [ ] **Step 1: Create the package manifest**

`packages/solana/package.json`. Copy `packages/layerzero/package.json` and change the name, description, and dependencies:

```json
{
  "name": "@hedgents/stablecoin-rail-solana",
  "version": "0.1.0",
  "description": "Solana address helpers and settlement verification for the Hedgents stablecoin rail.",
  "type": "module",
  "sideEffects": false,
  "license": "Apache-2.0",
  "author": "Hedgents",
  "files": ["dist", "README.md", "LICENSE"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "npm run build && node --test test/*.test.mjs",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@hedgents/stablecoin-rail": "0.2.0",
    "@noble/curves": "^1.9.0",
    "@noble/hashes": "^1.8.0"
  },
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public", "provenance": true }
}
```

`@noble/curves` is required in addition to `@noble/hashes` because associated-token-account derivation must reject on-curve candidates, which needs ed25519 point decoding. Deriving without that check silently produces a wrong address for roughly one owner and mint pair in 256.

Copy `packages/layerzero/tsconfig.json` and `LICENSE` verbatim. Add the package to the root `build`, `typecheck`, `test`, and `pack:check` script chains in the same position as the other packages, immediately after core.

- [ ] **Step 2: Write the failing test**

Create `packages/solana/test/base58.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { decodeBase58, encodeBase58, toBytes32 } from "../dist/index.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("decodes a Solana mint to thirty-two bytes", () => {
  assert.equal(decodeBase58(USDC_MINT).length, 32);
});

test("round-trips base58", () => {
  assert.equal(encodeBase58(decodeBase58(USDC_MINT)), USDC_MINT);
});

test("preserves leading zero bytes as leading ones", () => {
  const bytes = new Uint8Array([0, 0, 1]);
  const encoded = encodeBase58(bytes);
  assert.equal(encoded.slice(0, 2), "11");
  assert.deepEqual(decodeBase58(encoded), bytes);
});

test("rejects characters outside the alphabet", () => {
  assert.throws(() => decodeBase58("0OIl"));
});

test("renders a thirty-two byte address as hex", () => {
  const hex = toBytes32(USDC_MINT);
  assert.match(hex, /^0x[0-9a-f]{64}$/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-solana`
Expected: FAIL, the package does not build because `src/index.ts` does not exist.

- [ ] **Step 4: Implement the codec**

Create `packages/solana/src/base58.ts`:

```ts
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX = new Map<string, number>();
for (let i = 0; i < ALPHABET.length; i += 1) INDEX.set(ALPHABET[i]!, i);

export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();
  const bytes: number[] = [];
  for (const character of value) {
    let carry = INDEX.get(character);
    if (carry === undefined) {
      throw new Error(`"${character}" is not a base58 character.`);
    }
    for (let i = 0; i < bytes.length; i += 1) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < value.length && value[i] === "1"; i += 1) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let prefix = "";
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) prefix += "1";
  return prefix + digits.reverse().map((digit) => ALPHABET[digit]!).join("");
}

export function toBytes32(address: string): `0x${string}` {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) {
    throw new Error("A Solana address must decode to exactly thirty-two bytes.");
  }
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
```

Create `packages/solana/src/index.ts`:

```ts
export { decodeBase58, encodeBase58, toBytes32 } from "./base58.js";
```

- [ ] **Step 5: Install and run the tests**

Run: `npm install && npm test -w @hedgents/stablecoin-rail-solana`
Expected: PASS, all five tests.

- [ ] **Step 6: Commit**

```bash
git add packages/solana package.json package-lock.json
git commit -m "feat(solana): add the package scaffold and a base58 codec"
```

---

## Task 5: Associated token account derivation

**Files:**
- Create: `packages/solana/src/addresses.ts`
- Modify: `packages/solana/src/index.ts`
- Test: `packages/solana/test/addresses.test.mjs`

**Interfaces:**
- Consumes: `decodeBase58` and `encodeBase58` from Task 4.
- Produces: `SPL_TOKEN_PROGRAM_ID`, `TOKEN_2022_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID` constants; `deriveAssociatedTokenAddress(owner: string, mint: string, tokenProgram?: string): string`.

- [ ] **Step 1: Obtain a golden vector from mainnet**

Do not invent an expected address. Pick any mainnet wallet holding USDC and read its real associated token account:

```bash
curl -s https://api.mainnet-beta.solana.com -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner",
       "params":["<OWNER_WALLET>",
                 {"mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"},
                 {"encoding":"jsonParsed"}]}'
```

Record the owner and the returned `pubkey`. Use them as the fixture below. If the wallet's account was created as a non-associated token account, the derivation will not match; pick another owner until you have a pair where `result.value[0].pubkey` is the canonical ATA.

- [ ] **Step 2: Write the failing test**

Create `packages/solana/test/addresses.test.mjs`, substituting the values from Step 1:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { deriveAssociatedTokenAddress, TOKEN_2022_PROGRAM_ID } from "../dist/index.js";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "<OWNER_WALLET_FROM_STEP_1>";
const EXPECTED_ATA = "<PUBKEY_FROM_STEP_1>";

test("derives the canonical associated token account", () => {
  assert.equal(deriveAssociatedTokenAddress(OWNER, USDC_MINT), EXPECTED_ATA);
});

test("derivation is deterministic", () => {
  assert.equal(
    deriveAssociatedTokenAddress(OWNER, USDC_MINT),
    deriveAssociatedTokenAddress(OWNER, USDC_MINT),
  );
});

test("a different token program yields a different address", () => {
  assert.notEqual(
    deriveAssociatedTokenAddress(OWNER, USDC_MINT),
    deriveAssociatedTokenAddress(OWNER, USDC_MINT, TOKEN_2022_PROGRAM_ID),
  );
});

test("rejects a malformed owner", () => {
  assert.throws(() => deriveAssociatedTokenAddress("not-an-address", USDC_MINT));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-solana`
Expected: FAIL with `deriveAssociatedTokenAddress is not a function`.

- [ ] **Step 4: Implement derivation**

Create `packages/solana/src/addresses.ts`:

```ts
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { decodeBase58, encodeBase58 } from "./base58.js";

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function publicKeyBytes(address: string, field: string): Uint8Array {
  const bytes = decodeBase58(address);
  if (bytes.length !== 32) {
    throw new Error(`${field} must be a base58 Solana address of thirty-two bytes.`);
  }
  return bytes;
}

function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function findProgramAddress(seeds: Uint8Array[], programId: Uint8Array): string {
  for (let bump = 255; bump >= 0; bump -= 1) {
    const candidate = sha256(
      concat([...seeds, Uint8Array.from([bump]), programId, PDA_MARKER]),
    );
    if (!isOnCurve(candidate)) return encodeBase58(candidate);
  }
  throw new Error("No off-curve program address could be derived.");
}

export function deriveAssociatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: string = SPL_TOKEN_PROGRAM_ID,
): string {
  return findProgramAddress(
    [
      publicKeyBytes(owner, "owner"),
      publicKeyBytes(tokenProgram, "tokenProgram"),
      publicKeyBytes(mint, "mint"),
    ],
    publicKeyBytes(ASSOCIATED_TOKEN_PROGRAM_ID, "associatedTokenProgram"),
  );
}
```

Add to `packages/solana/src/index.ts`:

```ts
export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveAssociatedTokenAddress,
} from "./addresses.js";
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail-solana`
Expected: PASS. If the golden vector fails, the bug is in derivation, not in the fixture. Confirm the seed order is owner, token program, mint, and that the marker string is appended last.

- [ ] **Step 6: Commit**

```bash
git add packages/solana
git commit -m "feat(solana): derive associated token accounts with an on-curve check"
```

---

## Task 6: Solana settlement verifier

**Files:**
- Create: `packages/solana/src/verifier.ts`
- Modify: `packages/solana/src/index.ts`
- Test: `packages/solana/test/verifier.test.mjs`

**Interfaces:**
- Consumes: the `SettlementVerifier` interface from Task 3.
- Produces: `createSolanaSettlementVerifier(options: { rpcUrl: string; commitment?: "confirmed" | "finalized"; tokenProgram?: string; fetch?: typeof globalThis.fetch }): SettlementVerifier`.

- [ ] **Step 1: Write the failing test**

Create `packages/solana/test/verifier.test.mjs`. Build a fake `fetch` returning a recorded `getTransaction` shape.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { createSolanaSettlementVerifier } from "../dist/index.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OWNER = "DestinationWallet111111111111111111111111111";
const SPL = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const solanaUsdc = {
  chainId: "solana:mainnet",
  assetId: `solana:mainnet/spl:${MINT}`,
  symbol: "USDC",
  decimals: 6,
};

function request(overrides = {}) {
  return {
    intent: {
      destination: {
        account: { chainId: "solana:mainnet", address: OWNER },
        settlementAsset: solanaUsdc,
      },
    },
    quote: { minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" } },
    status: {
      state: "completed",
      destinationReference: { chainId: "solana:mainnet", txId: "solsig", submittedAt: "" },
    },
    ...overrides,
  };
}

function rpc(result) {
  return async () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
      headers: { "content-type": "application/json" },
    });
}

function transaction({ pre, post, owner = OWNER, mint = MINT, programId = SPL, err = null }) {
  return {
    meta: {
      err,
      preTokenBalances: pre === null
        ? []
        : [{ accountIndex: 3, mint, owner, programId, uiTokenAmount: { amount: pre } }],
      postTokenBalances: [
        { accountIndex: 3, mint, owner, programId, uiTokenAmount: { amount: post } },
      ],
    },
  };
}

const context = { now: () => Date.now() };

test("returns the token balance delta", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "1000000", post: "100500000" })),
  });
  const received = await verifier.verify(request(), context);
  assert.equal(received.amountBaseUnits, "99500000");
  assert.equal(received.asset.assetId, solanaUsdc.assetId);
});

test("treats a first-time recipient with no prior balance as a full delta", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: null, post: "99500000" })),
  });
  assert.equal((await verifier.verify(request(), context)).amountBaseUnits, "99500000");
});

test("returns null when the transaction is not indexed yet", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(null),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null for a failed transaction", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000", err: { InstructionError: [0, "Custom"] } })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null when no balance entry matches the owner and mint", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000", owner: "SomeoneElse1111111111111111111111111111111" })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null when the token program is not the expected one", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000", programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" })),
  });
  assert.equal(await verifier.verify(request(), context), null);
});

test("returns null without a Solana destination reference", async () => {
  const verifier = createSolanaSettlementVerifier({
    rpcUrl: "https://rpc.test",
    fetch: rpc(transaction({ pre: "0", post: "99500000" })),
  });
  const status = { state: "completed", destinationReference: null };
  assert.equal(await verifier.verify(request({ status }), context), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail-solana`
Expected: FAIL with `createSolanaSettlementVerifier is not a function`.

- [ ] **Step 3: Implement the verifier**

Create `packages/solana/src/verifier.ts`:

```ts
import type { AssetAmount, PluginContext, SettlementVerifier } from "@hedgents/stablecoin-rail";
import { SPL_TOKEN_PROGRAM_ID } from "./addresses.js";

export interface SolanaSettlementVerifierOptions {
  rpcUrl: string;
  commitment?: "confirmed" | "finalized";
  tokenProgram?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface TokenBalance {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  programId?: unknown;
  uiTokenAmount?: { amount?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "solana:mainnet/spl:EPjF..." becomes "EPjF...". */
function mintFromAssetId(assetId: string): string {
  const separator = assetId.lastIndexOf(":");
  return separator === -1 ? assetId : assetId.slice(separator + 1);
}

function balances(value: unknown): TokenBalance[] {
  return Array.isArray(value) ? (value as TokenBalance[]) : [];
}

function amountOf(entry: TokenBalance | undefined): bigint {
  const raw = entry?.uiTokenAmount?.amount;
  return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
}

export function createSolanaSettlementVerifier(
  options: SolanaSettlementVerifierOptions,
): SettlementVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const commitment = options.commitment ?? "confirmed";
  const expectedProgram = options.tokenProgram ?? SPL_TOKEN_PROGRAM_ID;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async verify({ intent, status }, context: PluginContext): Promise<AssetAmount | null> {
      const reference = status.destinationReference;
      if (!reference || !reference.chainId.startsWith("solana:")) return null;

      const settlementAsset = intent.destination.settlementAsset;
      const mint = mintFromAssetId(settlementAsset.assetId);
      const owner = intent.destination.account.address;

      let payload: unknown;
      try {
        const response = await fetchImpl(options.rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "rail-settlement",
            method: "getTransaction",
            params: [
              reference.txId,
              { encoding: "jsonParsed", commitment, maxSupportedTransactionVersion: 0 },
            ],
          }),
          signal: context.signal ?? AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        payload = await response.json();
      } catch {
        return null;
      }

      if (!isRecord(payload) || !isRecord(payload.result)) return null;
      const meta = payload.result.meta;
      if (!isRecord(meta) || meta.err) return null;

      const post = balances(meta.postTokenBalances).find(
        (entry) => entry.owner === owner && entry.mint === mint,
      );
      if (!post) return null;
      if (typeof post.programId === "string" && post.programId !== expectedProgram) return null;

      const pre = balances(meta.preTokenBalances).find(
        (entry) => entry.accountIndex === post.accountIndex && entry.mint === mint,
      );
      const delta = amountOf(post) - amountOf(pre);
      if (delta <= 0n) return null;

      return { asset: settlementAsset, amountBaseUnits: delta.toString() };
    },
  };
}
```

Add to `packages/solana/src/index.ts`:

```ts
export {
  createSolanaSettlementVerifier,
  type SolanaSettlementVerifierOptions,
} from "./verifier.js";
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail-solana`
Expected: PASS, all seven verifier tests.

- [ ] **Step 5: Write the package README**

Create `packages/solana/README.md` documenting: what the package is for, that `createSolanaSettlementVerifier` returns `null` rather than throwing on any unverifiable condition so an indexing lag degrades to the quoted-minimum fallback, and that `deriveAssociatedTokenAddress` performs the on-curve rejection required for correctness.

- [ ] **Step 6: Commit**

```bash
git add packages/solana
git commit -m "feat(solana): verify settlement by token-account balance delta"
```

---

## Task 7: Funding provider conformance suite

**Files:**
- Create: `packages/core/src/testing/index.ts`
- Modify: `packages/core/package.json`
- Test: `packages/core/test/conformance.test.mjs`

**Interfaces:**
- Consumes: core types.
- Produces: `ConformanceCase` (`{ name: string; run(): Promise<void> }`); `fundingProviderConformance(setup: { plugin: FundingProviderPlugin; supportedIntent: FundingIntent; unsupportedIntent: FundingIntent; now?: () => number }): ConformanceCase[]`. Task 8 adds `destinationActionConformance` to the same module.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/conformance.test.mjs`, reusing the Task 1 fixtures plus a deliberately broken provider.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { defineFundingProvider } from "../dist/index.js";
import { fundingProviderConformance } from "../dist/testing/index.js";

const unsupportedIntent = {
  ...fundingOnlyIntent,
  id: "intent-unsupported",
  source: {
    account: { chainId: "eip155:999", address: "0x3333333333333333333333333333333333333333" },
    asset: { ...ethereumUsdc, chainId: "eip155:999", assetId: "eip155:999/erc20:0xdead" },
  },
};

test("a well-formed provider passes every case", async () => {
  const cases = fundingProviderConformance({
    plugin: provider("a", "99000000"),
    supportedIntent: fundingOnlyIntent,
    unsupportedIntent,
    now,
  });
  assert.ok(cases.length >= 5);
  for (const item of cases) await item.run();
});

test("a provider that changes the input amount fails a case", async () => {
  const broken = defineFundingProvider({
    ...provider("broken", "99000000"),
    quote: async (intent) => ({
      id: "broken-quote",
      input: { asset: ethereumUsdc, amountBaseUnits: "1" },
      expectedOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
      minimumOutput: { asset: solanaUsdc, amountBaseUnits: "99000000" },
      fees: [],
      etaSeconds: 30,
      expiresAt,
      executionMode: "two-phase",
    }),
  });
  const cases = fundingProviderConformance({
    plugin: broken,
    supportedIntent: fundingOnlyIntent,
    unsupportedIntent,
    now,
  });
  const results = await Promise.allSettled(cases.map((item) => item.run()));
  assert.ok(results.some((result) => result.status === "rejected"));
});

test("a provider that claims to support a foreign intent fails a case", async () => {
  const greedy = defineFundingProvider({ ...provider("greedy", "99000000"), supports: () => true });
  const cases = fundingProviderConformance({
    plugin: greedy,
    supportedIntent: fundingOnlyIntent,
    unsupportedIntent,
    now,
  });
  const results = await Promise.allSettled(cases.map((item) => item.run()));
  assert.ok(results.some((result) => result.status === "rejected"));
});
```

Note: the `provider()` factory from Task 1 returns `supports: () => true`, so for the first test change its `supports` to compare `intent.source.account.chainId === "eip155:1"` when you copy it into this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: FAIL, `dist/testing/index.js` does not exist.

- [ ] **Step 3: Implement the suite**

Create `packages/core/src/testing/index.ts`:

```ts
import { RailError } from "../errors.js";
import type { FundingIntent, FundingProviderPlugin, PluginContext } from "../types.js";
import { parseAmount, validateFundingQuote, validateManifest, validateWalletSteps } from "../validation.js";

export interface ConformanceCase {
  name: string;
  run(): Promise<void>;
}

export interface FundingProviderConformanceSetup {
  plugin: FundingProviderPlugin;
  supportedIntent: FundingIntent;
  unsupportedIntent: FundingIntent;
  now?: () => number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RailError("CONFORMANCE_FAILED", message);
}

export function fundingProviderConformance(
  setup: FundingProviderConformanceSetup,
): ConformanceCase[] {
  const now = setup.now ?? Date.now;
  const context: PluginContext = { now };
  const { plugin, supportedIntent, unsupportedIntent } = setup;

  return [
    {
      name: "manifest declares a funding provider on API version 1",
      run: async () => {
        validateManifest(plugin.manifest, "funding-provider");
      },
    },
    {
      name: "supports accepts the supported intent",
      run: async () => {
        assert(await plugin.supports(supportedIntent), "supports rejected the supported intent.");
      },
    },
    {
      name: "supports rejects a foreign intent",
      run: async () => {
        assert(
          !(await plugin.supports(unsupportedIntent)),
          "supports accepted an intent on an unsupported chain or asset.",
        );
      },
    },
    {
      name: "quote returns null for a foreign intent instead of throwing",
      run: async () => {
        const draft = await plugin.quote(unsupportedIntent, context);
        assert(draft === null, "quote returned a draft for an unsupported intent.");
      },
    },
    {
      name: "quote satisfies the core funding-quote contract",
      run: async () => {
        const draft = await plugin.quote(supportedIntent, context);
        assert(draft !== null, "quote returned null for the supported intent.");
        validateFundingQuote(draft, supportedIntent, now());
      },
    },
    {
      name: "quote never promises a minimum above its expected output",
      run: async () => {
        const draft = await plugin.quote(supportedIntent, context);
        assert(draft !== null, "quote returned null for the supported intent.");
        assert(
          parseAmount(draft.minimumOutput.amountBaseUnits) <=
            parseAmount(draft.expectedOutput.amountBaseUnits),
          "minimumOutput exceeds expectedOutput.",
        );
      },
    },
    {
      name: "prepare returns valid wallet steps for its own quote",
      run: async () => {
        const draft = await plugin.quote(supportedIntent, context);
        assert(draft !== null, "quote returned null for the supported intent.");
        const steps = await plugin.prepare(
          {
            intent: supportedIntent,
            quote: {
              ...draft,
              providerId: plugin.manifest.id,
              providerName: plugin.manifest.name,
            },
          },
          context,
        );
        validateWalletSteps(steps);
      },
    },
    {
      name: "getStatus rejects a reference from the wrong chain",
      run: async () => {
        const draft = await plugin.quote(supportedIntent, context);
        assert(draft !== null, "quote returned null for the supported intent.");
        const quote = {
          ...draft,
          providerId: plugin.manifest.id,
          providerName: plugin.manifest.name,
        };
        let threw = false;
        try {
          await plugin.getStatus(
            {
              intent: supportedIntent,
              quote,
              reference: {
                chainId: "eip155:987654",
                txId: "0xdeadbeef",
                submittedAt: new Date(now()).toISOString(),
              },
            },
            context,
          );
        } catch {
          threw = true;
        }
        assert(threw, "getStatus accepted a reference from an unrelated chain.");
      },
    },
  ];
}
```

- [ ] **Step 4: Add the subpath export**

In `packages/core/package.json`, extend `exports`:

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./testing": {
      "types": "./dist/testing/index.d.ts",
      "import": "./dist/testing/index.js",
      "default": "./dist/testing/index.js"
    }
  },
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: PASS, all three conformance tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core
git commit -m "feat(core): add a runner-agnostic funding provider conformance suite"
```

---

## Task 8: Destination action conformance and LayerZero adoption

**Files:**
- Modify: `packages/core/src/testing/index.ts`
- Modify: `packages/core/test/conformance.test.mjs`
- Create: `packages/layerzero/test/conformance.test.mjs`

**Interfaces:**
- Consumes: `ConformanceCase` and `assert` from Task 7.
- Produces: `destinationActionConformance(setup: { plugin: DestinationActionPlugin; intent: FundingIntent; fundingQuote: FundingQuote; unsupportedFundingQuote: FundingQuote; now?: () => number }): ConformanceCase[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/conformance.test.mjs`:

```js
import { destinationActionConformance } from "../dist/testing/index.js";

const foreignSettlement = {
  chainId: "solana:mainnet",
  assetId: "solana:mainnet/spl:ForeignMint1111111111111111111111111111111",
  symbol: "USDT",
  decimals: 6,
};

function fundingQuoteFor(asset) {
  return {
    id: "funding-quote",
    providerId: "a",
    providerName: "A",
    input: { asset: ethereumUsdc, amountBaseUnits: "100000000" },
    expectedOutput: { asset, amountBaseUnits: "99500000" },
    minimumOutput: { asset, amountBaseUnits: "99000000" },
    fees: [],
    etaSeconds: 30,
    expiresAt,
    executionMode: "two-phase",
  };
}

test("a well-formed destination action passes every case", async () => {
  const cases = destinationActionConformance({
    plugin: action(),
    intent: { ...fundingOnlyIntent, action: { pluginId: "jupiter" } },
    fundingQuote: fundingQuoteFor(solanaUsdc),
    unsupportedFundingQuote: fundingQuoteFor(foreignSettlement),
    now,
  });
  assert.ok(cases.length >= 4);
  for (const item of cases) await item.run();
});
```

Define `action()` in this file as a `defineDestinationAction` plugin whose `supports` checks `fundingQuote.minimumOutput.asset.assetId === solanaUsdc.assetId`, whose `quote` consumes exactly `fundingQuote.minimumOutput` and returns a metal output, and whose `prepare` returns one valid Solana wallet step. Model it on the action plugin in `test/client.test.mjs`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: FAIL with `destinationActionConformance is not a function`.

- [ ] **Step 3: Implement the action suite**

Append to `packages/core/src/testing/index.ts`, extending the imports with `DestinationActionPlugin`, `FundingQuote`, and `validateActionQuote`:

```ts
export interface DestinationActionConformanceSetup {
  plugin: DestinationActionPlugin;
  intent: FundingIntent;
  fundingQuote: FundingQuote;
  unsupportedFundingQuote: FundingQuote;
  now?: () => number;
}

export function destinationActionConformance(
  setup: DestinationActionConformanceSetup,
): ConformanceCase[] {
  const now = setup.now ?? Date.now;
  const context: PluginContext = { now };
  const { plugin, intent, fundingQuote, unsupportedFundingQuote } = setup;

  return [
    {
      name: "manifest declares a destination action on API version 1",
      run: async () => {
        validateManifest(plugin.manifest, "destination-action");
      },
    },
    {
      name: "supports accepts its own settlement asset and rejects a foreign one",
      run: async () => {
        assert(
          await plugin.supports({ intent, fundingQuote }),
          "supports rejected its own settlement asset.",
        );
        assert(
          !(await plugin.supports({ intent, fundingQuote: unsupportedFundingQuote })),
          "supports accepted a foreign settlement asset.",
        );
      },
    },
    {
      name: "quote is sized from the funding route's guaranteed minimum",
      run: async () => {
        const draft = await plugin.quote({ intent, fundingQuote }, context);
        assert(draft !== null, "quote returned null for a supported funding route.");
        validateActionQuote(draft, fundingQuote, now());
      },
    },
    {
      name: "prepare returns valid wallet steps for its own quote",
      run: async () => {
        const draft = await plugin.quote({ intent, fundingQuote }, context);
        assert(draft !== null, "quote returned null for a supported funding route.");
        const steps = await plugin.prepare(
          {
            intent,
            fundingQuote,
            actionQuote: {
              ...draft,
              pluginId: plugin.manifest.id,
              pluginName: plugin.manifest.name,
            },
          },
          context,
        );
        validateWalletSteps(steps);
      },
    },
  ];
}
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w @hedgents/stablecoin-rail`
Expected: PASS.

- [ ] **Step 5: Run the LayerZero adapter against the suite**

Create `packages/layerzero/test/conformance.test.mjs`. `LayerZeroTransferApiOptions` already accepts an injected `fetch`, and `packages/layerzero/test/plugin.test.mjs` lines 77 to 115 show the exact stubbing pattern. Copy its recorded quote, user-step, and status payloads, and route by URL path.

```js
import assert from "node:assert/strict";
import test from "node:test";
import { fundingProviderConformance } from "@hedgents/stablecoin-rail/testing";
import { createLayerZeroUsdt0TronToSolana } from "../dist/index.js";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");
const now = () => NOW;

// Reuse the recorded fixtures from plugin.test.mjs: QUOTE_RESPONSE, USER_STEPS_RESPONSE,
// STATUS_RESPONSE, plus the tronIntent built from TRON_USDT and SOLANA_USDT in src/assets.ts.

const plugin = createLayerZeroUsdt0TronToSolana({
  apiKey: "test-key",
  fetch: async (input) => {
    const url = String(input);
    const body = url.includes("/quotes")
      ? QUOTE_RESPONSE
      : url.includes("/steps")
        ? USER_STEPS_RESPONSE
        : STATUS_RESPONSE;
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  },
  // The adapter refuses to prepare without a policy. A permissive stub is correct
  // for a contract test and must never appear outside tests.
  validateTronTransaction: async () => {},
});

const ethereumIntent = {
  ...tronIntent,
  id: "intent-ethereum",
  source: {
    account: { chainId: "eip155:1", address: "0x1111111111111111111111111111111111111111" },
    asset: {
      chainId: "eip155:1",
      assetId: "eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7",
      symbol: "USDT",
      decimals: 6,
    },
  },
};

test("the USDT0 adapter satisfies the funding provider contract", async () => {
  const cases = fundingProviderConformance({
    plugin,
    supportedIntent: tronIntent,
    unsupportedIntent: ethereumIntent,
    now,
  });
  for (const item of cases) await item.run();
});
```

The recorded quote's `expiresAt` must be later than `NOW`, or the `validateFundingQuote` case fails on expiry rather than on the behaviour under test.

If a case fails, fix the adapter, not the suite, unless the suite asserts something the spec does not require. Record any such deviation in the commit message.

- [ ] **Step 6: Run the full workspace**

Run: `npm run typecheck && npm test`
Expected: PASS across all packages.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/layerzero
git commit -m "feat(core): add destination action conformance and apply the suite to USDT0"
```

---

## Task 9: Version bump and documentation

**Files:**
- Modify: `packages/core/package.json`, `packages/layerzero/package.json`, `packages/react/package.json`
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `docs/PLUGINS.md`, `docs/PRODUCT_VISION_AND_MVP.md`

**Interfaces:**
- Consumes: everything above.
- Produces: core at `0.2.0`, dependents pinned to it.

- [ ] **Step 1: Bump versions**

Set `packages/core/package.json` version to `0.2.0`. Update the `@hedgents/stablecoin-rail` dependency in `packages/layerzero` to `0.2.0` and the peer dependency in `packages/react` to `^0.2.0`. Run `npm install` to refresh the lockfile.

- [ ] **Step 2: Document the new core surface**

In `docs/ARCHITECTURE.md`, add three short sections: funding-only intents and how ranking falls back to guaranteed settlement output; the resume contract, stating plainly that wallet steps are always dropped on rehydrate and that a host must persist a funding reference immediately on submission; and settlement verification, stating that a verified amount below the guaranteed minimum stops the flow.

In `docs/PLUGINS.md`, add a section pointing provider authors at `@hedgents/stablecoin-rail/testing` with a runnable snippet.

In `README.md`, add `@hedgents/stablecoin-rail-solana` to the package list.

- [ ] **Step 3: Update the implementation status honestly**

In `docs/PRODUCT_VISION_AND_MVP.md` §9, move to Completed: optional destination action, resumable flow, settlement verification, Solana receipt verification, plugin conformance suite. Leave in Not completed: npm publishing, LayerZero credentials, the USDT0 target set, the TRON mainnet transfer, the Allbridge fallback, CCTP and Mayan providers, and the independent security review.

Do not change any row of the §8 route matrix. No route has moved value.

- [ ] **Step 4: Verify the whole workspace**

Run: `npm run typecheck && npm test && npm run pack:check`
Expected: PASS. `pack:check` must list `dist/testing/` in the core tarball.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: release core 0.2.0 with the solana package and conformance suite"
```

---

## Self-review notes

**Spec coverage.** P1 items map to Tasks 1 to 3. P2 maps to Tasks 4 to 6. P3 maps to Tasks 7 and 8. Task 9 covers the version and documentation obligations. Spec sections not covered here by design: `-cctp` (P4), `-mayan` (P5), `core/remote` (P6), the reference app and TRON activation checklist (P7). Those get their own plans.

**Deviation from the spec.** The spec names `@noble/hashes` as the only `-solana` dependency. Implementation requires `@noble/curves` as well, because associated-token-account derivation must reject on-curve candidates and hashing alone cannot do that. Update the spec's dependency line when this plan is executed.

**Known fixture dependency.** Task 5 Step 1 requires one live mainnet RPC read to obtain a golden vector. This is the only step in the plan that touches a network, it is a development-time action rather than a test, and the resulting value is pinned as a constant.
