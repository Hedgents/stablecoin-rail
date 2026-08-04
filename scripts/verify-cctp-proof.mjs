import {
  ETHEREUM_MAINNET,
  SOLANA_MAINNET,
  createCctpToSolana,
} from "../packages/cctp/dist/index.js";
import { toBytes32 } from "../packages/solana/dist/index.js";

const SOURCE_TX = "0x509ce416c0fd1908053e39221e1c1e157a4e52324514882296fbf194df5152f1";
const DESTINATION_TX =
  "KwTk3nn76FWS1CtmtEHbVJsURJNLvBAdJ7jhGqqj2Mr8qHCHasVYrdeC3e4gnx1QELX1pJkUxUxK8s8JDpX3rqw";
const DESTINATION_WALLET = "FtXSmydZCxEu78tr2sTcbSNByGPENZu7wNJNMhz1vP7B";
const DESTINATION_TOKEN_ACCOUNT = "Dy7CzTn1icbenqTGt9y3F7zrwDZhJeQ3P1si9Kb2Fto7";
const SOURCE_AMOUNT = "5000000";
const GUARANTEED_AMOUNT = "4875317";

const ethereumUsdc = {
  chainId: ETHEREUM_MAINNET.chainId,
  assetId: `${ETHEREUM_MAINNET.chainId}/erc20:${ETHEREUM_MAINNET.usdcAddress.toLowerCase()}`,
  symbol: "USDC",
  decimals: 6,
};
const solanaUsdc = {
  chainId: SOLANA_MAINNET.chainId,
  assetId: `${SOLANA_MAINNET.chainId}/spl:${SOLANA_MAINNET.usdcMint}`,
  symbol: "USDC",
  decimals: 6,
};

const intent = {
  id: "cctp-mainnet-proof-2026-08-04",
  source: {
    account: {
      chainId: ETHEREUM_MAINNET.chainId,
      address: "0xb7ecf980a4732b75e57e2ec80903dee3964f2573",
    },
    asset: ethereumUsdc,
  },
  destination: {
    account: { chainId: SOLANA_MAINNET.chainId, address: DESTINATION_WALLET },
    settlementAsset: solanaUsdc,
  },
  inputAmountBaseUnits: SOURCE_AMOUNT,
  slippageBps: 0,
};

const plugin = createCctpToSolana({
  sources: [ETHEREUM_MAINNET],
  solana: SOLANA_MAINNET,
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
});

const quote = {
  id: "cctp-mainnet-proof-quote",
  providerId: plugin.manifest.id,
  providerName: plugin.manifest.name,
  input: { asset: ethereumUsdc, amountBaseUnits: SOURCE_AMOUNT },
  expectedOutput: { asset: solanaUsdc, amountBaseUnits: GUARANTEED_AMOUNT },
  minimumOutput: { asset: solanaUsdc, amountBaseUnits: GUARANTEED_AMOUNT },
  fees: [],
  etaSeconds: 30,
  expiresAt: "2026-08-04T13:00:00.000Z",
  executionMode: "two-phase",
  opaqueData: {
    schema: "hedgents.cctp.v2.evm-solana.v1",
    sourceDomain: ETHEREUM_MAINNET.cctpDomain,
    destinationDomain: SOLANA_MAINNET.cctpDomain,
    tokenMessengerV2: ETHEREUM_MAINNET.tokenMessengerV2,
    burnToken: ETHEREUM_MAINNET.usdcAddress,
    sourceAmount: SOURCE_AMOUNT,
    destinationWallet: DESTINATION_WALLET,
    destinationTokenAccount: DESTINATION_TOKEN_ACCOUNT,
    mintRecipient: toBytes32(DESTINATION_TOKEN_ACCOUNT),
    minimumOutput: GUARANTEED_AMOUNT,
  },
};

const status = await plugin.getStatus(
  {
    intent,
    quote,
    reference: {
      chainId: ETHEREUM_MAINNET.chainId,
      txId: SOURCE_TX,
      submittedAt: "2026-08-04T12:00:00.000Z",
    },
  },
  { now: () => Date.now() },
);

if (
  status.state !== "completed" ||
  status.destinationReference?.txId !== DESTINATION_TX ||
  status.received?.amountBaseUnits !== GUARANTEED_AMOUNT
) {
  throw new Error(`Mainnet proof did not verify: ${JSON.stringify(status)}`);
}

console.log(
  JSON.stringify(
    {
      verified: true,
      sourceTransaction: SOURCE_TX,
      destinationTransaction: status.destinationReference.txId,
      receivedBaseUnits: status.received.amountBaseUnits,
      checkedAt: status.checkedAt,
    },
    null,
    2,
  ),
);
