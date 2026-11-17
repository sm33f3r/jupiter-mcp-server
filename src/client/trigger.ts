import { loadSolanaKeypair } from "./solana.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export const TRIGGER_API_BASE = "https://api.jup.ag/trigger/v2";

// Module-level cache for JWT and vault info
let cachedJwt: string | null = null;
let jwtAcquiredAt: number | null = null;
const JWT_CACHE_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

let cachedVaultInfo: {
  userPubkey: string;
  vaultPubkey: string;
  privyVaultId: string;
} | null = null;

async function triggerFetch(
  path: string,
  options?: {
    method?: "GET" | "POST";
    body?: unknown;
    jwt?: string;
  }
): Promise<unknown> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY environment variable is not set");
  }

  const url = new URL(TRIGGER_API_BASE + path);
  const headers: Record<string, string> = { "x-api-key": apiKey };

  if (options?.jwt) {
    headers["Authorization"] = `Bearer ${options.jwt}`;
  }

  const init: RequestInit = {
    method: options?.method || "GET",
    headers,
  };

  if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url.toString(), init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Trigger API error: ${response.status} ${response.statusText} — ${body}`
    );
  }

  return response.json() as Promise<unknown>;
}

interface ChallengeResponse {
  type: "message";
  challenge: string;
}

interface VerifyResponse {
  token: string;
}

interface VaultResponse {
  userPubkey: string;
  vaultPubkey: string;
  privyVaultId: string;
}

interface CraftDepositResponse {
  transaction: string;
  requestId: string;
  receiverAddress: string;
  mint: string;
  amount: string;
  tokenDecimals: number;
  inputTokenAccount: string;
  outputTokenAccount?: string;
}

interface CreateOrderResponse {
  id: string;
  txSignature: string;
}

interface CancelTriggerOrderResponse {
  id: string;
  transaction: string;
  requestId: string;
}

interface ConfirmCancelTriggerOrderResponse {
  id: string;
  txSignature: string;
}

interface CreateOcoOrderResponse {
  id: string;
  txSignature: string;
}

export async function getTriggerJwt(): Promise<string> {
  // Return cached JWT if still valid
  if (cachedJwt && jwtAcquiredAt) {
    const ageMs = Date.now() - jwtAcquiredAt;
    if (ageMs < JWT_CACHE_TTL_MS) {
      return cachedJwt;
    }
  }

  // Clear expired cache
  cachedJwt = null;
  jwtAcquiredAt = null;

  // Load keypair for signing
  const keypair = loadSolanaKeypair();
  const walletPubkey = keypair.publicKey.toBase58();

  // Step 1: Request challenge
  const challengeRes = (await triggerFetch("/auth/challenge", {
    method: "POST",
    body: { walletPubkey, type: "message" },
  })) as ChallengeResponse;

  if (challengeRes.type !== "message") {
    throw new Error(`Unexpected challenge type: ${challengeRes.type}`);
  }

  // Step 2: Sign challenge with ed25519
  const challengeBytes = new TextEncoder().encode(challengeRes.challenge);
  const signatureBytes = nacl.sign.detached(
    challengeBytes,
    keypair.secretKey
  );
  const signature = bs58.encode(signatureBytes);

  // Step 3: Verify to get JWT
  const verifyRes = (await triggerFetch("/auth/verify", {
    method: "POST",
    body: { type: "message", walletPubkey, signature },
  })) as VerifyResponse;

  // Cache the token
  cachedJwt = verifyRes.token;
  jwtAcquiredAt = Date.now();

  return cachedJwt;
}

export async function getOrRegisterVault(
  jwt: string
): Promise<{ userPubkey: string; vaultPubkey: string; privyVaultId: string }> {
  try {
    // Try GET /vault first
    const vaultRes = (await triggerFetch("/vault", {
      jwt,
    })) as VaultResponse;

    return vaultRes;
  } catch (error) {
    // If GET /vault fails (any non-2xx), fall back to GET /vault/register
    const registerRes = (await triggerFetch("/vault/register", {
      jwt,
    })) as VaultResponse;

    return registerRes;
  }
}

export async function getVaultCached(
  jwt: string
): Promise<{ userPubkey: string; vaultPubkey: string; privyVaultId: string }> {
  if (cachedVaultInfo) {
    return cachedVaultInfo;
  }

  const vaultInfo = await getOrRegisterVault(jwt);
  cachedVaultInfo = vaultInfo;
  return vaultInfo;
}

export async function craftDeposit(params: {
  jwt: string;
  inputMint: string;
  outputMint: string;
  userAddress: string;
  amount: string;
  orderSubType: "single" | "oco" | "otoco";
}): Promise<{
  transaction: string;
  requestId: string;
  receiverAddress: string;
  mint: string;
  amount: string;
  tokenDecimals: number;
  inputTokenAccount: string;
  outputTokenAccount?: string;
}> {
  const response = (await triggerFetch("/deposit/craft", {
    method: "POST",
    jwt: params.jwt,
    body: {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      userAddress: params.userAddress,
      amount: params.amount,
      orderType: "price",
      orderSubType: params.orderSubType,
    },
  })) as CraftDepositResponse;

  return response;
}

export async function createTriggerOrder(params: {
  jwt: string;
  depositRequestId: string;
  depositSignedTx: string;
  userPubkey: string;
  inputMint: string;
  inputAmount: string;
  outputMint: string;
  triggerMint: string;
  triggerCondition: "above" | "below";
  triggerPriceUsd: number;
  slippageBps?: number;
  expiresAt: number;
}): Promise<{ id: string; txSignature: string }> {
  // Client-side validation
  if (params.inputMint === params.outputMint) {
    throw new Error("inputMint cannot equal outputMint");
  }

  if (params.slippageBps !== undefined) {
    if (params.slippageBps < 0 || params.slippageBps > 10000) {
      throw new Error("slippageBps must be between 0 and 10000");
    }
  }

  const now = Date.now();
  if (params.expiresAt <= now) {
    throw new Error("expiresAt must be a future timestamp");
  }

  const response = (await triggerFetch("/orders/price", {
    method: "POST",
    jwt: params.jwt,
    body: {
      orderType: "single",
      depositRequestId: params.depositRequestId,
      depositSignedTx: params.depositSignedTx,
      userPubkey: params.userPubkey,
      inputMint: params.inputMint,
      inputAmount: params.inputAmount,
      outputMint: params.outputMint,
      triggerMint: params.triggerMint,
      triggerCondition: params.triggerCondition,
      triggerPriceUsd: params.triggerPriceUsd,
      slippageBps: params.slippageBps,
      expiresAt: params.expiresAt,
    },
  })) as CreateOrderResponse;

  return response;
}

/**
 * Initiate cancellation of a trigger order.
 * @param params.jwt - Valid JWT token obtained from getTriggerJwt()
 * @param params.orderId - The order identifier to cancel
 * @returns CancelTriggerOrderResponse with unsigned withdrawal transaction
 * @throws Error with HTTP status + response body on non-2xx
 * @note A 400 error means the order is not yet ready_to_cancel; caller should
 *       retry after a short delay, not treat it as a permanent failure.
 */
export async function cancelTriggerOrder(params: {
  jwt: string;
  orderId: string;
}): Promise<CancelTriggerOrderResponse> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY environment variable is not set");
  }

  const url = new URL(`${TRIGGER_API_BASE}/orders/price/cancel/${params.orderId}`);
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "Authorization": `Bearer ${params.jwt}`,
  };

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Cancel trigger order error: ${response.status} ${response.statusText} — ${body}`
    );
  }

  return response.json() as Promise<CancelTriggerOrderResponse>;
}

/**
 * Confirm cancellation by submitting signed withdrawal transaction.
 * @param params.jwt - Valid JWT token obtained from getTriggerJwt()
 * @param params.orderId - The order identifier being cancelled
 * @param params.signedTransaction - Wallet-signed withdrawal transaction (base64)
 * @param params.cancelRequestId - UUID from cancelTriggerOrder() response
 * @returns ConfirmCancelTriggerOrderResponse with on-chain signature
 * @throws Error with HTTP status + response body on non-2xx
 */
export async function confirmCancelTriggerOrder(params: {
  jwt: string;
  orderId: string;
  signedTransaction: string;
  cancelRequestId: string;
}): Promise<ConfirmCancelTriggerOrderResponse> {
  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY environment variable is not set");
  }

  const url = new URL(`${TRIGGER_API_BASE}/orders/price/confirm-cancel/${params.orderId}`);
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "Authorization": `Bearer ${params.jwt}`,
    "Content-Type": "application/json",
  };

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      signedTransaction: params.signedTransaction,
      cancelRequestId: params.cancelRequestId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Confirm cancel trigger order error: ${response.status} ${response.statusText} — ${body}`
    );
  }

  return response.json() as Promise<ConfirmCancelTriggerOrderResponse>;
}

export async function createOcoTriggerOrder(params: {
  jwt: string;
  depositRequestId: string;
  depositSignedTx: string;
  userPubkey: string;
  inputMint: string;
  inputAmount: string;
  outputMint: string;
  triggerMint: string;
  tpPriceUsd: number;
  slPriceUsd: number;
  tpSlippageBps?: number;
  slSlippageBps?: number;
  expiresAt: number;
}): Promise<CreateOcoOrderResponse> {
  // Client-side validation
  if (params.tpPriceUsd <= params.slPriceUsd) {
    throw new Error("tpPriceUsd must be strictly greater than slPriceUsd");
  }

  if (params.inputMint === params.outputMint) {
    throw new Error("inputMint cannot equal outputMint");
  }

  if (params.tpSlippageBps !== undefined) {
    if (params.tpSlippageBps < 0 || params.tpSlippageBps > 10000) {
      throw new Error("tpSlippageBps must be between 0 and 10000");
    }
  }

  if (params.slSlippageBps !== undefined) {
    if (params.slSlippageBps < 0 || params.slSlippageBps > 10000) {
      throw new Error("slSlippageBps must be between 0 and 10000");
    }
  }

  const now = Date.now();
  if (params.expiresAt <= now) {
    throw new Error("expiresAt must be a future timestamp");
  }

  const apiKey = process.env.JUPITER_API_KEY;
  if (!apiKey) {
    throw new Error("JUPITER_API_KEY environment variable is not set");
  }

  const url = new URL(`${TRIGGER_API_BASE}/orders/price`);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "Authorization": `Bearer ${params.jwt}`,
  };

  const body = {
    orderType: "oco",
    depositRequestId: params.depositRequestId,
    depositSignedTx: params.depositSignedTx,
    userPubkey: params.userPubkey,
    inputMint: params.inputMint,
    inputAmount: params.inputAmount,
    outputMint: params.outputMint,
    triggerMint: params.triggerMint,
    tpPriceUsd: params.tpPriceUsd,
    slPriceUsd: params.slPriceUsd,
    tpSlippageBps: params.tpSlippageBps,
    slSlippageBps: params.slSlippageBps,
    expiresAt: params.expiresAt,
  };

  // Remove undefined fields
  const cleanBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined) {
      cleanBody[key] = value;
    }
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(cleanBody),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(
      `Create OCO trigger order error: ${response.status} ${response.statusText} — ${bodyText}`
    );
  }

  return response.json() as Promise<CreateOcoOrderResponse>;
}