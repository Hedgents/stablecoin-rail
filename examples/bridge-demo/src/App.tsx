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
import { connectEvm, connectTron, submitStep, waitForReceipt } from "./wallets.js";

const STORAGE_KEY = "rail-bridge-demo/flow";

// Only restore a session when money may still be moving. Quotes, errors, and
// finished receipts are useful in the current tab, but they should never turn
// the next visit into a wall of stale amounts and transaction details.
const RESUMABLE_ON_RETURN = new Set<PersistedRailFlow["snapshot"]["phase"]>([
  "funding-pending",
  "destination-ready",
  "preparing-action",
  "awaiting-destination-signature",
  "action-pending",
]);

/** Flow phases in language someone bridging for the first time can follow. */
const PHASE_TEXT: Record<string, string> = {
  idle: "Not started",
  quoting: "Looking for the best route…",
  "quote-ready": "Ready to send",
  "preparing-funding": "Preparing your transaction…",
  "awaiting-source-signature": "Waiting for you to approve in your wallet",
  "funding-pending": "On its way to Solana…",
  "destination-ready": "Funds settled on Solana",
  completed: "Complete",
  refunded: "Refunded to your wallet",
  failed: "Something went wrong",
};

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

interface Liquidity {
  band: "low" | "moderate" | "high" | "severe";
  reason: string;
  destinationSharePct: number;
  source: { chainKey: string; tokenBaseUnits: string; tokenSharePct: number; decimals: number };
  destination: { chainKey: string; tokenBaseUnits: string; tokenSharePct: number; decimals: number };
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
    if (!raw) return null;
    const persisted = JSON.parse(raw) as PersistedRailFlow;
    if (RESUMABLE_ON_RETURN.has(persisted.snapshot?.phase)) return persisted;
    window.localStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
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
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tip, setTip] = useState<{ hash: string } | null>(null);
  const [tipAmount, setTipAmount] = useState<string>(String(support?.suggestedUsd ?? 10));
  const [liquidity, setLiquidity] = useState<Liquidity | null>(null);
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

  /*
   * Pool depth only exists for the pool-based alternative to this route, so it
   * is fetched only there. CCTP and OFT routes have no pool, and showing a
   * liquidity score for them would invent a risk that does not exist.
   */
  const poolRouteSymbol = route?.id === "usdt0-tron" ? route.token.symbol : null;
  const poolAmountUnits =
    poolRouteSymbol && route ? toBaseUnits(amount, route.token.decimals) : null;
  useEffect(() => {
    if (!poolRouteSymbol || !poolAmountUnits) {
      setLiquidity(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      fetch(`/api/liquidity?symbol=${poolRouteSymbol}&amount=${poolAmountUnits}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => live && setLiquidity(body && !body.error ? body : null))
        .catch(() => live && setLiquidity(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [poolRouteSymbol, poolAmountUnits]);

  const destinationValid = isSolanaAddress(destination);
  const snapshot = flow.snapshot;
  const selected = flow.selectedQuote;
  const showDetails = snapshot.phase !== "idle" || selected !== null || liquidity !== null;

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
        /*
         * An approval must be MINED before the step that spends it is sent.
         * eth_sendTransaction resolves on broadcast, so firing both back to
         * back lets the transfer reach the chain first and revert with
         * "ERC20: transfer amount exceeds allowance".
         */
        if (step.kind === "approval" && step.request.namespace === "evm") {
          setBusy("waiting for the approval to confirm");
          await waitForReceipt(hash);
          setBusy("signing");
        }
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

  const outputAmount = selected ? bare(selected.funding.minimumOutput) : "";
  const rate =
    selected && Number(bare(selected.funding.input)) > 0
      ? (Number(outputAmount) / Number(bare(selected.funding.input))).toFixed(6)
      : null;

  return (
    <div className={`shell ${showDetails ? "" : "shell-clean"}`}>
      {/* Left: what this is, and the standing warning. */}
      <div className="col col-intro">
      <header className="masthead">
        <h1 className="wordmark">Move your stablecoins to Solana</h1>
        <p className="tagline">
          Send USDC or USDT from another chain and receive it in your Solana wallet. You keep
          control of your funds the whole way.
        </p>
      </header>

      <p className="notice">
        <b>Alpha software.</b> Independently unaudited.{" "}
        {signingEnabled
          ? "Transactions are real and irreversible."
          : "Quotes are live; transfers are disabled."}
      </p>

      </div>

      {/* Middle: the transfer itself. */}
      <div className="col col-form">
      <section className="card c1">
        <div className="card-head">
          <span>Send</span>
          <small>from another chain</small>
        </div>

        <div className="leg">
          <label className="leg-label" htmlFor="chain">
            Which chain are your stablecoins on?
          </label>
          <div className="picker">
            <select
              id="chain"
              value={routeId}
              onChange={(event) => {
                const next = routes.find((candidate) => candidate.id === event.target.value);
                // An account bound to one chain is not usable on another.
                if (next && next.chainId !== route?.chainId) setAccount(null);
                setRouteId(event.target.value);
              }}
            >
              {routes.map((candidate) => (
                <option key={candidate.id} value={candidate.id} disabled={candidate.status !== "live"}>
                  {candidate.label} · {candidate.token.symbol}
                  {candidate.status === "live" ? "" : "  (not available)"}
                </option>
              ))}
            </select>
          </div>

          {route && route.status !== "live" ? <p className="route-note">{route.note}</p> : null}
          {route?.native === false ? (
            <p className="route-note">
              Heads up: the USDC on {route.label} is issued by Binance rather than Circle, so this
              route swaps it for the Circle version on Solana.
            </p>
          ) : null}

          <div className="amount-row">
            <input
              className="amount-in"
              value={amount}
              inputMode="decimal"
              placeholder="Amount"
              aria-label="Amount to send"
              onChange={(event) => setAmount(event.target.value)}
            />
            <span className="ticker">{route?.token.symbol ?? ""}</span>
          </div>

          <div className="leg-foot">
            <span>From your {route?.label ?? ""} wallet</span>
            <button type="button" className="ghost" onClick={onConnect} disabled={!route || busy !== null}>
              {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "Connect wallet"}
            </button>
          </div>
        </div>

        <div className="seam">
          <span aria-hidden="true">↓</span>
        </div>

        <div className="leg">
          <label className="leg-label" htmlFor="destination">Receive on Solana</label>
          <input
            id="destination"
            className="addr"
            value={destination}
            spellCheck={false}
            placeholder="Paste your Solana wallet address"
            aria-label="Solana wallet address"
            aria-invalid={destination.length > 0 && !destinationValid}
            onChange={(event) => setDestination(event.target.value)}
          />
          <small className={`field-note ${destination.length === 0 ? "" : destinationValid ? "ok" : "bad"}`}>
            {destination.length === 0
              ? "Paste the receiving wallet. No Solana connection required."
              : destinationValid
                ? "That looks like a valid Solana address."
                : "That is not a valid Solana address. Money sent to a wrong address cannot be recovered."}
          </small>

          {selected ? (
            <div className="receive-preview">
              <span className="leg-label">You&rsquo;ll receive at least</span>
              <div className="amount-row">
                <span className="amount-out">{outputAmount}</span>
                <span className="ticker">{route?.settlement.symbol ?? ""} on Solana</span>
              </div>
            </div>
          ) : null}
        </div>

        {selected && hasSpread(selected.funding) ? (
          <p className="rate">
            You will most likely get about {amountOf(selected.funding.expectedOutput)}. The figure
            above is the least you are guaranteed.
          </p>
        ) : null}
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
            ? "Connect your wallet to continue"
            : selected && snapshot.phase === "quote-ready"
              ? signingEnabled
                ? "Confirm and send"
                : "Signing disabled on this deployment"
              : "See what you\u2019ll get"}
      </button>

      {error ? <p className="notice fail">{error}</p> : null}

      {/* ------------------------------------------------------- quotes */}
      {snapshot.batch && snapshot.batch.quotes.length > 0 ? (
        <section className="card c2">
          <div className="card-head">
            <span>Available routes</span>
            <small>best guaranteed amount first</small>
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

      </div>

      {/* Right: appears only after the visitor asks for a quote or starts a transfer. */}
      {showDetails ? (
      <div className="col col-detail">
      {liquidity ? (
        <section className={`card pool pool-${liquidity.band}`}>
          <div className="card-head">
            <span>Alternative route liquidity</span>
            <small className={`band band-${liquidity.band}`}>{liquidity.band} risk</small>
          </div>
          <div className="pool-body">
            <p className="pool-reason">{liquidity.reason}</p>
            <div className="pool-bars">
              {[liquidity.source, liquidity.destination].map((side, index) => (
                <div key={side.chainKey}>
                  <span>
                    {index === 0 ? "Sending into" : "Paying out from"} {side.chainKey}
                  </span>
                  <strong>
                    {Math.round(Number(side.tokenBaseUnits) / 10 ** side.decimals).toLocaleString()}{" "}
                    {route?.token.symbol}
                  </strong>
                  <i aria-hidden="true">
                    <b style={{ width: `${Math.min(100, side.tokenSharePct * 2)}%` }} />
                  </i>
                  <small>{side.tokenSharePct.toFixed(0)}% of pool is {route?.token.symbol} (50% is balanced)</small>
                </div>
              ))}
            </div>
            <p className="pool-note">
              This is a pooled route, so your money leaves a pot on the other side rather than being
              minted. The smaller that pot, the worse your rate.
            </p>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------- ledger */}
      {selected ? (
        <section className="card c3">
          <div className="card-head">
            <span>Breakdown</span>
            <small>all costs included</small>
          </div>
          <dl className="ledger">
            <div>
              <dt>You send from {route?.label}</dt>
              <dd>{amountOf(selected.funding.input)}</dd>
            </div>
            {selected.funding.fees.map((fee, index) => (
              <div key={index}>
                <dt>{fee.label}</dt>
                <dd>−{amountOf(fee.amount)}</dd>
              </div>
            ))}
            <div className="total">
              <dt>You receive at least</dt>
              <dd>{amountOf(selected.funding.minimumOutput)}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      {/* ---------------------------------------------------- telemetry */}
      {snapshot.phase !== "idle" ? (
      <section className="card">
        <div className="card-head">
          <span>Progress</span>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              flow.reset();
              setTip(null);
              window.localStorage.removeItem(STORAGE_KEY);
            }}
          >
            Reset
          </button>
        </div>

        <div className="telemetry">
          <span className="phase">
            <i className={`dot ${snapshot.phase === "completed" ? "go" : busy ? "work" : ""}`} />
            {PHASE_TEXT[snapshot.phase] ?? snapshot.phase}
          </span>

          {snapshot.fundingReference ? (
            <p className="trace">
              Sent from {route?.label ?? "source"}: <b>{snapshot.fundingReference.txId}</b>
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
              <h3>Done. Your money has arrived.</h3>
              {selected ? (
                <p className="trace">
                  At least {amountOf(selected.funding.minimumOutput)} is now in{" "}
                  <b>{selected.intent.destination.account.address}</b>.
                </p>
              ) : null}

              {support && account && route ? (
                tip ? (
                  <p className="trace">
                    Thank you. Tip sent — source tx <b>{tip.hash}</b>
                  </p>
                ) : (
                  <div className="support">
                    <p>
                      This bridge charges no fee and the SDK behind it is open source. If it helped,
                      consider tipping the project to keep it that way.
                    </p>
                    <div className="support-row">
                      <div className="amount-row">
                        <input
                          className="amount-in"
                          value={tipAmount}
                          inputMode="numeric"
                          pattern="\d*"
                          placeholder={String(support.suggestedUsd)}
                          aria-label="Tip amount"
                          onChange={(event) =>
                            // Integer only: strip anything that is not a digit.
                            setTipAmount(event.target.value.replace(/[^\d]/g, ""))
                          }
                        />
                        <span className="ticker">{route.token.symbol}</span>
                      </div>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== null}
                        onClick={() =>
                          run("tipping", async () => {
                            const whole = tipAmount.trim() === "" ? support.suggestedUsd : Number(tipAmount);
                            if (!Number.isInteger(whole) || whole <= 0) {
                              throw new Error("Enter a whole number greater than zero.");
                            }
                            const units = toBaseUnits(String(whole), route.token.decimals);
                            if (!units) throw new Error("Enter a whole number greater than zero.");
                            /*
                             * The tip is a second rail transfer: same source chain and asset the
                             * user just used, but the destination is the project's Solana address.
                             * A fresh flow keeps it isolated from the main transfer's resume state,
                             * so a mid-tip reload can never strand the completed transfer.
                             */
                            const tipIntent: FundingIntent = {
                              id: `tip-${Date.now()}`,
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
                                account: { chainId: "solana:mainnet", address: support.address },
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
                            const tipFlow = client.createFlow();
                            await tipFlow.quote(tipIntent);
                            const prepared = await tipFlow.prepareFunding();
                            let sourceHash: string | null = null;
                            for (const step of prepared.fundingSteps as WalletStep[]) {
                              const hash = await submitStep(step, account);
                              if (step.kind === "approval" && step.request.namespace === "evm") {
                                await waitForReceipt(hash);
                              }
                              if (step.kind === "funding") sourceHash = hash;
                            }
                            if (!sourceHash) throw new Error("No tip transaction was produced.");
                            tipFlow.markFundingSubmitted({
                              chainId: prepared.fundingSteps[0]!.chainId,
                              txId: sourceHash,
                              submittedAt: new Date().toISOString(),
                            });
                            setTip({ hash: sourceHash });
                          })
                        }
                      >
                        Tip
                      </button>
                    </div>
                    <small className="field-note">
                      Optional and separate from your transfer, which is already complete. It repeats
                      the same {route.label} → Solana route to{" "}
                      <code>{support.address.slice(0, 6)}…{support.address.slice(-4)}</code>, so the
                      project receives slightly less than the tipped amount after route fees. You sign
                      one more transaction; nothing happens by inaction.
                    </small>
                  </div>
                )
              ) : null}
            </div>
          ) : null}

          <p className="trace">
            You can safely close this page. If you come back mid-transfer, it picks up where it left
            off.
          </p>
        </div>
      </section>
      ) : null}
      </div>
      ) : null}
    </div>
  );
}
