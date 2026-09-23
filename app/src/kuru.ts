// Funds a Flopline account by swapping native MON for USDC on Kuru's testnet order book,
// then depositing that USDC as Flopline collateral. Reuses Kuru's own MON/USDC market so users
// need only MON to get started, instead of a separate USDC faucet.
//
// Source: Kuru's published testnet deployment (chain 10143) and the @toxicflow-labs/ts-sdk types,
// read directly from node_modules since the docs site's prose summaries didn't match the real API.
// UNVERIFIED end-to-end: this chain only exists on Monad testnet, which this project has not
// deployed to yet. Typechecked against the real SDK, not run live.
import { createAccountClient, createSpotClient } from "@toxicflow-labs/ts-sdk";
import { zeroAddress, type Address } from "viem";
import { CHAIN_ID, chain, exchange, getAccount, publicClient, usdc, walletClient } from "./chain";

export const KURU_TESTNET_CHAIN_ID = 10143;
export const kuruAvailable = () => CHAIN_ID === KURU_TESTNET_CHAIN_ID;

const KURU = {
  accountCore: "0x6384e9b2Bf3b65e1535403a0A543b5FDA905eE22" as Address,
  spotRouter: "0xba24a1042701f06e8F7edCF04389260D1Fa4c697" as Address,
  monUsdcMarket: "0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61" as Address,
  usdc: "0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E" as Address,
};

export type FundStep =
  | "depositing-mon"
  | "swapping"
  | "withdrawing-usdc"
  | "approving"
  | "depositing-flopline"
  | "done";

async function confirm(hash: `0x${string}`) {
  return publicClient.waitForTransactionReceipt({ hash });
}

/// Deposits `monAmount` wei of native MON into Kuru, swaps it for USDC on the MON/USDC market,
/// withdraws the USDC, then deposits it into Flopline's ComputeExchange as trading collateral.
export async function fundViaKuruSwap(monAmount: bigint, onStep?: (s: FundStep) => void): Promise<{ usdcReceived: bigint }> {
  if (!kuruAvailable()) throw new Error(`Kuru testnet not available on chain ${CHAIN_ID}`);

  const account = getAccount();
  const wallet = walletClient();
  const cfg = { publicClient, walletClient: wallet, account, addresses: { accountCore: KURU.accountCore, spotRouter: KURU.spotRouter } };
  const accountClient = createAccountClient(cfg);
  const spotClient = createSpotClient(cfg);

  onStep?.("depositing-mon");
  await confirm(await accountClient.deposit({ token: zeroAddress, amount: monAmount }));

  const userId = await accountClient.getAccountId({ user: account.address });

  const est = await spotClient.estimateSwap({ market: KURU.monUsdcMarket, userId, isBuy: false, amountIn: monAmount });
  const amountOut = (est as { amountOut: bigint }).amountOut;
  if (!amountOut || amountOut === 0n) throw new Error("Kuru quoted zero USDC out for this MON amount");

  onStep?.("swapping");
  const minAmountOut = (amountOut * 990n) / 1000n; // 1% slippage tolerance
  await confirm(
    await spotClient.swap({
      market: KURU.monUsdcMarket,
      userId,
      isBuy: false,
      amountIn: monAmount,
      minAmountOut,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
    }),
  );

  onStep?.("withdrawing-usdc");
  const usdcBalance = await accountClient.getBalance({ user: account.address, token: KURU.usdc });
  await confirm(await accountClient.withdraw({ token: KURU.usdc, amount: usdcBalance }));

  onStep?.("approving");
  await confirm(await wallet.writeContract({ ...usdc, functionName: "approve", args: [exchange.address, usdcBalance] }));

  onStep?.("depositing-flopline");
  await confirm(await wallet.writeContract({ ...exchange, functionName: "deposit", args: [usdcBalance] }));

  onStep?.("done");
  return { usdcReceived: usdcBalance };
}

export const kuruChainName = () => chain.name;
