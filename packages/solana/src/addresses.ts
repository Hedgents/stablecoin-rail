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

/**
 * A program-derived address must NOT be a valid ed25519 point, so that no
 * private key can ever sign for it. Skipping this check would silently return a
 * wrong address whenever the first candidate happens to land on the curve.
 */
function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
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
    const candidate = sha256(concat([...seeds, Uint8Array.from([bump]), programId, PDA_MARKER]));
    if (!isOnCurve(candidate)) return encodeBase58(candidate);
  }
  throw new Error("No off-curve program address could be derived.");
}

/**
 * Derive the canonical associated token account for an owner and mint.
 *
 * Pass `TOKEN_2022_PROGRAM_ID` for Token-2022 mints; the token program is part
 * of the seeds, so the two programs yield different addresses for the same
 * owner and mint.
 */
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
