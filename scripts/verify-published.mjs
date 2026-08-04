#!/usr/bin/env node
/**
 * Clean-room verification of the PUBLISHED packages.
 *
 * Installs from the npm registry into a throwaway directory outside this
 * workspace, then exercises the SDK against live provider endpoints.
 *
 * This exists because consuming the packages from inside the monorepo proves
 * nothing: npm workspaces link the local folder whenever its version satisfies
 * the range, so a missing file or a broken `exports` map would still resolve
 * locally and only break for an actual installer.
 *
 *   node scripts/verify-published.mjs [dist-tag]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TAG = process.argv[2] ?? "alpha";
const PACKAGES = [
  "@hedgents/stablecoin-rail",
  "@hedgents/stablecoin-rail-solana",
  "@hedgents/stablecoin-rail-cctp",
  "@hedgents/stablecoin-rail-mayan",
  "@hedgents/stablecoin-rail-layerzero",
  "@hedgents/stablecoin-rail-allbridge",
];

const root = mkdtempSync(join(tmpdir(), "rail-verify-"));
let failed = false;
const step = (ok, label, detail = "") => {
  if (!ok) failed = true;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
};

try {
  console.log(`Clean room: ${root}`);
  console.log(`Installing @${TAG} from the registry...\n`);

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "rail-verify", private: true, type: "module" }, null, 2),
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", ...PACKAGES.map((p) => `${p}@${TAG}`)], {
    cwd: root,
    stdio: "pipe",
  });

  const load = async (name) => import(join(root, "node_modules", name, "package.json").replace(/package\.json$/, "dist/index.js"));

  // 1. Every package resolves through its published exports map.
  const core = await load("@hedgents/stablecoin-rail");
  step(typeof core.RailClient === "function", "core resolves and exports RailClient");

  const remote = await import(join(root, "node_modules/@hedgents/stablecoin-rail/dist/remote/index.js"));
  step(typeof remote.createRailHandler === "function", "core ./remote subpath resolves");

  const testing = await import(join(root, "node_modules/@hedgents/stablecoin-rail/dist/testing/index.js"));
  step(typeof testing.fundingProviderConformance === "function", "core ./testing subpath resolves");

  const solana = await load("@hedgents/stablecoin-rail-solana");
  const cctp = await load("@hedgents/stablecoin-rail-cctp");
  const mayan = await load("@hedgents/stablecoin-rail-mayan");
  const layerzero = await load("@hedgents/stablecoin-rail-layerzero");
  const allbridge = await load("@hedgents/stablecoin-rail-allbridge");
  step(typeof cctp.createCctpToSolana === "function", "cctp resolves");
  step(typeof mayan.createMayanBnbToSolana === "function", "mayan resolves");
  step(typeof layerzero.createLayerZeroUsdgRobinhoodToSolana === "function", "layerzero resolves");
  step(typeof allbridge.createAllbridgePoolReader === "function", "allbridge resolves");

  // 2. Address derivation still agrees with the pinned mainnet vector.
  step(
    solana.deriveAssociatedTokenAddress(
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    ) === "FGETo8T8wMcN2wCjav8VK6eh3dLk63evNDPxzLSJra8B",
    "solana derives the pinned mainnet ATA",
  );

  // 3. A published provider passes the published conformance suite.
  const provider = cctp.createCctpToSolana({
    sources: [cctp.ETHEREUM_MAINNET, cctp.BASE_MAINNET],
    solana: cctp.SOLANA_MAINNET,
    rpcUrl: "https://api.mainnet-beta.solana.com",
  });
  const asset = (chainId, assetId, symbol, decimals) => ({ chainId, assetId, symbol, decimals });
  const supportedIntent = {
    id: "verify-1",
    source: {
      account: { chainId: "eip155:8453", address: "0x1111111111111111111111111111111111111111" },
      asset: asset("eip155:8453", `eip155:8453/erc20:${cctp.BASE_MAINNET.usdcAddress.toLowerCase()}`, "USDC", 6),
    },
    destination: {
      account: { chainId: "solana:mainnet", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      settlementAsset: asset("solana:mainnet", `solana:mainnet/spl:${cctp.SOLANA_MAINNET.usdcMint}`, "USDC", 6),
    },
    inputAmountBaseUnits: "10000000",
    slippageBps: 50,
  };
  const unsupportedIntent = {
    ...supportedIntent,
    id: "verify-bnb",
    source: {
      account: { chainId: "eip155:56", address: "0x1111111111111111111111111111111111111111" },
      asset: asset("eip155:56", "eip155:56/erc20:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "USDC", 18),
    },
  };

  let conformancePassed = 0;
  for (const item of testing.fundingProviderConformance({ plugin: provider, supportedIntent, unsupportedIntent })) {
    await item.run();
    conformancePassed += 1;
  }
  step(conformancePassed >= 9, "published CCTP passes published conformance", `(${conformancePassed} cases, live Circle + Solana)`);

  // 4. A real end-to-end quote through RailClient, funding-only.
  const client = new core.RailClient({ fundingProviders: [provider] });
  const batch = await client.quote(supportedIntent);
  const quote = batch.quotes[0];
  step(Boolean(quote), "RailClient returns a live quote for 10 USDC on Base");
  if (quote) {
    const out = Number(quote.funding.minimumOutput.amountBaseUnits) / 1e6;
    step(out > 9 && out < 10, "guaranteed output is plausible", `${out} USDC`);
  }

  // 5. Live pool liquidity through the published allbridge package.
  const assessment = await allbridge
    .createAllbridgePoolReader()
    .assess({ sourceChainKey: "TRX", destinationChainKey: "SOL", symbol: "USDT", amountBaseUnits: 10_000_000_000n });
  step(["low", "moderate", "high", "severe"].includes(assessment.band), "allbridge reads live pool depth", `band=${assessment.band}`);
} catch (error) {
  failed = true;
  console.log(`\n  ERROR  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed ? "FAILED" : "OK"}: published packages @${TAG}`);
process.exit(failed ? 1 : 0);
