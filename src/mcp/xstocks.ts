/**
 * xStocks MCP tools — buy/sell tokenized stocks through Quotrons pools on Ink.
 *
 * Venue facts (verified onchain 2026-10-02):
 * - Quotrons Ink venue: 9 Uniswap v4 pools, custom PoolManager
 *   0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32 (note: it has an owner(),
 *   unlike the canonical v4 deployment — trust assumption, documented).
 * - Pools trade WRAPPED xStocks (wAAPLx etc., ERC-4626-style vault shares
 *   1:1 backed by the underlying xStock) against USDG (Paxos Global Dollar).
 * - Swap fee is dynamic, currently 30 bps (range 5-100 bps).
 * - xStocks are freely transferable (bearer debt instruments) — no
 *   whitelist, no eligibility check.
 *
 * Execution: an EOA cannot call a v4 PoolManager directly (unlock() needs a
 * callback contract), so swaps route through the 0x v2 API, whose settlement
 * contract already handles these pools on Ink. The tools shell out to the
 * 0x skill's auth helpers for quotes and calldata.
 *
 * Key posture: this module NEVER signs and NEVER broadcasts. Every tool that
 * moves funds returns ordered UNSIGNED transactions for the agent to sign
 * client-side with her own wallet key (created via wallet_create, backed up
 * by the human, proven with wallet_verify_backup). Trade tools take a
 * `backupVerified` flag and refuse to build anything until the wallet has
 * been through the backup ritual.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  type Address,
  type Hex,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
} from 'viem';
import { z } from 'zod';
import { CHAIN_ID, USDC_ADDRESS, ink } from '../constants.js';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const OX_PRICE_BIN = join(homedir(), 'workspace', 'skills', '0x', 'bin', '0x-price');
// ox-swap-quote.py lives next to this module in src/mcp/bin/
const OX_QUOTE_BIN = join(MODULE_DIR, 'bin', 'ox-swap-quote.py');

export const USDG_ADDRESS = getAddress('0xe343167631d89B6Ffc58B88d6b7fB0228795491D');
export const USDG_DECIMALS = 6;
export const USDC_DECIMALS = 6;
const WRAPPED_DECIMALS = 18;

/** Default integrator-fee recipient: the 402 treasury (pure recipient, Father holds the key). */
export const DEFAULT_FEE_RECIPIENT = getAddress('0xaA4E163dA1545F6967d284C0C5CFA469C644eD23');

/**
 * Integrator fee config, operator-set via env (the MCP runs per-operator over
 * stdio, so whoever distributes it configures their own take):
 * - FOUR02_XSTOCKS_FEE_BPS: 0-1000, default 25 (0.25%).
 * - FOUR02_XSTOCKS_FEE_RECIPIENT: default the 402 treasury.
 * The fee applies ONCE per stock trade, on the leg touching the wrapped stock
 * token (USDG -> wSTOCK on buys, wSTOCK -> USDG on sells), taken in the buy
 * token and sent onchain to the recipient by the 0x settlement contract.
 */
export interface XstocksFeeConfig {
  bps: number;
  recipient: Address;
}
export function loadXstocksFeeConfig(): XstocksFeeConfig {
  const bps = parseInt((process.env.FOUR02_XSTOCKS_FEE_BPS ?? '25').trim(), 10);
  if (!Number.isInteger(bps) || bps < 0 || bps > 1000) {
    throw new Error('FOUR02_XSTOCKS_FEE_BPS must be an integer 0-1000');
  }
  const raw = (process.env.FOUR02_XSTOCKS_FEE_RECIPIENT ?? '').trim();
  const recipient = raw ? getAddress(raw) : DEFAULT_FEE_RECIPIENT;
  return { bps, recipient };
}

/** Verified Quotrons Ink pools (2026-10-02). Pair asset is USDG for all. */
export interface XStockPool {
  ticker: string;
  name: string;
  /** Underlying Backed xStock on Ink. */
  xstock: Address;
  /** Wrapped vault share actually traded in the pool. */
  wrapped: Address;
  /** Uniswap v4 pool id. */
  poolId: Hex;
}
export const XSTOCK_POOLS: XStockPool[] = [
  { ticker: 'AAPL', name: 'Apple', xstock: getAddress('0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a'), wrapped: getAddress('0x943BF64D566c32A2Bcd41AC92FB63C111cC9De8f'), poolId: '0x0ef0fe35389f4104afef27864010022976ed1b924e8837b30f308255d07d3092' },
  { ticker: 'NVDA', name: 'Nvidia', xstock: getAddress('0xc845b2894dBddd03858fd2D643B4eF725fE0849d'), wrapped: getAddress('0xa8ddb5Cd96b5222AFe198316E9A57CAA642850D5'), poolId: '0xebe5d3cc94d87cf07cf06c969ca82a67760697535c57800350e210df8547cd11' },
  { ticker: 'MSTR', name: 'Strategy', xstock: getAddress('0xAE2f842EF90C0d5213259Ab82639D5BBF649b08E'), wrapped: getAddress('0x30987adF0B11dc698438a99BA04ec3a1AB2c7EaB'), poolId: '0xb7add80f794d65c978346f9e929971d2f12b4f862c89f4c14201872819a39a7d' },
  { ticker: 'NFLX', name: 'Netflix', xstock: getAddress('0xa6a65ac27e76cd53cb790473e4345c46e5ebf961'), wrapped: getAddress('0x7d87fD6A379714194a797c0bBB8B40c30D250856'), poolId: '0x9f11034d6b2a7bfea38a0c39548c590e4aabd215ffa2b6bbe9bacd29e40238b6' },
  { ticker: 'SPY', name: 'S&P 500 ETF', xstock: getAddress('0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48'), wrapped: getAddress('0xE7E553Cd128F0011777323A0b44a7b96EA1CB540'), poolId: '0x84b421dc355c6c003fcf4f8100691eddaa0319deb894acb7e9bbf633621694a7' },
  { ticker: 'TSLA', name: 'Tesla', xstock: getAddress('0x8aD3c73F833d3F9A523aB01476625F269aEB7Cf0'), wrapped: getAddress('0xc3FdBe3A68EE5dE461D30415a8165cf9Aefe1171'), poolId: '0x131ebb0eb148451d7225a52e94a8257b69976e780ebce1615aadf47d8e2aaf19' },
  { ticker: 'GOOGL', name: 'Alphabet', xstock: getAddress('0xe92f673Ca36C5E2Efd2DE7628f815f84807e803F'), wrapped: getAddress('0xf8c5308F80E459bb53d9EbE689854d9cBb2Caa6f'), poolId: '0x5ec6f9fc8178f8b3a9c09b56d073a4503a5ea3f127ece3e8a8d1579c0cf9c3b2' },
  { ticker: 'AMZN', name: 'Amazon', xstock: getAddress('0x3557Ba345B01EFa20A1bdDC61F573BFD87195081'), wrapped: getAddress('0x910cabdE3EBa7Fc1Ce64fD14bD680b9f60fA0F90'), poolId: '0xc113916ee057276dfd79b4ff4a29be5e98703e410923e4a61e95ccf459223a38' },
  { ticker: 'MCD', name: "McDonald's", xstock: getAddress('0x80a77a372c1e12accda84299492f404902e2da67'), wrapped: getAddress('0xc6639026a3a862cd4fcbae3f67cB2D25A2959d37'), poolId: '0x020595993f159c9865966f8762ebdba88c2cf465bb4af72b512eb3559f430254' },
];

/** Pre-loaded equal-weight baskets. `all` covers every live pool. */
export const XSTOCK_BASKETS: Record<string, { description: string; tickers: string[] }> = {
  bigtech: {
    description: 'Big tech: Apple, Nvidia, Tesla, Amazon, Alphabet — equal weight',
    tickers: ['AAPL', 'NVDA', 'TSLA', 'AMZN', 'GOOGL'],
  },
  yolo: {
    description: 'High beta: Strategy, Netflix, McDonalds — equal weight',
    tickers: ['MSTR', 'NFLX', 'MCD'],
  },
  all: {
    description: 'Every live Quotrons Ink pool — equal weight',
    tickers: XSTOCK_POOLS.map((p) => p.ticker),
  },
};

export const QUOTRONS_INK_CONTRACTS = {
  poolManager: getAddress('0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32'),
  hook: getAddress('0x8bb4516059F9149Bc3b89018Fc7537f1F14a30cc'),
  factory: getAddress('0xbFA531C90FD9e42aC13Af14823B30e40761dd3A2'),
  note:
    'The Ink PoolManager is a custom deployment with an owner() — unlike the canonical ' +
    'Uniswap v4 deployment. The owner can set protocol fees. Trades execute through the ' +
    '0x v2 settlement contract, never through this module.',
};

function poolByTicker(ticker: string): XStockPool {
  const t = ticker.trim().toUpperCase();
  const p = XSTOCK_POOLS.find((x) => x.ticker === t);
  if (!p) throw new Error(`Unknown ticker "${ticker}". Use xstocks_list for the 9 live tickers.`);
  return p;
}

function textResult(obj: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
  };
}

function backupRitual() {
  return textResult({
    ok: false,
    blocked: 'backup ritual incomplete',
    do_this_first: [
      '1. wallet_create — generate her Ink wallet (key returned to you, never stored by the server).',
      '2. Hand the private key to the human and have them back it up to durable SECRET storage (vault/encrypted disk/secret manager) — never chat, logs, or code.',
      '3. Reload the key FROM that storage and call wallet_verify_backup with the reloaded key + address.',
      '4. Only after wallet_verify_backup reports matches:true, fund the wallet with Ink ETH (gas) + USDC.',
      '5. Then re-call this tool with backupVerified:true.',
    ],
    why: 'She will be signing real swaps with this key. An unbacked key means the wallet and everything in it is gone forever if lost.',
  });
}

interface OxPrice {
  buyAmount: string;
  sellAmount: string;
  estimatedPriceImpact?: string | null;
  liquidityAvailable?: boolean;
}
function oxPrice(sellToken: Address, buyToken: Address, sellAmount: bigint): OxPrice {
  const out = execFileSync(
    OX_PRICE_BIN,
    [
      '--chain-id', String(CHAIN_ID),
      '--sell-token', sellToken,
      '--buy-token', buyToken,
      '--sell-amount', sellAmount.toString(),
    ],
    { encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const d = JSON.parse(out);
  if (!d.buyAmount || d.liquidityAvailable === false) {
    throw new Error(`No 0x liquidity for ${sellToken} -> ${buyToken}: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return d;
}

interface OxQuoteTx {
  to: Address;
  data: Hex;
  value: string;
  gas?: string;
  gasPrice?: string;
}
interface OxIntegratorFee {
  amount: string;
  token: Address;
}
interface OxQuote extends OxPrice {
  transaction: OxQuoteTx;
  allowanceSpender?: Address;
  integratorFee?: OxIntegratorFee;
}
function oxSwapQuote(
  sellToken: Address,
  buyToken: Address,
  sellAmount: bigint,
  taker: Address,
  slippageBps = 100,
  fee: XstocksFeeConfig = { bps: 0, recipient: DEFAULT_FEE_RECIPIENT },
): OxQuote {
  const args = [
      OX_QUOTE_BIN,
      '--chain-id', String(CHAIN_ID),
      '--sell-token', sellToken,
      '--buy-token', buyToken,
      '--sell-amount', sellAmount.toString(),
      '--taker', taker,
      '--slippage-bps', String(slippageBps),
  ];
  if (fee.bps > 0) {
    args.push('--fee-bps', String(fee.bps), '--fee-recipient', fee.recipient);
  }
  const out = execFileSync(
    'python3',
    args,
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const d = JSON.parse(out);
  const tx = d.transaction ?? {};
  const int = d.integratorFee ?? {};
  return {
    buyAmount: d.buyAmount,
    sellAmount: d.sellAmount,
    estimatedPriceImpact: d.estimatedPriceImpact,
    liquidityAvailable: d.liquidityAvailable,
    transaction: {
      to: getAddress(tx.to),
      data: tx.data as Hex,
      value: tx.value ?? '0',
      gas: tx.gas,
      gasPrice: tx.gasPrice,
    },
    allowanceSpender: d?.issues?.allowance?.spender
      ? getAddress(d.issues.allowance.spender)
      : undefined,
    integratorFee: int.amount
      ? { amount: int.amount, token: getAddress(int.token) }
      : undefined,
  };
}

export interface RegisterXstocksOptions {
  inkRpcUrl: string;
}

export function registerXstocksTools(
  server: McpServer,
  opts: RegisterXstocksOptions,
) {
  const publicClient = createPublicClient({ chain: ink, transport: http(opts.inkRpcUrl) });
  const usdc = getAddress(USDC_ADDRESS);
  const fee = loadXstocksFeeConfig();

  /** Disclosed fee schedule block included in every trade-related output. */
  function feeDisclosure() {
    return {
      feeBps: fee.bps,
      feeRecipient: fee.recipient,
      appliesTo: 'stock leg only (USDG -> wSTOCK on buys, wSTOCK -> USDG on sells)',
      note:
        fee.bps === 0
          ? 'No integrator fee configured (FOUR02_XSTOCKS_FEE_BPS=0).'
          : `A ${fee.bps} bps integrator fee is taken in the buy token on the stock leg and sent onchain to the fee recipient by the 0x settlement contract.`,
    };
  }

  function feeTaken(q: OxQuote, tokenDecimals: number, tokenSymbol: string) {
    if (!q.integratorFee) return null;
    return {
      amount: formatUnits(BigInt(q.integratorFee.amount), tokenDecimals),
      token: tokenSymbol,
      tokenAddress: q.integratorFee.token,
      recipient: fee.recipient,
    };
  }

  async function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
    return (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    })) as bigint;
  }

  async function approveTxIfNeeded(
    token: Address,
    owner: Address,
    spender: Address,
    needed: bigint,
    txs: Array<{ to: Address; data: Hex; value: string; purpose: string }>,
  ) {
    const current = await allowance(token, owner, spender);
    if (current < needed) {
      const decimals = token === USDG_ADDRESS || token === usdc ? 6 : WRAPPED_DECIMALS;
      txs.push({
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spender, needed],
        }),
        value: '0',
        purpose: `approve exactly ${formatUnits(needed, decimals)} of ${token} to the 0x spender`,
      });
    }
    return current < needed;
  }

  // ---- xstocks_list -------------------------------------------------------
  server.registerTool(
    'xstocks_list',
    {
      description:
        'List the tokenized stocks tradeable through Quotrons pools on Ink: 9 live tickers ' +
        '(AAPL, NVDA, TSLA, AMZN, GOOGL, MSTR, NFLX, SPY, MCD), their wrapped pool tokens, ' +
        'pool IDs, and the pre-loaded baskets (bigtech, yolo, all). Read-only. ' +
        'Note: pools trade wrapped vault shares (wAAPLx etc., 1:1 backed by the xStock) ' +
        'against USDG, not USDC directly.',
    },
    async () => {
      return textResult({
        ok: true,
        venue: 'Quotrons Ink — Uniswap v4 pools (custom PoolManager; see trust note)',
        contracts: {
          ...QUOTRONS_INK_CONTRACTS,
          poolManager: QUOTRONS_INK_CONTRACTS.poolManager,
        },
        pairAsset: { symbol: 'USDG', address: USDG_ADDRESS, decimals: USDG_DECIMALS, note: 'Paxos Global Dollar — buy leg is USDC -> USDG -> wSTOCK' },
        pools: XSTOCK_POOLS.map((p) => ({
          ticker: p.ticker,
          name: p.name,
          wrappedToken: p.wrapped,
          underlyingXStock: p.xstock,
          poolId: p.poolId,
        })),
        baskets: Object.fromEntries(
          Object.entries(XSTOCK_BASKETS).map(([k, v]) => [k, { description: v.description, tickers: v.tickers }]),
        ),
      });
    },
  );

  const quoteSchema = {
    ticker: z.string().describe('Stock ticker, e.g. AAPL. See xstocks_list.'),
    amountUsd: z
      .string()
      .regex(/^\d+(\.\d{1,6})?$/, 'human-readable USD amount like "100" or "25.50"')
      .describe('How much USDC to spend (human-readable, e.g. "100").'),
  };

  const tradeSchema = {
    ...quoteSchema,
    walletAddress: z.string().describe('Her Ink wallet address (0x…). She signs with its key.'),
    backupVerified: z
      .boolean()
      .describe(
        'MUST be true, set only after wallet_verify_backup reported matches:true for this wallet. ' +
          'If false or omitted, the tool returns the backup ritual instead of building transactions.',
      ),
    slippageBps: z.number().int().min(10).max(1000).optional()
      .describe('Slippage tolerance in bps, default 100 (1%).'),
  };

  // ---- xstocks_quote ------------------------------------------------------
  server.registerTool(
    'xstocks_quote',
    {
      description:
        'Quote buying a tokenized stock: how much wrapped stock X USDC buys right now, ' +
        'broken into legs (USDC -> USDG -> wTICKER) with expected outputs and price impact. ' +
        'Read-only, no wallet needed, nothing is built or signed.',
      inputSchema: quoteSchema,
    },
    async (args) => {
      const pool = poolByTicker(args.ticker);
      const usdcIn = parseUnits(args.amountUsd, USDC_DECIMALS);
      if (usdcIn <= 0n) throw new Error('amountUsd must be > 0');
      const leg1 = oxPrice(usdc, USDG_ADDRESS, usdcIn);
      const usdgOut = BigInt(leg1.buyAmount);
      const leg2 = oxPrice(USDG_ADDRESS, pool.wrapped, usdgOut);
      return textResult({
        ok: true,
        ticker: pool.ticker,
        name: pool.name,
        legs: [
          {
            sell: 'USDC', buy: 'USDG',
            sellAmount: formatUnits(usdcIn, USDC_DECIMALS),
            buyAmount: formatUnits(usdgOut, USDG_DECIMALS),
            priceImpactBps: leg1.estimatedPriceImpact,
          },
          {
            sell: 'USDG', buy: `w${pool.ticker}x`,
            sellAmount: formatUnits(usdgOut, USDG_DECIMALS),
            buyAmount: formatUnits(BigInt(leg2.buyAmount), WRAPPED_DECIMALS),
            priceImpactBps: leg2.estimatedPriceImpact,
          },
        ],
        totalInUsdc: args.amountUsd,
        expectedWrappedOut: formatUnits(BigInt(leg2.buyAmount), WRAPPED_DECIMALS),
        fee: {
          ...feeDisclosure(),
          note: fee.bps === 0
            ? 'No integrator fee configured.'
            : 'Quoted amounts are PRE-FEE. On execution the fee is deducted from the buy amount on the stock leg (USDG -> wSTOCK) and sent to the fee recipient.',
        },
        note: 'Indicative quote. Actual execution goes through the 0x v2 settlement contract; final amounts depend on pool state at execution.',
      });
    },
  );

  /** Build ordered unsigned txs for USDC -> USDG -> wTICKER. Fee on the stock leg. */
  async function buildBuyTxs(
    pool: XStockPool,
    usdcIn: bigint,
    wallet: Address,
    slippageBps: number,
  ) {
    // Quotes first (read-only) so approvals and leg-2 sizing are exact.
    const leg1 = oxSwapQuote(usdc, USDG_ADDRESS, usdcIn, wallet, slippageBps);
    const usdgOut = BigInt(leg1.buyAmount);
    const leg2 = oxSwapQuote(USDG_ADDRESS, pool.wrapped, usdgOut, wallet, slippageBps, fee);
    const spender = leg1.allowanceSpender ?? leg2.allowanceSpender;
    if (!spender) throw new Error('0x quote did not report an allowance spender');

    const txs: Array<{ to: Address; data: Hex; value: string; purpose: string }> = [];
    await approveTxIfNeeded(usdc, wallet, spender, usdcIn, txs);
    txs.push({ ...leg1.transaction, purpose: `swap ${formatUnits(usdcIn, 6)} USDC -> USDG (0x)` });
    await approveTxIfNeeded(USDG_ADDRESS, wallet, spender, usdgOut, txs);
    txs.push({ ...leg2.transaction, purpose: `swap ${formatUnits(usdgOut, 6)} USDG -> w${pool.ticker}x (0x, Quotrons pool)` });
    return {
      txs,
      expectedWrappedOut: formatUnits(BigInt(leg2.buyAmount), WRAPPED_DECIMALS),
      usdgOut: formatUnits(usdgOut, USDG_DECIMALS),
      spender,
      integratorFee: feeTaken(leg2, WRAPPED_DECIMALS, `w${pool.ticker}x`),
    };
  }

  // ---- xstocks_buy ---------------------------------------------------------
  server.registerTool(
    'xstocks_buy',
    {
      description:
        'Build the UNSIGNED transactions for her to buy a tokenized stock: ' +
        'USDC -> USDG -> wTICKER through the Quotrons Ink pool, routed via 0x v2. ' +
        'Returns ordered txs (approvals only if allowance is short) for HER to sign ' +
        'client-side with her own wallet key and broadcast herself. The server never ' +
        'signs and never broadcasts. Requires backupVerified:true (wallet_create -> ' +
        'human backup -> wallet_verify_backup -> fund with ETH+USDC first).',
      inputSchema: tradeSchema,
    },
    async (args) => {
      if (!args.backupVerified) return backupRitual();
      if (!isAddress(args.walletAddress)) throw new Error('walletAddress is not a valid address');
      const wallet = getAddress(args.walletAddress);
      const pool = poolByTicker(args.ticker);
      const usdcIn = parseUnits(args.amountUsd, USDC_DECIMALS);
      if (usdcIn <= 0n) throw new Error('amountUsd must be > 0');
      const slippageBps = args.slippageBps ?? 100;
      const built = await buildBuyTxs(pool, usdcIn, wallet, slippageBps);
      return textResult({
        ok: true,
        ticker: pool.ticker,
        name: pool.name,
        spendUsdc: args.amountUsd,
        expectedWrappedOut: built.expectedWrappedOut,
        usdgLeg: built.usdgOut,
        slippageBps,
        chainId: CHAIN_ID,
        fee: { ...feeDisclosure(), taken: built.integratorFee },
        sign_and_broadcast: [
          'Sign each transaction below IN ORDER with her own wallet key (the one from wallet_create).',
          'Send (broadcast) each signed tx to Ink (chain 57073) and wait for 1 confirmation before the next.',
          'The server cannot sign or broadcast for her — if a tx fails, stop and report the revert.',
        ],
        transactions: built.txs,
      });
    },
  );

  // ---- xstocks_sell --------------------------------------------------------
  server.registerTool(
    'xstocks_sell',
    {
      description:
        'Build the UNSIGNED transactions for her to sell a tokenized stock back to USDC: ' +
        'wTICKER -> USDG -> USDC, routed via 0x v2 through the Quotrons Ink pool. ' +
        'Pass amountWrapped ("1.5") or "all" to sell the full wTICKER balance. ' +
        'Same signing model as xstocks_buy: she signs client-side, server never signs. ' +
        'Requires backupVerified:true.',
      inputSchema: {
      ticker: z.string().describe('Stock ticker, e.g. AAPL. See xstocks_list.'),
      amountWrapped: z
        .string()
        .describe('Human-readable wrapped amount ("1.5") or "all" for the full balance.'),
      walletAddress: z.string().describe('Her Ink wallet address (0x…). She signs with its key.'),
      backupVerified: z
        .boolean()
        .describe('MUST be true, set only after wallet_verify_backup reported matches:true.'),
      slippageBps: z.number().int().min(10).max(1000).optional()
        .describe('Slippage tolerance in bps, default 100 (1%).'),
      },
    },
    async (args) => {
      if (!args.backupVerified) return backupRitual();
      if (!isAddress(args.walletAddress)) throw new Error('walletAddress is not a valid address');
      const wallet = getAddress(args.walletAddress);
      const pool = poolByTicker(args.ticker);
      const slippageBps = args.slippageBps ?? 100;
      let wrappedIn: bigint;
      if (args.amountWrapped.trim().toLowerCase() === 'all') {
        wrappedIn = (await publicClient.readContract({
          address: pool.wrapped, abi: erc20Abi, functionName: 'balanceOf', args: [wallet],
        })) as bigint;
        if (wrappedIn <= 0n) throw new Error(`Wallet holds no w${pool.ticker}x`);
      } else {
        wrappedIn = parseUnits(args.amountWrapped, WRAPPED_DECIMALS);
        if (wrappedIn <= 0n) throw new Error('amountWrapped must be > 0');
      }
      const leg1 = oxSwapQuote(pool.wrapped, USDG_ADDRESS, wrappedIn, wallet, slippageBps, fee);
      const usdgOut = BigInt(leg1.buyAmount);
      const leg2 = oxSwapQuote(USDG_ADDRESS, usdc, usdgOut, wallet, slippageBps);
      const spender = leg1.allowanceSpender ?? leg2.allowanceSpender;
      if (!spender) throw new Error('0x quote did not report an allowance spender');
      const txs: Array<{ to: Address; data: Hex; value: string; purpose: string }> = [];
      await approveTxIfNeeded(pool.wrapped, wallet, spender, wrappedIn, txs);
      txs.push({ ...leg1.transaction, purpose: `swap w${pool.ticker}x -> USDG (0x, Quotrons pool)` });
      await approveTxIfNeeded(USDG_ADDRESS, wallet, spender, usdgOut, txs);
      txs.push({ ...leg2.transaction, purpose: `swap USDG -> USDC (0x)` });
      return textResult({
        ok: true,
        ticker: pool.ticker,
        sellWrapped: formatUnits(wrappedIn, WRAPPED_DECIMALS),
        expectedUsdg: formatUnits(usdgOut, USDG_DECIMALS),
        expectedUsdc: formatUnits(BigInt(leg2.buyAmount), USDC_DECIMALS),
        slippageBps,
        chainId: CHAIN_ID,
        fee: { ...feeDisclosure(), taken: feeTaken(leg1, USDG_DECIMALS, 'USDG') },
        sign_and_broadcast: [
          'Sign each transaction below IN ORDER with her own wallet key.',
          'Send each signed tx to Ink (chain 57073), waiting 1 confirmation between txs.',
        ],
        transactions: txs,
      });
    },
  );

  // ---- xstocks_balance -----------------------------------------------------
  server.registerTool(
    'xstocks_balance',
    {
      description:
        'Read her Ink wallet balances: ETH, USDC, USDG, and every wrapped xStock. ' +
        'Read-only.',
      inputSchema: {
      walletAddress: z.string().describe('Her Ink wallet address (0x…).'),
      },
    },
    async (args) => {
      if (!isAddress(args.walletAddress)) throw new Error('walletAddress is not a valid address');
      const wallet = getAddress(args.walletAddress);
      const [eth, usdcBal, usdgBal] = await Promise.all([
        publicClient.getBalance({ address: wallet }),
        publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) as Promise<bigint>,
        publicClient.readContract({ address: USDG_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }) as Promise<bigint>,
      ]);
      const stocks = await Promise.all(
        XSTOCK_POOLS.map(async (p) => ({
          ticker: p.ticker,
          balance: formatUnits(
            (await publicClient.readContract({
              address: p.wrapped, abi: erc20Abi, functionName: 'balanceOf', args: [wallet],
            })) as bigint,
            WRAPPED_DECIMALS,
          ),
        })),
      );
      return textResult({
        ok: true,
        wallet,
        eth: formatUnits(eth, 18),
        usdc: formatUnits(usdcBal, USDC_DECIMALS),
        usdg: formatUnits(usdgBal, USDG_DECIMALS),
        stocks: stocks.filter((s) => s.balance !== '0'),
      });
    },
  );

  // ---- xstocks_basket_buy --------------------------------------------------
  server.registerTool(
    'xstocks_basket_buy',
    {
      description:
        'Buy a pre-loaded basket of tokenized stocks in ONE command: the USDC amount is ' +
        'split EQUAL-WEIGHT across the basket tickers (bigtech, yolo, all — see ' +
        'xstocks_list). Quotes every leg first and shows the full per-ticker breakdown, ' +
        'then returns the ordered UNSIGNED transactions: one USDC -> USDG swap plus one ' +
        'USDG -> wTICKER swap per ticker. She signs client-side, in order. ' +
        'Requires backupVerified:true.',
      inputSchema: {
      basket: z.string().describe('Basket name: bigtech, yolo, or all. See xstocks_list.'),
      amountUsd: z
        .string()
        .regex(/^\d+(\.\d{1,6})?$/, 'human-readable USD amount like "100"')
        .describe('Total USDC to spend across the basket (human-readable).'),
      walletAddress: z.string().describe('Her Ink wallet address (0x…). She signs with its key.'),
      backupVerified: z
        .boolean()
        .describe('MUST be true, set only after wallet_verify_backup reported matches:true.'),
      slippageBps: z.number().int().min(10).max(1000).optional()
        .describe('Slippage tolerance in bps, default 100 (1%).'),
      },
    },
    async (args) => {
      if (!args.backupVerified) return backupRitual();
      if (!isAddress(args.walletAddress)) throw new Error('walletAddress is not a valid address');
      const wallet = getAddress(args.walletAddress);
      const key = args.basket.trim().toLowerCase();
      const basket = XSTOCK_BASKETS[key];
      if (!basket) throw new Error(`Unknown basket "${args.basket}". Use xstocks_list.`);
      const pools = basket.tickers.map(poolByTicker);
      const totalIn = parseUnits(args.amountUsd, USDC_DECIMALS);
      if (totalIn <= 0n) throw new Error('amountUsd must be > 0');
      const slippageBps = args.slippageBps ?? 100;

      // Equal-weight split; dust remainder goes to the first ticker.
      const perTicker = totalIn / BigInt(pools.length);
      if (perTicker <= 0n) {
        throw new Error(`amountUsd too small to split across ${pools.length} tickers`);
      }
      const legs = pools.map((p, i) => ({
        pool: p,
        usdcIn: i === 0 ? perTicker + (totalIn % BigInt(pools.length)) : perTicker,
      }));

      // Single USDC -> USDG swap for the whole basket, then per-ticker USDG -> w* swaps.
      const leg1 = oxSwapQuote(usdc, USDG_ADDRESS, totalIn, wallet, slippageBps);
      const totalUsdg = BigInt(leg1.buyAmount);
      const spender = leg1.allowanceSpender;
      if (!spender) throw new Error('0x quote did not report an allowance spender');

      const txs: Array<{ to: Address; data: Hex; value: string; purpose: string }> = [];
      await approveTxIfNeeded(usdc, wallet, spender, totalIn, txs);
      txs.push({ ...leg1.transaction, purpose: `swap ${args.amountUsd} USDC -> USDG (0x, basket funding)` });

      // Split the quoted USDG across tickers proportionally to their USDC share.
      const breakdown = [];
      let usdgApproved = false;
      for (const leg of legs) {
        const shareUsdg = (totalUsdg * leg.usdcIn) / totalIn;
        const l2 = oxSwapQuote(USDG_ADDRESS, leg.pool.wrapped, shareUsdg, wallet, slippageBps, fee);
        if (!usdgApproved) {
          await approveTxIfNeeded(USDG_ADDRESS, wallet, spender, totalUsdg, txs);
          usdgApproved = true;
        }
        txs.push({
          ...l2.transaction,
          purpose: `swap USDG -> w${leg.pool.ticker}x (0x, Quotrons pool)`,
        });
        breakdown.push({
          ticker: leg.pool.ticker,
          name: leg.pool.name,
          spendUsdc: formatUnits(leg.usdcIn, USDC_DECIMALS),
          expectedWrappedOut: formatUnits(BigInt(l2.buyAmount), WRAPPED_DECIMALS),
          priceImpactBps: l2.estimatedPriceImpact,
          feeTaken: feeTaken(l2, WRAPPED_DECIMALS, `w${leg.pool.ticker}x`),
        });
      }
      return textResult({
        ok: true,
        basket: key,
        description: basket.description,
        totalUsdc: args.amountUsd,
        totalUsdg: formatUnits(totalUsdg, USDG_DECIMALS),
        slippageBps,
        chainId: CHAIN_ID,
        breakdown,
        fee: feeDisclosure(),
        sign_and_broadcast: [
          'Sign each transaction below IN ORDER with her own wallet key.',
          'Send each signed tx to Ink (chain 57073), waiting 1 confirmation between txs.',
          'Leg 1 funds the basket (USDC -> USDG); legs 2..n buy each ticker.',
        ],
        transactions: txs,
      });
    },
  );

  // ---- xstocks_basket_sell -------------------------------------------------
  server.registerTool(
    'xstocks_basket_sell',
    {
      description:
        'Unwind a basket: sells the FULL wTICKER balance of every ticker in the basket ' +
        '(bigtech, yolo, all) back through USDG to USDC. Reads balances onchain, skips ' +
        'zero balances, quotes every leg, returns ordered UNSIGNED transactions. ' +
        'She signs client-side, in order. Requires backupVerified:true.',
      inputSchema: {
      basket: z.string().describe('Basket name: bigtech, yolo, or all. See xstocks_list.'),
      walletAddress: z.string().describe('Her Ink wallet address (0x…). She signs with its key.'),
      backupVerified: z
        .boolean()
        .describe('MUST be true, set only after wallet_verify_backup reported matches:true.'),
      slippageBps: z.number().int().min(10).max(1000).optional()
        .describe('Slippage tolerance in bps, default 100 (1%).'),
      },
    },
    async (args) => {
      if (!args.backupVerified) return backupRitual();
      if (!isAddress(args.walletAddress)) throw new Error('walletAddress is not a valid address');
      const wallet = getAddress(args.walletAddress);
      const key = args.basket.trim().toLowerCase();
      const basket = XSTOCK_BASKETS[key];
      if (!basket) throw new Error(`Unknown basket "${args.basket}". Use xstocks_list.`);
      const slippageBps = args.slippageBps ?? 100;

      const holdings = (
        await Promise.all(
          basket.tickers.map(async (t) => {
            const pool = poolByTicker(t);
            const bal = (await publicClient.readContract({
              address: pool.wrapped, abi: erc20Abi, functionName: 'balanceOf', args: [wallet],
            })) as bigint;
            return { pool, bal };
          }),
        )
      ).filter((h) => h.bal > 0n);
      if (holdings.length === 0) {
        return textResult({ ok: true, basket: key, sold: [], note: 'No basket holdings in this wallet.' });
      }

      const txs: Array<{ to: Address; data: Hex; value: string; purpose: string }> = [];
      const breakdown = [];
      let totalUsdg = 0n;
      let spender: Address | undefined;
      for (const h of holdings) {
        const l1 = oxSwapQuote(h.pool.wrapped, USDG_ADDRESS, h.bal, wallet, slippageBps, fee);
        spender = spender ?? l1.allowanceSpender;
        const usdgOut = BigInt(l1.buyAmount);
        totalUsdg += usdgOut;
        await approveTxIfNeeded(h.pool.wrapped, wallet, spender!, h.bal, txs);
        txs.push({ ...l1.transaction, purpose: `swap w${h.pool.ticker}x -> USDG (0x, Quotrons pool)` });
        breakdown.push({
          ticker: h.pool.ticker,
          soldWrapped: formatUnits(h.bal, WRAPPED_DECIMALS),
          expectedUsdg: formatUnits(usdgOut, USDG_DECIMALS),
          feeTaken: feeTaken(l1, USDG_DECIMALS, 'USDG'),
        });
      }
      if (!spender) throw new Error('0x quote did not report an allowance spender');
      const l2 = oxSwapQuote(USDG_ADDRESS, usdc, totalUsdg, wallet, slippageBps);
      await approveTxIfNeeded(USDG_ADDRESS, wallet, spender, totalUsdg, txs);
      txs.push({ ...l2.transaction, purpose: 'swap USDG -> USDC (0x, basket proceeds)' });
      return textResult({
        ok: true,
        basket: key,
        expectedTotalUsdg: formatUnits(totalUsdg, USDG_DECIMALS),
        expectedTotalUsdc: formatUnits(BigInt(l2.buyAmount), USDC_DECIMALS),
        slippageBps,
        chainId: CHAIN_ID,
        breakdown,
        fee: feeDisclosure(),
        sign_and_broadcast: [
          'Sign each transaction below IN ORDER with her own wallet key.',
          'Send each signed tx to Ink (chain 57073), waiting 1 confirmation between txs.',
        ],
        transactions: txs,
      });
    },
  );
}
