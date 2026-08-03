import { keccak_256 } from "@noble/hashes/sha3";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * ERC-20 approve calldata. Deliberately duplicated rather than shared with the
 * CCTP package so neither adapter can break the other; both are pinned by
 * byte-exact tests.
 */
export function encodeApprove(spender: string, amount: bigint): `0x${string}` {
  if (!ADDRESS.test(spender)) throw new Error("spender must be a 20-byte hex address.");
  if (amount < 0n || amount >= 2n ** 256n) throw new Error("amount does not fit in a uint256.");
  const selector = Array.from(
    keccak_256(new TextEncoder().encode("approve(address,uint256)")).slice(0, 4),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return `0x${selector}${spender.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
}
