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

interface Amount {
  amountBaseUnits: string;
  asset: { decimals: number; symbol: string };
}

/** Decimal string to base units, without touching floating point. */
function toBaseUnits(input: string, decimals: number): bigint | null {
  const text = input.trim();
  if (!/^\d*(\.\d*)?$/.test(text) || text === "" || text === ".") return null;
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > decimals) return null;
  const value = BigInt(whole + fraction.padEnd(decimals, "0"));
  return value > 0n ? value : null;
}

function fromBaseUnits(value: string, decimals: number): string {
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

const amountOf = (amount: Amount) =>
  `${fromBaseUnits(amount.amountBaseUnits, amount.asset.decimals)} ${amount.asset.symbol}`;
const bare = (amount: Amount) => fromBaseUnits(amount.amountBaseUnits, amount.asset.decimals);

/**
 * Whether a route's expected and guaranteed amounts differ. CCTP fees are fixed
 * at quote time so the two match; a swap-based route quotes a range.
 */
const hasSpread = (funding: { expectedOutput: Amount; minimumOutput: Amount }) =>
  funding.expectedOutput.amountBaseUnits !== funding.minimumOutput.amountBaseUnits;

/**
 * The destination is the one field where a mistake is unrecoverable, so it is
 * checked properly: a base58 string of the right length can still decode to the
 * wrong number of bytes, and only a decode proves it is a Solana address.
 */
function isSolanaAddress(value: string): boolean {
  try {
    return decodeBase58(value.trim()).length === 32;
  } catch {
    return false;
  }
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
  const [signingEnabled, setSigningEnabled] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/routes")
      .then((response) => response.json())
      .then((body: { routes: Route[]; support: Support | null; signingEnabled?: boolean }) => {
        setRoutes(body.routes);
        setSupport(body.support ?? null);
        setSigningEnabled(Boolean(body.signingEnabled));
      })
      .catch(() => setLoadError("Could not reach the rail server."));
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

  if (loadError) return <div className="centered">{loadError}</div>;
  if (!routes) return <div className="centered">Initialising…</div>;
  if (!client) return <div className="centered">No route is live. Every provider is gated.</div>;

  return (
    <Bridge client={client} routes={routes} support={support} signingEnabled={signingEnabled} />
  );
}

function Bridge({
  client,
  routes,
  support,
  signingEnabled,
}: {
  client: RailClient;
  routes: Route[];
  support: Support | null;
  signingEnabled: boolean;
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

  useEffect(() => {
    if (flow.snapshot.phase !== "funding-pending") return;
    const timer = setInterval(() => void flow.refreshFunding().catch(() => {}), 8_000);
    return () => clearInterval(timer);
  }, [flow, flow.snapshot.phase]);

  const route = routes.find((candidate) => candidate.id === routeId) ?? null;
  const destinationValid = isSolanaAddress(destination);
  const snapshot = flow.snapshot;
  const selected = flow.selectedQuote;
  const liveCount = routes.filter((candidate) => candidate.status === "live").length;

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
    await run("connecting", async () => {
      setAccount(
        route.namespace === "evm" ? await connectEvm(route.numericChainId ?? 1) : await connectTron(),
      );
    });
  }

  async function onQuote() {
    if (!route || !account) return;
    const units = toBaseUnits(amount, route.token.decimals);
    if (!units) {
      setError("Enter a valid amount.");
      return;
    }
    if (!destinationValid) {
      setError("That is not a valid Solana address.");
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
        account: { chainId: "solana:mainnet", address: destination.trim() },
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
    await run("quoting", () => flow.quote(intent));
  }

  async function onSign() {
    if (!account) return;
    await run("signing", async () => {
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

  const outputAmount = selected ? bare(selected.funding.minimumOutput) : "0.00";
  const rate =
    selected && Number(bare(selected.funding.input)) > 0
      ? (Number(outputAmount) / Number(bare(selected.funding.input))).toFixed(6)
      : null;

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          Stablecoin<span>·</span>Rail
        </h1>
        <div className="readout">
          <span>
            routes <b>{liveCount}/{routes.length}</b>
          </span>
          <span>
            signing <b>{signingEnabled ? "armed" : "off"}</b>
          </span>
          <span>
            settle <b>solana</b>
          </span>
        </div>
      </header>

      <p className="notice">
        <b>Unaudited demonstration.</b> No route here has completed a mainnet transfer and the SDK
        has not had an independent security review.{" "}
        {signingEnabled
          ? "Signing is armed: transactions are real and irreversible."
          : "Signing is disabled on this deployment, so quotes are live but nothing can be sent."}
      </p>

      {/* ------------------------------------------------ source selection */}
      <section className="panel p1">
        <div className="panel-head">
          <span>Source</span>
          <span>funding chain</span>
        </div>

        <div className="chains" role="group" aria-label="Source chain">
          {routes.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="chip"
              aria-pressed={candidate.id === routeId}
              disabled={candidate.status !== "live"}
              title={candidate.note}
              onClick={() => {
                // An account bound to one chain is not usable on another.
                if (candidate.chainId !== route?.chainId) setAccount(null);
                setRouteId(candidate.id);
              }}
            >
              <span>
                <i className={`led ${candidate.status}`} />
                {candidate.label}
              </span>
              <em>
                {candidate.token.symbol}
                {candidate.status === "live" ? "" : ` · ${candidate.status}`}
              </em>
            </button>
          ))}
        </div>

        <div className="leg">
          <span className="leg-label">You send</span>
          <div className="leg-row">
            <input
              className="amount-in"
              value={amount}
              inputMode="decimal"
              placeholder="0.00"
              aria-label="Amount to send"
              onChange={(event) => setAmount(event.target.value)}
            />
            <span className="ticker">{route?.token.symbol ?? "—"}</span>
          </div>
          <div className="leg-foot">
            <span>{route?.label ?? "—"}</span>
            <button type="button" className="ghost" onClick={onConnect} disabled={!route || busy !== null}>
              {account
                ? `${account.slice(0, 6)}…${account.slice(-4)}`
                : `Connect ${route?.label ?? "wallet"}`}
            </button>
          </div>
        </div>

        <div className="seam">
          <span aria-hidden="true">↓</span>
        </div>

        <div className="leg">
          <span className="leg-label">You receive · guaranteed</span>
          <div className="leg-row">
            <span className={selected ? "amount-out" : "amount-out idle"}>{outputAmount}</span>
            <span className="ticker">{route?.settlement.symbol ?? "—"}</span>
          </div>
          <input
            className="addr"
            value={destination}
            spellCheck={false}
            placeholder="Solana destination wallet"
            aria-label="Solana destination wallet"
            aria-invalid={destination.length > 0 && !destinationValid}
            onChange={(event) => setDestination(event.target.value)}
          />
          <small className={`field-note ${destination.length === 0 ? "" : destinationValid ? "ok" : "bad"}`}>
            {destination.length === 0
              ? "No wallet connection needed. This address receives the stablecoin; nothing is signed on Solana."
              : destinationValid
                ? "Valid Solana address."
                : "Not a valid Solana address. Funds sent to a wrong address cannot be recovered."}
          </small>
        </div>

        {selected && hasSpread(selected.funding) ? (
          <p className="rate">
            expected ≈ {amountOf(selected.funding.expectedOutput)} · guaranteed is the number you are
            owed
          </p>
        ) : null}
        {rate ? <p className="rate">1 {selected!.funding.input.asset.symbol} → {rate} {selected!.funding.minimumOutput.asset.symbol}</p> : null}
      </section>

      <button
        type="button"
        className="execute"
        onClick={selected && snapshot.phase === "quote-ready" ? onSign : onQuote}
        disabled={
          !account ||
          !destinationValid ||
          busy !== null ||
          (selected != null && snapshot.phase === "quote-ready" && !signingEnabled)
        }
      >
        {busy
          ? `${busy}…`
          : !account
            ? "Connect source wallet"
            : selected && snapshot.phase === "quote-ready"
              ? signingEnabled
                ? "Sign and send"
                : "Signing disabled on this deployment"
              : "Find routes"}
      </button>

      {error ? <p className="notice fail">{error}</p> : null}

      {/* ------------------------------------------------------- quotes */}
      {snapshot.batch && snapshot.batch.quotes.length > 0 ? (
        <section className="panel p2">
          <div className="panel-head">
            <span>Routes</span>
            <span>ranked by guaranteed output</span>
          </div>
          {snapshot.batch.quotes.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="quote"
              aria-pressed={candidate.id === snapshot.selectedQuoteId}
              disabled={snapshot.phase !== "quote-ready"}
              onClick={() => flow.selectQuote(candidate.id)}
            >
              <span className="quote-provider">{candidate.funding.providerName}</span>
              <span className="quote-out">{bare(candidate.funding.minimumOutput)}</span>
              <span className="quote-meta">
                {hasSpread(candidate.funding)
                  ? `≈ ${bare(candidate.funding.expectedOutput)} expected`
                  : "fixed fee"}{" "}
                · ~{candidate.totalEtaSeconds}s
              </span>
              <span className="quote-exp">
                exp {new Date(candidate.expiresAt).toLocaleTimeString()}
              </span>
            </button>
          ))}
          {snapshot.batch.failures.length > 0 ? (
            <details className="declined">
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

      {/* ------------------------------------------------------- ledger */}
      {selected ? (
        <section className="panel p3">
          <div className="panel-head">
            <span>Costs</span>
            <span>two phases, not atomic</span>
          </div>
          <dl className="ledger">
            <div>
              <dt>Send on {route?.label}</dt>
              <dd>{amountOf(selected.funding.input)}</dd>
            </div>
            {selected.funding.fees.map((fee, index) => (
              <div key={index}>
                <dt>{fee.label}</dt>
                <dd>−{amountOf(fee.amount)}</dd>
              </div>
            ))}
            <div className="total">
              <dt>Guaranteed on Solana</dt>
              <dd>{amountOf(selected.funding.minimumOutput)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {/* ---------------------------------------------------- telemetry */}
      <section className="panel">
        <div className="panel-head">
          <span>Status</span>
          {snapshot.phase !== "idle" ? (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                flow.reset();
                setDonation(null);
                window.localStorage.removeItem(STORAGE_KEY);
              }}
            >
              Reset
            </button>
          ) : (
            <span>idle</span>
          )}
        </div>

        <div className="telemetry">
          <span className="phase">
            <i className={`led ${snapshot.phase === "completed" ? "live" : "gated"}`} />
            {snapshot.phase}
            {busy ? ` · ${busy}` : ""}
          </span>

          {snapshot.fundingReference ? (
            <p className="trace">
              source tx <b>{snapshot.fundingReference.txId}</b>
            </p>
          ) : null}
          {snapshot.fundingStatus ? <p className="trace">{snapshot.fundingStatus.detail}</p> : null}
          {snapshot.error ? (
            <p className="fail">
              <code>{snapshot.error.code}</code> {snapshot.error.message}
            </p>
          ) : null}

          {snapshot.phase === "completed" ? (
            <div className="landed">
              <h3>Transaction landed</h3>
              {selected ? (
                <p className="trace">
                  At least {amountOf(selected.funding.minimumOutput)} is now in{" "}
                  <b>{selected.intent.destination.account.address}</b>.
                </p>
              ) : null}

              {support && route?.namespace === "evm" && account ? (
                donation ? (
                  <p className="trace">
                    Thank you. Donation tx <b>{donation.hash}</b>
                  </p>
                ) : (
                  <div className="support">
                    <p>
                      This bridge is free and the SDK behind it is open source. Your support keeps it
                      that way.
                    </p>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        run("donating", async () => {
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
                      Donate {support.suggestedUsd} {route.token.symbol}
                    </button>
                    <small className="field-note">
                      Entirely optional and separate from your transfer, which is already complete. A
                      new transaction on {route.label} to <code>{support.address}</code>, costing gas.
                      Nothing happens unless you sign it.
                    </small>
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          <p className="trace">
            Flow state is written to localStorage on every transition. Reload mid-transfer and it
            resumes; unsigned steps are discarded and re-prepared, never restored.
          </p>
        </div>
      </section>
    </div>
  );
}
