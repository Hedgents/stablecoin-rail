import { useEffect, useMemo, useRef, useState } from "react";
import {
  RailClient,
  type FundingIntent,
  type PersistedRailFlow,
  type WalletStep,
} from "@hedgents/stablecoin-rail";
import { createRemoteFundingProvider } from "@hedgents/stablecoin-rail/remote";
import { decodeBase58 } from "@hedgents/stablecoin-rail-solana";
import { useRailFlow } from "@hedgents/stablecoin-rail-react";
import { connectEvm, connectTron, sendTokenTransfer, submitStep } from "./wallets.js";

const STORAGE_KEY = "rail-bridge-demo/flow";
/**
 * The destination is the one field where a mistake is unrecoverable, so it is
 * checked properly: a base58 string of the right length can still decode to the
 * wrong number of bytes, and only a decode proves it is a Solana address.
 *
 * No wallet connection is needed here. A funding-only intent settles into this
 * account; nothing is ever signed on Solana.
 */
function isSolanaAddress(value: string): boolean {
  try {
    return decodeBase58(value.trim()).length === 32;
  } catch {
    return false;
  }
}

interface Support {
  address: string;
  suggestedUsd: number;
}

interface Route {
  id: string;
  pluginId?: string;
  providerName?: string;
  namespace: "evm" | "tron";
  label: string;
  chainId: string;
  numericChainId?: number;
  token: { address: string; symbol: string; decimals: number };
  assetId: string;
  settlement: { symbol: string; mint: string; decimals: number };
  settlementAssetId: string;
  native: boolean;
  status: "live" | "gated" | "unavailable";
  note: string;
}

/** Decimal string to base units, without touching floating point. */
function toBaseUnits(input: string, decimals: number): bigint | null {
  if (!/^\d*(\.\d*)?$/.test(input.trim()) || input.trim() === "" || input.trim() === ".") return null;
  const [whole = "0", fraction = ""] = input.trim().split(".");
  if (fraction.length > decimals) return null;
  const value = BigInt(whole + fraction.padEnd(decimals, "0"));
  return value > 0n ? value : null;
}

/** "9.873555 USDC" from an AssetAmount. */
function amountOf(amount: { amountBaseUnits: string; asset: { decimals: number; symbol: string } }): string {
  return `${fromBaseUnits(amount.amountBaseUnits, amount.asset.decimals)} ${amount.asset.symbol}`;
}

/**
 * Whether a route's expected and guaranteed amounts differ.
 *
 * CCTP fees are fixed at quote time so the two are identical, but a swap-based
 * route quotes a range. Showing only the minimum there understates what the
 * user will most likely receive; showing only the expected would overstate what
 * they are actually promised.
 */
function hasSpread(funding: { expectedOutput: { amountBaseUnits: string }; minimumOutput: { amountBaseUnits: string } }) {
  return funding.expectedOutput.amountBaseUnits !== funding.minimumOutput.amountBaseUnits;
}

function fromBaseUnits(value: string, decimals: number): string {
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function readPersisted(): PersistedRailFlow | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedRailFlow) : null;
  } catch {
    return null;
  }
}

export function App() {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [support, setSupport] = useState<Support | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/routes")
      .then((response) => response.json())
      .then((body: { routes: Route[]; support: Support | null }) => {
        setRoutes(body.routes);
        setSupport(body.support ?? null);
      })
      .catch(() => setLoadError("Could not reach the rail server. Is `npm run server` running?"));
  }, []);

  // One remote provider per plugin the server exposes. Nothing secret crosses:
  // the browser holds only the plugin contract and an endpoint. RailClient
  // requires at least one provider, so it is built after routes arrive.
  const client = useMemo(() => {
    if (!routes) return null;
    const live = new Map<string, string>();
    for (const route of routes) {
      if (route.status === "live" && route.pluginId) {
        live.set(route.pluginId, route.providerName ?? route.pluginId);
      }
    }
    if (live.size === 0) return null;
    return new RailClient({
      fundingProviders: [...live].map(([id, name]) =>
        createRemoteFundingProvider({
          manifest: { id, name, version: "0.1.0", apiVersion: 1, kind: "funding-provider" },
          endpoint: "/api/rail",
        }),
      ),
    });
  }, [routes]);

  if (loadError) return <main><p className="error">{loadError}</p></main>;
  if (!routes) return <main><p>Loading routes…</p></main>;
  if (!client) {
    return (
      <main>
        <p className="error">
          No route is live. Every provider is gated or unavailable; see the server log for the reason.
        </p>
      </main>
    );
  }
  return <Bridge client={client} routes={routes} support={support} />;
}

function Bridge({
  client,
  routes,
  support,
}: {
  client: RailClient;
  routes: Route[];
  support: Support | null;
}) {
  const [routeId, setRouteId] = useState<string>(
    () => routes.find((route) => route.status === "live")?.id ?? routes[0]?.id ?? "",
  );
  const [amount, setAmount] = useState("10");
  const [destination, setDestination] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [donation, setDonation] = useState<{ hash: string } | null>(null);
  const persisted = useRef<PersistedRailFlow | null>(readPersisted());

  const flow = useRailFlow(client, { persisted: persisted.current });

  // Persist on every transition so a reload can never strand an in-flight
  // transfer. The reference is written the instant it exists.
  useEffect(() => {
    if (flow.snapshot.phase === "idle") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(flow.serialize()));
  }, [flow, flow.snapshot.revision]);

  // Poll while funding is in flight.
  useEffect(() => {
    if (flow.snapshot.phase !== "funding-pending") return;
    const timer = setInterval(() => void flow.refreshFunding().catch(() => {}), 8_000);
    return () => clearInterval(timer);
  }, [flow, flow.snapshot.phase]);

  const route = routes.find((candidate) => candidate.id === routeId) ?? null;
  const destinationValid = isSolanaAddress(destination);
  const snapshot = flow.snapshot;

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function onConnect() {
    if (!route) return;
    await run("Connecting", async () => {
      setAccount(
        route.namespace === "evm" ? await connectEvm(route.numericChainId ?? 1) : await connectTron(),
      );
    });
  }

  async function onQuote() {
    if (!route || !account) return;
    const units = toBaseUnits(amount, route.token.decimals);
    if (!units) throw new Error("Enter a valid amount.");
    if (!isSolanaAddress(destination)) {
      setError("That is not a valid Solana address. Funds sent to a wrong address cannot be recovered.");
      return;
    }
    // A funding-only intent: no `action`, so nothing is signed on Solana and
    // the stablecoin simply lands in the destination wallet.
    const intent: FundingIntent = {
      id: `bridge-${Date.now()}`,
      source: {
        account: { chainId: route.chainId, address: account },
        asset: {
          chainId: route.chainId,
          assetId: route.assetId,
          symbol: route.token.symbol,
          decimals: route.token.decimals,
        },
      },
      destination: {
        account: { chainId: "solana:mainnet", address: destination },
        settlementAsset: {
          chainId: "solana:mainnet",
          assetId: route.settlementAssetId,
          symbol: route.settlement.symbol,
          decimals: route.settlement.decimals,
        },
      },
      inputAmountBaseUnits: units.toString(),
      slippageBps: 50,
    };
    await run("Quoting", () => flow.quote(intent));
  }

  async function onSign() {
    if (!account) return;
    await run("Signing", async () => {
      const snap = await flow.prepareFunding();
      let fundingHash: string | null = null;
      for (const step of snap.fundingSteps as WalletStep[]) {
        const hash = await submitStep(step, account);
        // The reference is the funding transaction, not an approval.
        if (step.kind === "funding") fundingHash = hash;
      }
      if (!fundingHash) throw new Error("No funding transaction was produced.");
      flow.markFundingSubmitted({
        chainId: snap.fundingSteps[0]!.chainId,
        txId: fundingHash,
        submittedAt: new Date().toISOString(),
      });
    });
  }

  const selected = flow.selectedQuote;

  return (
    <main>
      <header>
        <h1>Stablecoin Rail</h1>
        <p>
          Move a stablecoin from another chain into a Solana wallet. Funding only: no destination
          action, so nothing is ever signed on Solana. Provider credentials stay on the server.
        </p>
      </header>

      {error ? <p className="error">{error}</p> : null}

      <section>
        <h2>1. Route</h2>
        <div className="routes">
          {routes.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={candidate.id === routeId ? "route selected" : "route"}
              disabled={candidate.status !== "live"}
              onClick={() => {
                if (candidate.chainId !== route?.chainId) setAccount(null);
                setRouteId(candidate.id);
              }}
            >
              <strong>{candidate.label}</strong>
              <span>
                {candidate.token.symbol} → {candidate.settlement.symbol}
              </span>
              <em className={`status ${candidate.status}`}>{candidate.status}</em>
              <small>{candidate.note}</small>
            </button>
          ))}
        </div>
        {route && !route.native ? (
          <p className="warn">
            This route crosses an issuer boundary. {route.note}
          </p>
        ) : null}
      </section>

      <section>
        <h2>2. Amount and destination</h2>
        <p className="hint">
          The source wallet signs, so it must be connected. The destination only receives, so an
          address is enough.
        </p>
        <label>
          Amount ({route?.token.symbol ?? "token"})
          <input value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
        </label>
        <label>
          Solana destination wallet
          <input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="Base58 address that will receive the stablecoin"
            spellCheck={false}
            aria-invalid={destination.length > 0 && !destinationValid}
          />
          <small className={destinationValid ? "ok" : "hint"}>
            {destination.length === 0
              ? "No wallet connection needed. This address receives the stablecoin; nothing is signed on Solana."
              : destinationValid
                ? "Valid Solana address."
                : "Not a valid Solana address. Funds sent to a wrong address cannot be recovered."}
          </small>
        </label>
        <div className="row">
          <button type="button" onClick={onConnect} disabled={!route || busy !== null}>
            {account
              ? `Connected on ${route?.label ?? "source"} · ${account.slice(0, 6)}…${account.slice(-4)}`
              : `Connect ${route?.label ?? "source"} wallet`}
          </button>
          <button type="button" onClick={onQuote} disabled={!account || !destinationValid || busy !== null}>
            Find routes
          </button>
        </div>
      </section>

      {snapshot.batch && snapshot.batch.quotes.length > 0 ? (
        <section>
          <h2>3. Quotes</h2>
          <p className="hint">
            Ranked by what is <em>guaranteed</em> to arrive on Solana, not by advertised bridge fee.
            A swap-based route also shows its expected amount; the guarantee is the number you are owed.
          </p>
          {snapshot.batch.quotes.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className={candidate.id === snapshot.selectedQuoteId ? "quote selected" : "quote"}
              onClick={() => flow.selectQuote(candidate.id)}
              disabled={snapshot.phase !== "quote-ready"}
            >
              <strong>{candidate.funding.providerName}</strong>
              <span>
                {hasSpread(candidate.funding)
                  ? `≈ ${amountOf(candidate.funding.expectedOutput)} expected`
                  : amountOf(candidate.funding.minimumOutput)}
              </span>
              <span className="guaranteed">
                at least {amountOf(candidate.funding.minimumOutput)} guaranteed
              </span>
              <small>~{candidate.totalEtaSeconds}s · expires {new Date(candidate.expiresAt).toLocaleTimeString()}</small>
            </button>
          ))}
          {snapshot.batch.failures.length > 0 ? (
            <details>
              <summary>{snapshot.batch.failures.length} provider(s) declined</summary>
              <ul>
                {snapshot.batch.failures.map((failure, index) => (
                  <li key={index}>
                    <code>{failure.code}</code> {failure.message}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {selected ? (
        <section>
          <h2>4. Send</h2>
          <dl>
            <div>
              <dt>You send on {route?.label ?? "the source chain"}</dt>
              <dd>{amountOf(selected.funding.input)}</dd>
            </div>
            {hasSpread(selected.funding) ? (
              <div>
                <dt>Expected on Solana</dt>
                <dd>≈ {amountOf(selected.funding.expectedOutput)}</dd>
              </div>
            ) : null}
            <div>
              <dt>
                <strong>Guaranteed on Solana</strong>
              </dt>
              <dd>
                <strong>{amountOf(selected.funding.minimumOutput)}</strong>
              </dd>
            </div>
            {selected.funding.fees.map((fee, index) => (
              <div key={index}>
                <dt>{fee.label}</dt>
                <dd>
                  {fromBaseUnits(fee.amount.amountBaseUnits, fee.amount.asset.decimals)}{" "}
                  {fee.amount.asset.symbol}
                </dd>
              </div>
            ))}
          </dl>
          <p className="hint">
            Two phases, not one atomic operation: the transfer settles first, and this demo stops
            there. Signing may take more than one wallet approval.
          </p>
          <button
            type="button"
            onClick={onSign}
            disabled={snapshot.phase !== "quote-ready" || busy !== null}
          >
            Sign and send
          </button>
        </section>
      ) : null}

      <section>
        <h2>Status</h2>
        <p>
          <code>{snapshot.phase}</code>
          {busy ? ` · ${busy}…` : ""}
        </p>
        {snapshot.fundingReference ? (
          <p className="hint">
            Source transaction <code>{snapshot.fundingReference.txId}</code>
          </p>
        ) : null}
        {snapshot.fundingStatus ? <p className="hint">{snapshot.fundingStatus.detail}</p> : null}
        {snapshot.phase === "completed" ? (
          <div className="landed">
            <p className="done">Transaction landed.</p>
            {selected ? (
              <p className="hint">
                At least {amountOf(selected.funding.minimumOutput)} is now in{" "}
                <code>{selected.intent.destination.account.address}</code>.
              </p>
            ) : null}

            {support && route?.namespace === "evm" && account ? (
              donation ? (
                <p className="done">
                  Thank you. Donation sent: <code>{donation.hash}</code>
                </p>
              ) : (
                <div className="support">
                  <p>
                    This bridge is free and the SDK behind it is open source. Your support keeps it
                    that way.
                  </p>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      run("Donating", async () => {
                        const units = toBaseUnits(String(support.suggestedUsd), route.token.decimals);
                        if (!units) throw new Error("Invalid donation amount.");
                        const hash = await sendTokenTransfer({
                          token: route.token.address,
                          to: support.address,
                          amountBaseUnits: units,
                          numericChainId: route.numericChainId ?? 1,
                          account,
                        });
                        setDonation({ hash });
                      })
                    }
                  >
                    Donate ${support.suggestedUsd} {route.token.symbol}
                  </button>
                  <small className="hint">
                    Entirely optional and completely separate from your transfer, which is already
                    complete. This is a new transaction on {route.label} for{" "}
                    {support.suggestedUsd} {route.token.symbol} to <code>{support.address}</code>,
                    and it costs gas. Nothing happens unless you sign it.
                  </small>
                </div>
              )
            ) : null}
          </div>
        ) : null}
        {snapshot.error ? (
          <p className="error">
            <code>{snapshot.error.code}</code> {snapshot.error.message}
          </p>
        ) : null}
        {snapshot.phase !== "idle" ? (
          <button
            type="button"
            className="link"
            onClick={() => {
              flow.reset();
              window.localStorage.removeItem(STORAGE_KEY);
            }}
          >
            Start over
          </button>
        ) : null}
        <p className="hint">
          This flow is written to localStorage on every transition. Reload the page mid-transfer and
          it resumes; unsigned steps are discarded and re-prepared, never restored.
        </p>
      </section>
    </main>
  );
}
