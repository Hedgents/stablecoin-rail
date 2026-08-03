import { decodeBase58 } from "@hedgents/stablecoin-rail-solana";

const MAGIC = "cctp-forward";
const MAGIC_BYTES = 24;
const VERSION = 0;
/** One flag byte plus a thirty-two byte wallet. */
const PAYLOAD_LENGTH = 33;

/**
 * Hook payload instructing Circle's Forwarding Service to deliver the minted
 * USDC to a Solana wallet, optionally creating its associated token account
 * first.
 *
 * Layout, 65 bytes total:
 *
 *   [0,24)  "cctp-forward", zero-padded
 *   [24,28) version, uint32 big-endian
 *   [28,32) payload length, uint32 big-endian
 *   [32]    create-ATA flag
 *   [33,65) recipient wallet
 *
 * The trailing thirty-two bytes are the user's WALLET, not their token
 * account. The service derives the account itself, and passing a token account
 * here would misdeliver.
 */
export function buildSolanaForwardHook(
  recipientWallet: string,
  createTokenAccount: boolean,
): `0x${string}` {
  const wallet = decodeBase58(recipientWallet);
  if (wallet.length !== 32) {
    throw new Error("The forwarding recipient must be a base58 Solana wallet address.");
  }
  const out = new Uint8Array(MAGIC_BYTES + 4 + 4 + 1 + 32);
  out.set(new TextEncoder().encode(MAGIC), 0);
  const view = new DataView(out.buffer);
  view.setUint32(MAGIC_BYTES, VERSION, false);
  view.setUint32(MAGIC_BYTES + 4, PAYLOAD_LENGTH, false);
  out[MAGIC_BYTES + 8] = createTokenAccount ? 1 : 0;
  out.set(wallet, MAGIC_BYTES + 9);
  return `0x${Array.from(out, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
