import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Idl, setProvider } from "@coral-xyz/anchor";
import BN from "bn.js";
import { getRpcUrl } from "./solana.js";
import { jupiterPerpetualsIdl } from "./jupiter-perpetuals-idl.js";

export const JUPITER_PERPETUALS_PROGRAM_ID = new PublicKey(
  "PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu"
);
export const JLP_POOL_ACCOUNT_PUBKEY = new PublicKey(
  "5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq"
);
export const EVENT_AUTHORITY = new PublicKey(
  "37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN"
);
export const CUSTODY_ADDRESSES: Record<string, PublicKey> = {
  SOL:  new PublicKey("7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz"),
  ETH:  new PublicKey("AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn"),
  BTC:  new PublicKey("5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm"),
  USDC: new PublicKey("G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa"),
  USDT: new PublicKey("4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk"),
};

export function getCustodyAccounts(
  asset: "SOL" | "ETH" | "BTC",
  side: "long" | "short"
): { custody: PublicKey; collateralCustody: PublicKey } {
  const custody = CUSTODY_ADDRESSES[asset];
  const collateralCustody = side === "long"
    ? CUSTODY_ADDRESSES[asset]
    : CUSTODY_ADDRESSES["USDC"];
  return { custody, collateralCustody };
}

let _program: Program | null = null;

export function getPerpsProgram(): Program {
  if (_program) return _program;
  const connection = new Connection(getRpcUrl(), "confirmed");
  const provider = new AnchorProvider(connection, {} as Wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  setProvider(provider);
  _program = new Program(jupiterPerpetualsIdl as Idl, JUPITER_PERPETUALS_PROGRAM_ID, provider);
  return _program;
}

export function derivePositionPda(
  walletPublicKey: PublicKey,
  custodyPubkey: PublicKey,
  collateralCustodyPubkey: PublicKey,
  side: "long" | "short"
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      walletPublicKey.toBuffer(),
      JLP_POOL_ACCOUNT_PUBKEY.toBuffer(),
      custodyPubkey.toBuffer(),
      collateralCustodyPubkey.toBuffer(),
      // @ts-ignore — raw Buffer element; known TS limitation, compiles and works correctly
      Buffer.from([side === "long" ? 1 : 2]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );
  return pda;
}

export function derivePositionRequestPda(
  positionPda: PublicKey,
  counter: BN,
  requestChange: "increase" | "decrease"
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position_request"),
      positionPda.toBuffer(),
      counter.toArrayLike(Buffer, "le", 8),
      // @ts-ignore — raw Buffer element; known TS limitation, compiles and works correctly
      Buffer.from([requestChange === "increase" ? 1 : 2]),
    ],
    JUPITER_PERPETUALS_PROGRAM_ID
  );
  return pda;
}

export async function fetchPosition(positionPda: PublicKey) {
  const program = getPerpsProgram();
  return program.account.position.fetchNullable(positionPda);
}

export async function fetchPositionRequest(positionRequestPda: PublicKey) {
  const program = getPerpsProgram();
  return program.account.positionRequest.fetchNullable(positionRequestPda);
}

export async function fetchAllPositionsForWallet(walletPubkey: PublicKey) {
  const program = getPerpsProgram();
  return program.account.position.all([
    {
      memcmp: {
        offset: 8,
        bytes: walletPubkey.toBase58(),
      },
    },
  ]);
}

export interface IncreasePositionParams {
  walletPublicKey: PublicKey;
  asset: "SOL" | "ETH" | "BTC";
  side: "long" | "short";
  sizeUsdDelta: BN;
  collateralTokenDelta: BN;
  priceSlippage: BN;
  counter: BN;
}

export interface DecreasePositionParams {
  walletPublicKey: PublicKey;
  asset: "SOL" | "ETH" | "BTC";
  side: "long" | "short";
  sizeUsdDelta: BN;
  collateralUsdDelta: BN;
  priceSlippage: BN;
  entirePosition: boolean;
  counter: BN;
  desiredMint?: PublicKey; // Optional: mint to receive when closing position (default USDC)
}

// Custody details mapping from remaining-accounts.ts reference
const CUSTODY_DETAILS: Record<string, { mint: PublicKey; pythnetOracle: PublicKey; dovesAgOracle: PublicKey }> = {
  // SOL
  [CUSTODY_ADDRESSES.SOL.toString()]: {
    mint: new PublicKey("So11111111111111111111111111111111111111112"),
    pythnetOracle: new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
    dovesAgOracle: new PublicKey("FYq2BWQ1V5P1WFBqr3qB2Kb5yHVvSv7upzKodgQE5zXh"),
  },
  // ETH
  [CUSTODY_ADDRESSES.ETH.toString()]: {
    mint: new PublicKey("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"),
    pythnetOracle: new PublicKey("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC"),
    dovesAgOracle: new PublicKey("AFZnHPzy4mvVCffrVwhewHbFc93uTHvDSFrVH7GtfXF1"),
  },
  // BTC
  [CUSTODY_ADDRESSES.BTC.toString()]: {
    mint: new PublicKey("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"),
    pythnetOracle: new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"),
    dovesAgOracle: new PublicKey("hUqAT1KQ7eW1i6Csp9CXYtpPfSAvi835V7wKi5fRfmC"),
  },
  // USDC
  [CUSTODY_ADDRESSES.USDC.toString()]: {
    mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    pythnetOracle: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
    dovesAgOracle: new PublicKey("6Jp2xZUTWdDD2ZyUPRzeMdc6AFQ5K3pFgZxk2EijfjnM"),
  },
  // USDT (not used in our interface but included for completeness)
  [CUSTODY_ADDRESSES.USDT.toString()]: {
    mint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    pythnetOracle: new PublicKey("HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM"),
    dovesAgOracle: new PublicKey("Fgc93D641F8N2d1xLjQ4jmShuD3GE3BsCXA56KBQbF5u"),
  },
};

// Helper function to get associated token address without importing @solana/spl-token
function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = true
): PublicKey {
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error("Owner must be on curve");
  }

  const [address] = PublicKey.findProgramAddressSync(
    [
      owner.toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  return address;
}

export async function buildIncreasePositionIx(
  params: IncreasePositionParams
): Promise<TransactionInstruction> {
  const { custody, collateralCustody } = getCustodyAccounts(params.asset, params.side);
  const positionPda = derivePositionPda(
    params.walletPublicKey, custody, collateralCustody, params.side
  );
  const positionRequestPda = derivePositionRequestPda(positionPda, params.counter, "increase");
  const program = getPerpsProgram();

  // Determine input mint: for long positions use asset mint, for short use USDC mint
  const inputMint = params.side === "long"
    ? CUSTODY_DETAILS[custody.toString()].mint
    : CUSTODY_DETAILS[CUSTODY_ADDRESSES.USDC.toString()].mint;

  // Get remaining accounts (all custody accounts and their oracles)
  const remainingAccounts = await getRemainingAccounts();

  const fundingAccount = getAssociatedTokenAddressSync(
    inputMint,
    params.walletPublicKey
  );

  const positionRequestAta = getAssociatedTokenAddressSync(
    inputMint,
    positionRequestPda,
    true
  );

  // Build perpetuals PDA (from create-market-trade-request.ts line 127-131)
  const perpetuals = PublicKey.findProgramAddressSync(
    [Buffer.from("perpetuals")],
    JUPITER_PERPETUALS_PROGRAM_ID
  )[0];

  // Build and return the instruction — do not sign or submit
  const ix = await program.methods
    .createIncreasePositionMarketRequest({
      counter: params.counter,
      collateralTokenDelta: params.collateralTokenDelta,
      jupiterMinimumOut: null,
      priceSlippage: params.priceSlippage,
      side: params.side === "long" ? { long: {} } : { short: {} },
      sizeUsdDelta: params.sizeUsdDelta,
    })
    .accounts({
      custody: custody,
      collateralCustody: collateralCustody,
      fundingAccount: fundingAccount,
      inputMint: inputMint,
      owner: params.walletPublicKey,
      perpetuals: perpetuals,
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position: positionPda,
      positionRequest: positionRequestPda,
      positionRequestAta: positionRequestAta,
      referral: null as any,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  return ix;
}

export async function buildDecreasePositionIx(
  params: DecreasePositionParams
): Promise<TransactionInstruction> {
  const { custody, collateralCustody } = getCustodyAccounts(params.asset, params.side);
  const positionPda = derivePositionPda(
    params.walletPublicKey, custody, collateralCustody, params.side
  );
  const positionRequestPda = derivePositionRequestPda(positionPda, params.counter, "decrease");
  const program = getPerpsProgram();

  // Default desired mint to USDC if not specified
  const desiredMint = params.desiredMint || CUSTODY_DETAILS[CUSTODY_ADDRESSES.USDC.toString()].mint;

  // Get remaining accounts (all custody accounts and their oracles)
  const remainingAccounts = await getRemainingAccounts();

  const positionRequestAta = getAssociatedTokenAddressSync(
    desiredMint,
    positionRequestPda,
    true
  );

  const receivingAccount = getAssociatedTokenAddressSync(
    desiredMint,
    params.walletPublicKey
  );

  // Build perpetuals PDA (from create-market-trade-request.ts line 127-131)
  const perpetuals = PublicKey.findProgramAddressSync(
    [Buffer.from("perpetuals")],
    JUPITER_PERPETUALS_PROGRAM_ID
  )[0];

  // Build and return the instruction — do not sign or submit
  const ix = await program.methods
    .createDecreasePositionMarketRequest({
      sizeUsdDelta: params.sizeUsdDelta,
      collateralUsdDelta: params.collateralUsdDelta,
      priceSlippage: params.priceSlippage,
      jupiterMinimumOut: null,
      entirePosition: params.entirePosition,
      counter: params.counter,
    })
    .accounts({
      owner: params.walletPublicKey,
      receivingAccount: receivingAccount,
      perpetuals: perpetuals,
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      position: positionPda,
      positionRequest: positionRequestPda,
      positionRequestAta: positionRequestAta,
      custody: custody,
      collateralCustody: collateralCustody,
      desiredMint: desiredMint,
      referral: null as any,
    })
    .remainingAccounts(remainingAccounts)
    .instruction();

  return ix;
}

// Helper function to get remaining accounts as per remaining-accounts.ts reference
async function getRemainingAccounts(): Promise<Array<{ isSigner: boolean; isWritable: boolean; pubkey: PublicKey }>> {
  const program = getPerpsProgram();

  try {
    // Fetch pool to get all custody accounts
    const pool = await program.account.pool.fetch(JLP_POOL_ACCOUNT_PUBKEY);

    const remainingAccounts = [];

    // First: all custody accounts
    for (const custody of pool.custodies as PublicKey[]) {
      remainingAccounts.push({
        isSigner: false,
        isWritable: false,
        pubkey: custody,
      });
    }

    // Second: dovesAgOracle for each custody
    for (const custody of pool.custodies as PublicKey[]) {
      const custodyKey = custody.toString();
      const details = CUSTODY_DETAILS[custodyKey];

      if (details) {
        remainingAccounts.push({
          isSigner: false,
          isWritable: false,
          pubkey: details.dovesAgOracle,
        });
      }
    }

    // Third: pythnetOracle for each custody
    for (const custody of pool.custodies as PublicKey[]) {
      const custodyKey = custody.toString();
      const details = CUSTODY_DETAILS[custodyKey];

      if (details) {
        remainingAccounts.push({
          isSigner: false,
          isWritable: false,
          pubkey: details.pythnetOracle,
        });
      }
    }

    return remainingAccounts;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Failed to fetch pool for remaining accounts:", msg);
    throw new Error(
      `Could not read the Jupiter Perps pool account: ${msg}. No transaction was built or sent.`
    );
  }
}

export async function buildCancelPositionRequestIx(params: {
  walletPublicKey: PublicKey;
  positionPda: PublicKey;
  positionRequestPda: PublicKey;
  asset: "SOL" | "ETH" | "BTC";
  side: "long" | "short";
}): Promise<TransactionInstruction> {
  const program = getPerpsProgram();

  // Get the position request to find the mint
  let positionRequest: any;
  try {
    positionRequest = await program.account.positionRequest.fetch(params.positionRequestPda);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Position request ${params.positionRequestPda.toString()} could not be read: ${msg}. ` +
        `It may already have been executed, rejected or closed — check get_perp_positions and get_position_request_status. ` +
        `No cancel transaction was built or sent.`
    );
  }

  // Extract mint from position request
  const mint = positionRequest.mint as PublicKey;
  const isSOLMint = mint.equals(CUSTODY_DETAILS[CUSTODY_ADDRESSES.SOL.toString()].mint);

  const positionRequestAta = getAssociatedTokenAddressSync(
    mint,
    params.positionRequestPda,
    true
  );

  // ownerAta is an optional account in the IDL: Anchor 0.29 needs null (not undefined) to omit it.
  const ownerAta = isSOLMint ? null : getAssociatedTokenAddressSync(mint, params.walletPublicKey);

  // Build and return the instruction
  const ix = await program.methods
    .closePositionRequest({})
    .accounts({
      keeper: null as any,
      owner: params.walletPublicKey,
      ownerAta: ownerAta as any,
      pool: JLP_POOL_ACCOUNT_PUBKEY,
      positionRequest: params.positionRequestPda,
      positionRequestAta: positionRequestAta,
      position: params.positionPda,
    })
    .instruction();

  return ix;
}