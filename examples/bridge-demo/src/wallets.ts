import type { WalletStep } from "@hedgents/stablecoin-rail";

/**
 * Minimal wallet plumbing for the demo.
 *
 * The SDK never signs: it returns unsigned `WalletStep`s and the application
 * decides how to present and submit each one. This file is that decision, kept
 * deliberately small and dependency-free so the integration stays readable.
 */

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface TronLink {
  tronWeb?: {
    defaultAddress?: { base58?: string };
    trx: {
      sign(transaction: unknown): Promise<unknown>;
      sendRawTransaction(signed: unknown): Promise<{ txid?: string; transaction?: { txID?: string } }>;
    };
  };
  request?(args: { method: string }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
    tronLink?: TronLink;
    tronWeb?: TronLink["tronWeb"];
  }
}

export function hasEvmWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

export function hasTronWallet() {
  return typeof window !== "undefined" && Boolean(window.tronLink ?? window.tronWeb);
}

/**
 * Put the wallet on `numericChainId`, and prove it landed there.
 *
 * A wallet may reject the switch, or the user may dismiss it, so the result is
 * re-read rather than assumed. Broadcasting to a chain the quote never priced
 * would send calldata built for one chain's contracts to another's.
 */
async function requireChain(provider: Eip1193, numericChainId: number): Promise<void> {
  const target = `0x${numericChainId.toString(16)}`;
  const current = (await provider.request({ method: "eth_chainId" })) as string;
  if (current?.toLowerCase() === target) return;

  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: target }] });
  const confirmed = (await provider.request({ method: "eth_chainId" })) as string;
  if (confirmed?.toLowerCase() !== target) {
    throw new Error(
      `The wallet is on chain ${confirmed} but this transaction is for chain ${target}. Switch networks and retry.`,
    );
  }
}

export async function connectEvm(numericChainId: number): Promise<string> {
  const provider = window.ethereum;
  if (!provider) throw new Error("No EVM wallet found. Install MetaMask or a compatible wallet.");

  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error("The EVM wallet returned no account.");

  await requireChain(provider, numericChainId);
  return account;
}

export async function connectTron(): Promise<string> {
  const link = window.tronLink;
  if (link?.request) await link.request({ method: "tron_requestAccounts" });
  const tronWeb = link?.tronWeb ?? window.tronWeb;
  const address = tronWeb?.defaultAddress?.base58;
  if (!address) throw new Error("No TRON wallet found, or it is locked. Unlock TronLink and retry.");
  return address;
}

/** Submit one prepared step and return its transaction hash. */
export async function submitStep(step: WalletStep, account: string): Promise<string> {
  if (step.request.namespace === "evm") {
    const provider = window.ethereum;
    if (!provider) throw new Error("No EVM wallet found.");
    if (!/^0x[0-9a-fA-F]{40}$/.test(account)) {
      throw new Error("The connected account is not an EVM address. Reconnect on the source chain.");
    }
    // Re-assert the chain per step, from the step itself, rather than trusting
    // whatever the wallet was on when it was connected. The user may have
    // changed route or network in between.
    await requireChain(provider, step.request.numericChainId);
    const hash = (await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: account,
          to: step.request.to,
          data: step.request.data,
          // Every rail EVM step is zero-value; sending native currency here
          // would mean the plugin asked for something it should not have.
          value: `0x${BigInt(step.request.value).toString(16)}`,
        },
      ],
    })) as string;
    return hash;
  }

  if (step.request.namespace === "tron") {
    const tronWeb = window.tronLink?.tronWeb ?? window.tronWeb;
    if (!tronWeb) throw new Error("No TRON wallet found.");
    const signed = await tronWeb.trx.sign(step.request.transaction);
    const receipt = await tronWeb.trx.sendRawTransaction(signed);
    const txid = receipt?.txid ?? receipt?.transaction?.txID;
    if (!txid) throw new Error("TRON returned no transaction id.");
    return txid;
  }

  // Funding-only intents never produce a Solana step, so reaching here means
  // the configuration changed underneath us.
  throw new Error(`This demo cannot sign a ${step.request.namespace} step.`);
}
