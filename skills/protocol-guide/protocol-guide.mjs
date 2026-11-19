#!/usr/bin/env node
// protocol-guide: reads and prepared steps for Hydrex (Base), Regen (Regen Ledger and axlREGEN on Base), GMX
// (Arbitrum; a person on Base, Ethereum or BNB reaches it through GMX's own GMX Account), Klima (Base) and Uniswap v4
// (Base), for an agent that uses its OWN wallet. Holds no key, signs nothing, sends nothing: every act prints the unsigned
// transaction (or the exact Regen Ledger message) for you to sign yourself, after a simulation, with a guard stated per act.
// Anything it does not know, it refuses (exit 2).
//
//   node protocol-guide.mjs list                              every act, what it needs, what it can cost you
//   node protocol-guide.mjs map                               the five protocols, their tokens, and the roads between them, read live
//   node protocol-guide.mjs recipes [id]                      short complete recipes a bot can run on a timer from these acts (a read, offline)
//   node protocol-guide.mjs verify [hydrex|regen|gmx|klima|uniswap]   live check of every address the guides name (gmx reads Base and Arbitrum)
//   node protocol-guide.mjs hydrex epoch | pools | proposals | locks --address 0x.. | claimable --address 0x..
//   node protocol-guide.mjs hydrex rank [--top N]                  the pools that paid their voters most last epoch, and a vote string
//   node protocol-guide.mjs hydrex prepare claim --from 0x.. [--kind fees|bribes|both] [--include-equity]
//   node protocol-guide.mjs hydrex prepare vote --from 0x.. --vote 0xPOOL:5000 --vote 0xPOOL:5000
//   node protocol-guide.mjs regen balances --address 0x.. [--regen regen1..] | pools | credits [--limit N]
//   node protocol-guide.mjs regen prepare buy-regen --from 0x.. --size 0.001
//   node protocol-guide.mjs regen prepare retire --owner regen1.. --batch C01-... --amount 1 --jurisdiction US-CA --reason "text"
//   node protocol-guide.mjs gmx markets | prices [--market ETH] | positions --address 0x.. | orders --address 0x..
//   node protocol-guide.mjs gmx prepare open --from 0x.. --market ETH --side long --collateral 5 --leverage 2
//   node protocol-guide.mjs gmx prepare close --from 0x.. --market ETH --side long
//   node protocol-guide.mjs klima classes | credits --class 0x.. | quote --class 0x.. --credit 0x.. --tonnes 0.01 | balances --address 0x..
//   node protocol-guide.mjs klima prepare retire --from 0x.. --class 0x.. --credit 0x.. --tonnes 0.01 --beneficiary-name "text"
//   node protocol-guide.mjs klima prepare revoke --from 0x..
//   node protocol-guide.mjs uniswap pools | quote --pool eth-eco --size 0.001
//   node protocol-guide.mjs uniswap prepare swap --from 0x.. --pool eth-eco --size 0.001
//   --json machine-readable output; --rpc <url> (or BASE_RPC_URL, ARBITRUM_RPC_URL); --lcd <url> (or REGEN_LCD_URL)
//
// Exit codes: 0 ok (prepare: a sendable step was printed) | 2 bad arguments or an act this program does not know |
// 3 the RPC or LCD is on the wrong chain | 4 verify: a check failed | 10 the act ran and found nothing to act on now
// (a prepare act with no sendable step, a klima or uniswap quote with no quote, or a hydrex rank with no pool to rank) | 1 a read failed (nothing was decided).
//
// Never an offer or advice, no return promised. The guides next to this file say how each protocol works.

import {
  createPublicClient, http, parseAbi, parseAbiParameters, encodeAbiParameters, encodeFunctionData, decodeErrorResult,
  formatEther, formatUnits, parseUnits, parseEther, getAddress, isAddress, toHex, keccak256, toFunctionSelector,
} from "viem";
import { base, arbitrum } from "viem/chains";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// ---- chains, hosts, caps -----------------------------------------------------------------------------------------
export const CHAIN = { base: 8453, arbitrum: 42161 };
export const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_RPC = { base: "https://mainnet.base.org", arbitrum: "https://arb1.arbitrum.io/rpc" };
const ENV_RPC = { base: "BASE_RPC_URL", arbitrum: "ARBITRUM_RPC_URL" };
export const DEFAULT_LCD = "https://rest.cosmos.directory/regen";
export const HYDREX_API = "https://api.hydrex.fi";
export const GMX_API = "https://arbitrum-api.gmxinfra.io";
/** Refuse an RPC's fee or gas figure above these: a lying or broken node must not price your transaction. */
export const MAX_FEE_PER_GAS_WEI = { base: 10_000_000_000n, arbitrum: 2_000_000_000n };
export const MAX_GAS = { base: 6_000_000n, arbitrum: 12_000_000n };
/** A claim loops over every lock you hold and every reward token, so it is heavy: a claim over many locks can estimate in the millions of gas. */
export const MAX_CLAIM_GAS = 16_000_000n;
export const GAS_LIMIT_NUM = 13n, GAS_LIMIT_DEN = 10n;
export const MAX_DEADLINE_SECONDS = 600;
/** Starter caps, so a mistake costs little. Larger orders are your own tool's job, not this program's. */
export const MAX_BUY_REGEN_WEI = parseEther("0.05");
export const MAX_GMX_COLLATERAL_USDC = 5n * 1_000_000n; // 5 USDC, 6 decimals
export const MAX_GMX_LEVERAGE_TENTHS = 100n; // 10x
export const MAX_SLIPPAGE_BPS = 500;
export const MAX_IMPACT_BPS = 1000;
/** Klima: Klima's smallest retirement is 0.001 tonne. The kVCM cap matters more than the tonne cap, because Klima's classes
 *  are priced very differently per tonne: the most the retire call may spend is capped in kVCM itself. */
export const MIN_KLIMA_TONNES = parseUnits("0.001", 18);
export const MAX_KLIMA_TONNES = parseUnits("0.1", 18);
export const MAX_KLIMA_KVCM_IN = parseUnits("100", 18);
export const MAX_BENEFICIARY_NAME = 64;

// ---- addresses (each one is read live by `verify`) -----------------------------------------------------------------
export const HYDREX = {
  HYDX: "0x00000e7efa313F4E11Bfff432471eD9423AC6B30",
  oHYDX: "0xA1136031150E50B015b41f1ca6B2e99e49D8cB78",
  veHYDX: "0x25B2ED7149fb8A05f6eF9407d9c8F878f59cd1e1",
  Voter: "0xc69E3eF39E3fFBcE2A1c570f8d3ADF76909ef17b",
  Minter: "0xa7d64625f45548a19b2a19e28e7546bb2839003e",
  IncentiveDistributor: "0x8604d646df5A15074876fc2825CfeE306473dD45",
  IchiDepositGuard: "0x9A0EBEc47c85fD30F1fdc90F57d2b178e84DC8d8",
  IchiVaultDeployer: "0x7d11De61c219b70428Bb3199F0DD88bA9E76bfEE",
  SwapRouter: "0x6f4bE24d7dC93b6ffcBAb3Fd0747c5817Cea3F9e",
  PositionManager: "0xC63E9672f8e93234C73cE954a1d1292e4103Ab86",
  Governor: "0x03B1c461527E81A00e08C8b0c78024d2c5dAE95F",
  StrategicProtocolReserve: "0xfD1B334Ca2b68B4EaD59d5A309bAB28f830B216e",
};
export const HYDREX_GOVERNANCE_API = "https://governance.hydrex.fi/api/governor/proposals";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const REGEN = {
  axlREGEN: "0x2E6C05f1f7D1f4Eb9A088bf12257f1647682b754",
  UniversalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  V4Quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
  V4StateView: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
  GasPriceOracle: "0x420000000000000000000000000000000000000F",
};
/** The one pool the buy act uses: native ETH against axlREGEN, 1% fee, tick spacing 200, no hook. */
export const REGEN_POOL = { currency0: ZERO, currency1: REGEN.axlREGEN, fee: 10000, tickSpacing: 200, hooks: ZERO };
export const GMX = {
  ExchangeRouter: "0x7dE39FF2e232A2203196788d37e234cF8F1b83f1",
  Router: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
  OrderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  DataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  RoleStore: "0x3c3d99FD298f679DBC2CEcd132b4eC4d0F5e6e72",
  Reader: "0xfA26cBb46e2614609406de08CA1Dc7f70a684184",
  USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
};
/** GMX's interface repo has listed a newer router than its docs page; verify reports both, the program uses the docs'. */
export const GMX_INTERFACE_ROUTER = "0x6776c2b52179BC737193DE3bc75262681006AA27";
/**
 * GMX's own multichain path, a GMX Account: on Arbitrum the contracts that hold and credit it, and the Stargate pools that move USDC
 * and ETH in. Read on 2026-11-17 from GMX's agent kit address list (github.com/gmx-io/gmx-ai, snapshot of 2026-10-13) and GMX's SDK
 * config (github.com/gmx-io/gmx-interface, sdk/src/configs/multichainTokens.ts). `verify gmx` reads each one. This program prepares
 * nothing with them: funding a GMX Account from Base is GMX's own tooling (see NOT_PREPARED "gmx fund-account").
 */
export const GMX_ACCOUNT = {
  MultichainTransferRouter: "0x3f6772B95423fC03264adf90Efb8A9922B6C8c6e",
  MultichainVault: "0xCeaadFAf6A8C489B250e407987877c5fDfcDBE6E",
  LayerZeroProvider: "0x0B33EBA531e5a5A331a3Ff9F418B8205F01C2869",
  StargateUsdcArbitrum: "0xe8CDF27AcD73a434D661C84887215F7598e7d0d3",
  StargateEthArbitrum: "0xA45B5130f36CDcA45667738e2a258AB09f4A5f7F",
};
/** The two Stargate pools GMX's SDK config lists on Base for the tokens a GMX Account takes from Base (USDC and ETH). */
export const GMX_ACCOUNT_BASE = {
  StargateUsdcBase: "0x27a16dc786820B16E5c9028b75B99F6f604b5d26",
  StargateEthBase: "0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C7",
};
/** Klima (Base). These three are the ones the retire act touches: the token, Klima's retirement aggregator, and its asset manager. */
export const KLIMA = {
  kVCM: "0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d",
  RetirementAggregator: "0xdA0A793D7C32AB80bcdab7F8c725c96DB22464f4",
  AssetManager: "0x1C24239309398220883207681602BfF4D10fbde1",
};
/** Named in Klima's published config (KlimaDAO/protocol-v2-core, protocol-config/8453/protocol-config.toml). `verify klima` reads each. */
export const KLIMA_PUBLISHED = {
  AdminMultisig: "0xD23CCDc650b2a5709e0Eb3C7e68B9C77c20e361b",
  Treasury: "0x75295D12C90d59Bd038D7CB7102c466f8017fa25",
  AccessManager: "0xf158AE8e6DeC82353E52E92Cc90dced63a861Ff1",
  StakingManager: "0x5101a7ca3E8815C0FeeD8976F109EE01D8ED0c3D",
  RewardManager: "0xada87d6f68054d0caB4789b332279b18932e928F",
  CarbonLedger: "0xAD87E90614276430b25801Dfc0C76E01e309d6E1",
  ZkMeVerify: "0x8c81bbc5cC9B6cdbb5c0e5DD8b9D5bfaF3575710",
  KvcmUsdcPool: "0x5C0D76fab1822bDeb47308eD6028231761ED723E",
};
/** A settlement contract with a second retirement entry (retireWithFee) that adds a fee on top of the quote. NOT in Klima's published code, and not used by the retire act. */
export const KLIMA_SETTLEMENT = "0x290e98e95dacE244c73376C0c39A4D53b22E34B6";
/** An outside party's immutable Hydrex conduit (github.com/leo-klima-agents/hydrex-conduit, version 2). Read by `verify klima`, never called. */
export const HYDREX_CONDUIT_V2 = "0x692c323B425A9DfeebE302F56168a7798D93EAC5";
export const KLIMA_CREDITS_URL = "https://raw.githubusercontent.com/KlimaDAO/protocol-v2-core/main/protocol-config/8453/credits.json";

/** Tokens the Uniswap and map sections use (HYDX is in HYDREX, axlREGEN in REGEN, kVCM in KLIMA, USDC in BASE_USDC). */
export const TOKENS = {
  WETH: "0x4200000000000000000000000000000000000006",
  ECO: "0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519",
  NET: "0xE37A9125B6b14D5e8Ec056C744a99F4deC975022",
  HYDROC: "0xBc594f11770798d7bEF748f5A00ABc44F86F5cEf",
};
/** The standing lines. Wherever this program first points you at one of these tokens, in its human text and in its --json, the line sits beside it. */
export const NET_DISCLOSURE = "the buying in NET's pools is the house's own";
export const ECO_DISCLOSURE = "EcoWealth created ECO, holds it and gains if it rises";
export const KVCM_DISCLOSURE = "EcoWealth holds some kVCM and gains if it rises";
export const HYDROC_DISCLOSURE = "EcoWealth launched HYDROC on Hydrex's launcher, holds some and gains if it rises";
/** The standing lines for a pair such as "NET/ECO" or "kVCM/USDC", in one string, or null when the pair names none of these tokens. Pure. */
export function pairDisclosure(pair) {
  const names = String(pair).split("/");
  const lines = [];
  if (names.includes("NET")) lines.push(NET_DISCLOSURE);
  if (names.includes("ECO")) lines.push(ECO_DISCLOSURE);
  if (names.includes("kVCM")) lines.push(KVCM_DISCLOSURE);
  if (names.includes("HYDROC")) lines.push(HYDROC_DISCLOSURE);
  return lines.length ? lines.join("; ") : null;
}
export const UNISWAP = {
  PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
  PositionManager: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
  UniversalRouter: REGEN.UniversalRouter,
  V4Quoter: REGEN.V4Quoter,
  V4StateView: REGEN.V4StateView,
};
const asAddress = (a) => getAddress(a.toLowerCase());
/** Pools outside Uniswap that the map reads (Base). Each one is read live and its two tokens are checked against these. */
export const OTHER_POOLS = [
  { id: "hydx-hydroc", pair: "HYDX/HYDROC", venue: "Hydrex (Algebra)", kind: "algebra", address: asAddress("0xe7e3893e1A6d1A72DEa190f06d93B94Df839400f"), token0: HYDREX.HYDX, token1: TOKENS.HYDROC },
  { id: "hydrex-kvcm-usdc", pair: "kVCM/USDC", venue: "Hydrex (Algebra)", kind: "algebra", address: asAddress("0xef96ec76eeb36584fc4922e9fa268e0780170f33"), token0: KLIMA.kVCM, token1: BASE_USDC },
  { id: "aero-kvcm-usdc", pair: "kVCM/USDC", venue: "Aerodrome (V2 style)", kind: "v2", address: KLIMA_PUBLISHED.KvcmUsdcPool, token0: KLIMA.kVCM, token1: BASE_USDC },
  { id: "aero-axlregen-usdc", pair: "axlREGEN/USDC", venue: "Aerodrome (V2 style)", kind: "v2", address: asAddress("0xe7b7156e1fa9b633d12e1b91e40e4abc6786a248"), token0: REGEN.axlREGEN, token1: BASE_USDC },
  { id: "v2-axlregen-weth", pair: "axlREGEN/WETH", venue: "a V2 style pool", kind: "v2", address: asAddress("0x4f0a58b2f561cd23e3059e76526125c85e281821"), token0: REGEN.axlREGEN, token1: TOKENS.WETH },
];
export const ALL_ADDRESSES = {
  hydrex: HYDREX,
  regen: { ...REGEN, BaseUSDC: BASE_USDC },
  gmx: { ...GMX, InterfaceRouter: GMX_INTERFACE_ROUTER },
  gmxAccount: { ...GMX_ACCOUNT, ...GMX_ACCOUNT_BASE },
  klima: { ...KLIMA, ...KLIMA_PUBLISHED, Settlement: KLIMA_SETTLEMENT, HydrexConduitV2: HYDREX_CONDUIT_V2 },
  uniswap: { ...UNISWAP, ...TOKENS },
  pools: Object.fromEntries(OTHER_POOLS.map((p) => [p.id, p.address])),
};
export const KNOWN_ADDRESSES = new Set(Object.values(ALL_ADDRESSES).flatMap((o) => Object.values(o)).map((a) => a.toLowerCase()));

// ---- text safety: anything from an API, a chain or a user is cleaned before it is printed ---------------------------
export function clean(text, max = 160) {
  return String(text ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const bigJson = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

// ---- the act registry: `list` prints it, the tests pin it ------------------------------------------------------------
export const ACTS = [
  { protocol: "hydrex", act: "epoch", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "hydrex", act: "pools", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "hydrex", act: "proposals", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "hydrex", act: "rank", kind: "read", needs: "nothing (optional --top N, 1 to 10)", loss: "none" },
  { protocol: "hydrex", act: "locks", kind: "read", needs: "--address", loss: "none" },
  { protocol: "hydrex", act: "claimable", kind: "read", needs: "--address", loss: "none" },
  { protocol: "hydrex", act: "prepare claim", kind: "prepare", needs: "--from (owns a veHYDX lock)", loss: "gas only; the transaction calls the Voter and sends nothing out of your wallet" },
  { protocol: "hydrex", act: "prepare vote", kind: "prepare", needs: "--from, --vote POOL:BPS", loss: "gas only; it replaces your previous vote" },
  { protocol: "regen", act: "balances", kind: "read", needs: "--address and/or --regen", loss: "none" },
  { protocol: "regen", act: "pools", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "regen", act: "credits", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "regen", act: "prepare buy-regen", kind: "prepare", needs: "--from, --size ETH (at most 0.05)", loss: "gas if it reverts; if it lands, the ETH you state is swapped for axlREGEN and at least the printed minimum arrives or the whole transaction reverts" },
  { protocol: "regen", act: "prepare retire", kind: "prepare", needs: "--owner, --batch, --amount, --jurisdiction, --reason", loss: "the credits you name are retired for good, by design; gas is paid in REGEN" },
  { protocol: "gmx", act: "markets", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "gmx", act: "prices", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "gmx", act: "positions", kind: "read", needs: "--address", loss: "none" },
  { protocol: "gmx", act: "orders", kind: "read", needs: "--address", loss: "none" },
  { protocol: "gmx", act: "prepare open", kind: "prepare", needs: "--from, --market, --side, --collateral (at most 5 USDC), --leverage (1 to 10)", loss: "up to the collateral you state, plus fees and the execution fee you send (the unused part is refunded), plus gas; a liquidation can take all the collateral" },
  { protocol: "gmx", act: "prepare close", kind: "prepare", needs: "--from, --market, --side", loss: "the execution fee you send (the unused part is refunded) plus gas; what comes back to you is reduced by GMX's position fee, any price impact on the close, and the borrowing and funding fees that built up while the position was open; it ends your exposure in that position" },
  { protocol: "klima", act: "classes", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "klima", act: "credits", kind: "read", needs: "--class", loss: "none" },
  { protocol: "klima", act: "quote", kind: "read", needs: "--class, --credit, --tonnes (optional --token-id)", loss: "none" },
  { protocol: "klima", act: "balances", kind: "read", needs: "--address", loss: "none" },
  { protocol: "klima", act: "prepare retire", kind: "prepare", needs: "--from, --class, --credit, --tonnes (0.001 to 0.1), --beneficiary-name (optional --token-id, --slippage-bps)", loss: "the kVCM it spends, up to the printed maximum (at most 100 kVCM), is gone and the carbon is retired for good, by design; gas if it reverts; the unspent part of the approval stays on Klima's asset manager until you revoke it" },
  { protocol: "klima", act: "prepare revoke", kind: "prepare", needs: "--from", loss: "gas only; it sets your kVCM approval to Klima's asset manager back to zero" },
  { protocol: "uniswap", act: "pools", kind: "read", needs: "nothing", loss: "none" },
  { protocol: "uniswap", act: "quote", kind: "read", needs: "--pool, --size ETH", loss: "none" },
  { protocol: "uniswap", act: "prepare swap", kind: "prepare", needs: "--from, --pool eth-axlregen|eth-eco, --size ETH (at most 0.05)", loss: "gas if it reverts; if it lands, the ETH you state is swapped for the pool's token and at least the printed minimum arrives or the whole transaction reverts" },
];
export const NOT_PREPARED = {
  "hydrex swap": "not prepared here: Hydrex's router has no calldata we have seen run onchain. The Hydrex guide gives the router's call shape; build it yourself and simulate it.",
  "hydrex lock": "not prepared here: lock types are not published in the contract's own interface. The Hydrex guide says how to test one with the smallest amount.",
  "hydrex liquidity": "not prepared here: see the Hydrex guide for the deposit guard's call shapes.",
  "regen bridge": "not prepared here: bridging REGEN needs the full corridor checks. Use the prepare_bridge tool at vealth.net/mcp, or the route in the Regen guide.",
  "regen buy-credits": "not prepared here: the marketplace buy message carries a buyer fee cap this program cannot read. The Regen guide gives the message fields.",
  "gmx deposit": "not prepared here: GM and GLV deposits have no calldata we have seen run onchain. The GMX guide points at GMX's own pages.",
  "gmx claim": "not prepared here: see the GMX guide for the claim calls.",
  "gmx fund-account": "not prepared here: funding a GMX Account from Base goes through Stargate (it moves the USDC or ETH) and LayerZero (the message that credits your account on Arbitrum). A simulation on Base can prove only the Base half, and this program does not hand you a transaction it cannot prove end to end. GMX's own kit prepares it: github.com/gmx-io/gmx-ai (MIT). The GMX guide says what a GMX Account is, what it costs and what can go wrong. This program's gmx prepare acts spend USDC in your own Arbitrum wallet, not a GMX Account balance.",
  "gmx express": "not prepared here: Express orders are typed data you sign and GMX's relay broadcasts, and a GMX Account is traded only this way. This program prepares Classic orders, sent by your own wallet. GMX's own kit prepares Express orders: github.com/gmx-io/gmx-ai (MIT).",
  "klima stake": "not prepared here: staking kVCM, K2 or LP tokens on Klima needs an identity check (zkMe) in Klima's published code. The Klima guide says where; this program does not prepare it.",
  "klima lock": "not prepared here: kVCM locks have no calldata we have seen run onchain. The Klima guide names the contract; build and simulate it yourself.",
  "klima swap-in": "not prepared here: swapping carbon credits in for kVCM changes the supply and needs the credit and the class checked by you. The Klima guide gives the entry point.",
  "hydrex conduit": "not prepared here: delegating a veHYDX lock to a conduit is one call on the veHYDX contract and hands your votes to it. The Klima guide describes the one outside conduit we read; read its code first.",
  "uniswap liquidity": "not prepared here: adding or removing v4 liquidity goes through the PositionManager with its own action encoding. The Uniswap guide points at the contracts.",
};

// ---- clients, chain checks, simulation --------------------------------------------------------------------------------
export class ArgError extends Error {}
export class ChainError extends Error {}
export function makeClient(chainKey, rpcUrl) {
  if (!CHAIN[chainKey]) throw new ArgError(`unknown chain ${clean(chainKey)}`);
  const chain = chainKey === "arbitrum" ? arbitrum : base;
  return createPublicClient({ chain, transport: http(rpcUrl || process.env[ENV_RPC[chainKey]] || DEFAULT_RPC[chainKey], { retryCount: 2 }) });
}
export async function assertChain(client, chainKey) {
  const id = await client.getChainId();
  if (id !== CHAIN[chainKey]) throw new ChainError(`the RPC is on chain ${id}, not ${chainKey} (${CHAIN[chainKey]})`);
}

const ERRORS = parseAbi([
  "error InsufficientETH()", "error InsufficientToken()", "error TransactionDeadlinePassed()",
  "error ExecutionFailed(uint256 commandIndex, bytes message)", "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error InsufficientExecutionFee(uint256 minExecutionFee, uint256 executionFee)",
  // Klima's retirement aggregator and asset manager (names from Klima's usage note and published code), and the token's own errors
  "error InvalidAmout()", "error TokenNotSupported()", "error InvalidAmountReceived()", "error SlippageExceeded(uint256 required, uint256 maxAllowed)",
  "error InvalidBeneficiaryLocation()", "error InvalidCountryCode()", "error InvalidPeriodStart()", "error InvalidPeriodEnd()",
  "error SystemPaused()", "error NotAuthorized()", "error NoQuoterForClass(address carbonClass)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)", "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

/**
 * eth_call the transaction as `from` at the pending block (with enough ETH granted for gas and value): null when it
 * succeeds, a named reason when the transaction itself reverts. A failed request (rate limit, timeout) throws instead:
 * it says nothing about the act and must never read as "the act fails".
 */
export async function simulate(client, tx, from, { ethBump = parseEther("1"), gasPrice } = {}) {
  try {
    // GMX validates the execution fee against tx.gasprice, which is 0 in a call that names no gas price: pass one.
    await client.call({ account: getAddress(from), to: tx.to, data: tx.data, value: tx.value, blockTag: "pending", ...(gasPrice ? { gasPrice } : {}), stateOverride: [{ address: getAddress(from), balance: tx.value + ethBump }] });
    return null;
  } catch (e) {
    let raw = null, reverted = false;
    for (let x = e; x; x = x.cause) {
      if (!raw && typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) raw = x.data;
      if (x.name === "ExecutionRevertedError" || x.name === "RawContractError") reverted = true;
    }
    if (raw) {
      try { const d = decodeErrorResult({ abi: ERRORS, data: raw }); return d.errorName + (d.args?.length ? `(${d.args.map((a) => clean(a)).join(", ")})` : ""); } catch { return `revert ${clean(raw.slice(0, 10))}`; }
    }
    if (reverted) return `reverted: ${clean(e?.shortMessage || e?.message || e)}`;
    throw e;
  }
}

/** Price a transaction the way a wallet would, from the node, with caps; the result is what gets printed. */
export async function finalizeTx(client, chainKey, { to, data, value = 0n }, from, { maxGas = MAX_GAS[chainKey] } = {}) {
  const gas = await client.estimateGas({ account: getAddress(from), to, data, value, blockTag: "pending", stateOverride: [{ address: getAddress(from), balance: value + parseEther("1") }] });
  const fees = await client.estimateFeesPerGas();
  if (fees.maxFeePerGas > MAX_FEE_PER_GAS_WEI[chainKey] || fees.maxPriorityFeePerGas > MAX_FEE_PER_GAS_WEI[chainKey]) throw new Error(`the RPC reports a fee above ${MAX_FEE_PER_GAS_WEI[chainKey]} wei per gas; refusing to price a transaction with it`);
  if (gas > maxGas) throw new Error(`the RPC estimates ${gas} gas, above ${maxGas}; refusing`);
  const gasLimit = (gas * GAS_LIMIT_NUM) / GAS_LIMIT_DEN;
  const out = { to, data, value: toHex(value), valueWei: value, chainId: CHAIN[chainKey], gas: toHex(gasLimit), maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas), gasEstimate: gas, maxL2GasCostWei: gasLimit * fees.maxFeePerGas, l1FeeBoundWei: null };
  if (chainKey === "base") {
    try { out.l1FeeBoundWei = await client.readContract({ address: REGEN.GasPriceOracle, abi: parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]), functionName: "getL1FeeUpperBound", args: [BigInt((data.length - 2) / 2 + 120)] }); } catch { out.l1FeeBoundWei = null; }
  }
  return out;
}

/** Batched reads: failures stay visible as { status: "failure" } so the caller decides; none is ever read as zero. */
export async function multi(client, calls, size = 100) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) out.push(...(await client.multicall({ contracts: calls.slice(i, i + size), allowFailure: true })));
  return out;
}
const must = (r, label) => { if (r.status !== "success") throw new Error(`read failed (${label}): ${clean(r.error?.shortMessage || r.error?.message || r.error)}`); return r.result; };

async function getJson(url, { fetcher = globalThis.fetch, maxBytes = 8_000_000 } = {}) {
  const res = await fetcher(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${clean(url, 80)} answered http ${res.status}`);
  const text = await res.text();
  if (text.length > maxBytes) throw new Error(`${clean(url, 80)} answered more than ${maxBytes} bytes; refusing`);
  return JSON.parse(text);
}

// =====================================================================================================================
// HYDREX (Base)
// =====================================================================================================================
export const VOTER_ABI = parseAbi([
  "function claimFees(address[] _fees, address[][] _tokens)",
  "function claimBribes(address[] _bribes, address[][] _tokens)",
  "function vote(address[] _poolVote, uint256[] _voteProportions)",
  "function poolVoteLength(address voter) view returns (uint256)",
  "function poolVote(address, uint256) view returns (address)",
  "function votes(address, address) view returns (uint256)",
  "function lastVoted(address) view returns (uint256)",
  "function gauges(address) view returns (address)",
  "function isAlive(address) view returns (bool)",
  "function internal_bribes(address) view returns (address)",
  "function external_bribes(address) view returns (address)",
]);
const VE_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function lockDetails(uint256 _tokenId) view returns ((uint256 amount, uint256 startTime, uint256 endTime, uint8 lockType))",
  "function balanceOfNFT(uint256 _tokenId) view returns (uint256)",
]);
const MINTER_ABI = parseAbi(["function weekly() view returns (uint256)", "function active_period() view returns (uint256)"]);
const REWARD_ABI = parseAbi(["function rewardsListLength() view returns (uint256)", "function rewardTokens(uint256) view returns (address)", "function earned(uint256, address) view returns (uint256)"]);
const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)", "function approve(address spender, uint256 amount) returns (bool)"]);
export const EPOCH_SECONDS = 604800n;
const MAX_NFTS = 25, MAX_VOTED_POOLS = 30, MAX_REWARD_TOKENS = 200, MAX_VOTE_POOLS = 10;
/** Stock and ETF wrapper symbols (wtNKE, wtQQQM, GOOGLc ...): left out of claims and votes unless you pass --include-equity. */
export const EQUITY_SYMBOL = /^wt[A-Z][A-Z0-9]{1,6}$|^[A-Z]{2,6}c$/;

export async function readEpoch(client) {
  const [period, weekly] = await multi(client, [
    { address: HYDREX.Minter, abi: MINTER_ABI, functionName: "active_period" },
    { address: HYDREX.Minter, abi: MINTER_ABI, functionName: "weekly" },
  ]);
  const start = must(period, "Minter.active_period"), emission = must(weekly, "Minter.weekly");
  const block = await client.getBlock({ blockTag: "latest" });
  const flip = start + EPOCH_SECONDS;
  return { epochStart: start, nextFlip: flip, now: block.timestamp, secondsToFlip: flip > block.timestamp ? flip - block.timestamp : 0n, weeklyOhydxUnits: emission, weeklyOhydx: formatUnits(emission, 18) };
}

/** The Hydrex pool list, trimmed to safe fields. Text from the API is untrusted and cleaned. */
export function trimPools(list, { limit = 15, includeEquity = false } = {}) {
  if (!Array.isArray(list)) throw new Error("the Hydrex pool list is not an array; refusing");
  return list
    .filter((s) => s && isAddress(String(s.address)) && s.chainId === 8453)
    .filter((s) => includeEquity || !s.isEquity)
    .map((s) => ({ pool: getAddress(s.address), title: clean(s.title, 48), type: clean(s.type, 24), tvlUsd: Number.isFinite(Number(s.tvlUsd)) ? Number(s.tvlUsd) : 0, gaugeAlive: Boolean(s.gauge?.isAlive), isEquity: Boolean(s.isEquity) }))
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, limit);
}

/** Hydrex governance proposals, trimmed to safe fields. Titles come from proposers: untrusted, cleaned. */
export function trimProposals(body, { limit = 10 } = {}) {
  const list = Array.isArray(body) ? body : body?.proposals;
  if (!Array.isArray(list)) throw new Error("the Hydrex proposal answer has no proposals list; refusing");
  return list.slice(0, limit).map((p) => ({ id: clean(p?.id, 80), title: clean(p?.title, 100), state: clean(p?.state, 24), forVotes: clean(p?.forVotes, 40), againstVotes: clean(p?.againstVotes, 40), quorumVotes: clean(p?.quorumVotes, 40), voteEnd: clean(p?.voteEnd, 40) }));
}

export async function readLocks(client, address) {
  const owner = getAddress(address);
  const [bal, nVote, last] = await multi(client, [
    { address: HYDREX.veHYDX, abi: VE_ABI, functionName: "balanceOf", args: [owner] },
    { address: HYDREX.Voter, abi: VOTER_ABI, functionName: "poolVoteLength", args: [owner] },
    { address: HYDREX.Voter, abi: VOTER_ABI, functionName: "lastVoted", args: [owner] },
  ]);
  const nNft = Number(must(bal, "veHYDX.balanceOf")), nPools = Number(must(nVote, "Voter.poolVoteLength"));
  if (nNft > MAX_NFTS) throw new Error(`${owner} holds ${nNft} locks; this program reads at most ${MAX_NFTS}`);
  if (nPools > MAX_VOTED_POOLS) throw new Error(`${owner} votes in ${nPools} pools; this program reads at most ${MAX_VOTED_POOLS}`);
  const ids = (await multi(client, Array.from({ length: nNft }, (_, i) => ({ address: HYDREX.veHYDX, abi: VE_ABI, functionName: "tokenOfOwnerByIndex", args: [owner, BigInt(i)] })))).map((r) => must(r, "veHYDX.tokenOfOwnerByIndex"));
  const detail = await multi(client, ids.flatMap((id) => [
    { address: HYDREX.veHYDX, abi: VE_ABI, functionName: "lockDetails", args: [id] },
    { address: HYDREX.veHYDX, abi: VE_ABI, functionName: "balanceOfNFT", args: [id] },
  ]));
  const nfts = ids.map((tokenId, i) => { const d = must(detail[2 * i], "veHYDX.lockDetails"); return { tokenId, lockedAmountUnits: d.amount, startTime: d.startTime, endTime: d.endTime, lockType: d.lockType, votingPowerUnits: must(detail[2 * i + 1], "veHYDX.balanceOfNFT") }; });
  const pools = (await multi(client, Array.from({ length: nPools }, (_, i) => ({ address: HYDREX.Voter, abi: VOTER_ABI, functionName: "poolVote", args: [owner, BigInt(i)] })))).map((r) => must(r, "Voter.poolVote"));
  const weights = (await multi(client, pools.map((p) => ({ address: HYDREX.Voter, abi: VOTER_ABI, functionName: "votes", args: [owner, p] })))).map((r) => must(r, "Voter.votes"));
  return { address: owner, nfts, lastVoted: must(last, "Voter.lastVoted"), votes: pools.map((pool, i) => ({ pool, weightUnits: weights[i] })) };
}

/**
 * What a voter can claim now, read from the chain: for each pool the address currently votes in, the gauge, its fee
 * and bribe contracts (read from the Voter itself, never from an API), their reward tokens and `earned` per lock.
 * A read that fails marks that contract `readError`: it is never counted as zero.
 */
export async function readClaimable(client, address, { extraPools = [] } = {}) {
  const locks = await readLocks(client, address);
  const pools = [...new Set([...locks.votes.map((v) => v.pool), ...extraPools.map(getAddress)])];
  const gauges = (await multi(client, pools.map((p) => ({ address: HYDREX.Voter, abi: VOTER_ABI, functionName: "gauges", args: [p] })))).map((r) => must(r, "Voter.gauges"));
  const live = pools.map((pool, i) => ({ pool, gauge: gauges[i] })).filter((x) => x.gauge !== ZERO);
  const bribeReads = await multi(client, live.flatMap((x) => [
    { address: HYDREX.Voter, abi: VOTER_ABI, functionName: "internal_bribes", args: [x.gauge] },
    { address: HYDREX.Voter, abi: VOTER_ABI, functionName: "external_bribes", args: [x.gauge] },
  ]));
  const contracts = [];
  live.forEach((x, i) => {
    const fee = must(bribeReads[2 * i], "Voter.internal_bribes"), bribe = must(bribeReads[2 * i + 1], "Voter.external_bribes");
    if (fee !== ZERO) contracts.push({ kind: "fees", pool: x.pool, contract: fee, tokens: [] });
    if (bribe !== ZERO) contracts.push({ kind: "bribes", pool: x.pool, contract: bribe, tokens: [] });
  });
  const lens = await multi(client, contracts.map((c) => ({ address: c.contract, abi: REWARD_ABI, functionName: "rewardsListLength" })));
  const listed = [];
  contracts.forEach((c, i) => {
    if (lens[i].status !== "success") { c.readError = "rewardsListLength failed"; return; }
    const n = Number(lens[i].result);
    if (n > MAX_REWARD_TOKENS) { c.readError = `reward list of ${n} is not a real list`; return; }
    for (let k = 0; k < n; k++) listed.push({ c, k });
  });
  const toks = await multi(client, listed.map(({ c, k }) => ({ address: c.contract, abi: REWARD_ABI, functionName: "rewardTokens", args: [BigInt(k)] })));
  listed.forEach(({ c }, j) => { if (toks[j].status === "success") c.tokens.push({ address: toks[j].result, symbol: "?", decimals: 18, earnedUnits: 0n }); else c.readError = "rewardTokens failed"; });
  const allTokens = [...new Set(contracts.flatMap((c) => c.tokens.map((t) => t.address)))];
  const meta = await multi(client, allTokens.flatMap((t) => [{ address: t, abi: ERC20_ABI, functionName: "symbol" }, { address: t, abi: ERC20_ABI, functionName: "decimals" }]));
  const metaOf = new Map(allTokens.map((t, i) => [t, { symbol: meta[2 * i].status === "success" ? clean(meta[2 * i].result, 16) : "?", decimals: meta[2 * i + 1].status === "success" ? Number(meta[2 * i + 1].result) : 18 }]));
  const ids = locks.nfts.map((n) => n.tokenId);
  const earnCalls = [];
  for (const c of contracts) for (const t of c.tokens) for (const id of ids) earnCalls.push({ c, t, id });
  const earned = await multi(client, earnCalls.map(({ c, t, id }) => ({ address: c.contract, abi: REWARD_ABI, functionName: "earned", args: [id, t.address] })));
  earnCalls.forEach(({ c, t }, j) => { if (earned[j].status === "success") t.earnedUnits += earned[j].result; else c.readError = "earned failed"; });
  for (const c of contracts) for (const t of c.tokens) Object.assign(t, metaOf.get(t.address), {});
  return { address: locks.address, tokenIds: ids, pools: live, contracts };
}

/** One claim per reward contract, tokens with nothing earned dropped, tokenized equity dropped unless allowed. Pure. */
export function planClaims(claimable, { kind = "both", includeEquity = false } = {}) {
  const txs = [], skipped = [], failures = [];
  for (const c of claimable.contracts) {
    if (kind !== "both" && c.kind !== kind) continue;
    if (c.readError) { failures.push(`${c.kind} ${c.contract}: ${c.readError}`); continue; }
    const keep = [];
    for (const t of c.tokens) {
      if (!(t.earnedUnits > 0n)) continue;
      if (!includeEquity && EQUITY_SYMBOL.test(t.symbol)) { skipped.push(`${c.kind} ${c.contract}: ${t.symbol} (tokenized equity, pass --include-equity to take it)`); continue; }
      keep.push(t);
    }
    if (!keep.length) continue;
    txs.push({ kind: c.kind, pool: c.pool, contract: c.contract, tokens: keep, to: HYDREX.Voter, data: encodeFunctionData({ abi: VOTER_ABI, functionName: c.kind === "fees" ? "claimFees" : "claimBribes", args: [[c.contract], [keep.map((t) => t.address)]] }) });
  }
  return { txs, skipped, failures };
}

export async function prepareClaim(client, { from, kind = "both", includeEquity = false }) {
  const claimable = await readClaimable(client, from);
  if (!claimable.tokenIds.length) return { sendable: false, reason: "this address holds no veHYDX lock, so it has nothing to claim", steps: [] };
  const plan = planClaims(claimable, { kind, includeEquity });
  const steps = [];
  for (const t of plan.txs) {
    const failed = await simulate(client, { to: t.to, data: t.data, value: 0n }, from);
    if (failed) { plan.failures.push(`${t.kind} ${t.contract}: the claim reverts in simulation (${failed})`); continue; }
    steps.push({ kind: t.kind, pool: t.pool, rewardContract: t.contract, tokens: t.tokens.map((x) => ({ token: x.address, symbol: x.symbol, earned: formatUnits(x.earnedUnits, x.decimals) })), tx: await finalizeTx(client, "base", { to: t.to, data: t.data }, from, { maxGas: MAX_CLAIM_GAS }) });
  }
  return { sendable: steps.length > 0, reason: steps.length ? null : (plan.failures[0] || "nothing is earned yet in the pools you vote in"), skipped: plan.skipped, failures: plan.failures, steps };
}

/** "0xPOOL:5000" pairs to the vote call's two arrays; proportions are basis points that must sum to exactly 10000. */
export function parseVotes(items) {
  if (!items.length) throw new ArgError("--vote POOL:BPS is needed, e.g. --vote 0xPOOL:10000");
  if (items.length > MAX_VOTE_POOLS) throw new ArgError(`at most ${MAX_VOTE_POOLS} pools in one vote`);
  const pools = [], bps = [];
  for (const item of items) {
    const m = /^(0x[0-9a-fA-F]{40}):(\d{1,5})$/.exec(String(item));
    if (!m || !isAddress(m[1])) throw new ArgError(`--vote ${clean(item, 60)} is not POOL:BPS`);
    const p = getAddress(m[1]), b = Number(m[2]);
    if (!(b > 0)) throw new ArgError("each vote proportion must be above 0");
    if (pools.includes(p)) throw new ArgError(`pool ${p} appears twice`);
    pools.push(p); bps.push(b);
  }
  if (bps.reduce((s, b) => s + b, 0) !== 10000) throw new ArgError("the proportions must sum to exactly 10000 (basis points)");
  return { pools, bps };
}

export async function prepareVote(client, { from, votes, apiPools, includeEquity = false }) {
  const { pools, bps } = parseVotes(votes);
  if (!includeEquity) {
    if (!Array.isArray(apiPools)) throw new Error("could not read Hydrex's pool list to screen for tokenized equity; not preparing a vote (pass --include-equity to skip the screen)");
    const equity = new Set(apiPools.filter((s) => s?.isEquity && isAddress(String(s.address))).map((s) => getAddress(s.address)));
    const hit = pools.find((p) => equity.has(p));
    if (hit) throw new ArgError(`pool ${hit} is flagged as tokenized equity by Hydrex; pass --include-equity if you mean it`);
  }
  const owner = getAddress(from);
  const reads = await multi(client, [
    { address: HYDREX.veHYDX, abi: VE_ABI, functionName: "balanceOf", args: [owner] },
    ...pools.flatMap((p) => [{ address: HYDREX.Voter, abi: VOTER_ABI, functionName: "gauges", args: [p] }]),
  ]);
  if (!(must(reads[0], "veHYDX.balanceOf") > 0n)) return { sendable: false, reason: "this address holds no veHYDX lock, so it has no votes to cast" };
  const gauges = reads.slice(1).map((r) => must(r, "Voter.gauges"));
  const noGauge = pools.find((_, i) => gauges[i] === ZERO);
  if (noGauge) return { sendable: false, reason: `pool ${noGauge} has no gauge on the Voter` };
  const alive = await multi(client, gauges.map((g) => ({ address: HYDREX.Voter, abi: VOTER_ABI, functionName: "isAlive", args: [g] })));
  const dead = pools.find((_, i) => must(alive[i], "Voter.isAlive") !== true);
  if (dead) return { sendable: false, reason: `the gauge for pool ${dead} is not alive` };
  const tx = { to: HYDREX.Voter, data: encodeFunctionData({ abi: VOTER_ABI, functionName: "vote", args: [pools, bps.map(BigInt)] }), value: 0n };
  const failed = await simulate(client, tx, from);
  if (failed) return { sendable: false, reason: `the vote reverts in simulation (${failed})` };
  return { sendable: true, reason: null, pools, bps, replacesPreviousVote: true, tx: await finalizeTx(client, "base", tx, from) };
}

// =====================================================================================================================
// HYDREX RANK: which pools paid their voters most in the last completed epoch, read from the reward contracts
// =====================================================================================================================
// The rule: for the last COMPLETED epoch, (fees + bribes paid to the pool's voters, in USD) divided by the pool's final votes in
// that epoch, per 1,000 votes. Pay is read from each gauge's fee and bribe contract (rewardData(token, epochStart) and
// totalSupplyAt(epochStart)) and from the Voter (weightsAt), never from Hydrex's API epoch totals: a check against the contracts
// found that the API's epoch bribe totals missed most of the USDC bribes (about 97% in one epoch we read), so a ranking built on
// them is a wrong list. The API is used here only to list the pools.

/** A pool counts as paying only above this many USD in an epoch, so a dust pool with a handful of votes stays off the top. */
export const RANK_MIN_PAID_USD = 100;
/** A market-wide median pay per 1,000 votes outside this band is flagged as a broken reading, never trusted. */
export const RANK_SANE_MIN_USD_PER_1K = 0.05;
export const RANK_SANE_MAX_USD_PER_1K = 5;
const MAX_RANK_POOLS = 1000;
/** USD stablecoins priced at face value, matched by ADDRESS and never by symbol, so a look-alike "USDC" cannot pass as cash. */
export const USD_STABLES = new Set([
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
  "0xe5020a6d073a794b6e7f05678707de47986fb0b6", // frxUSD
  "0x6bb7a212910682dcfdbd5bcbb3e28fb4e8da10ee", // GHO
]);
/** Tokens that are never read as tokenized equity by their symbol (by address): ETH and its staked forms, cbBTC, EURC, AUDF, kVCM. */
export const KNOWN_NON_EQUITY = new Set([
  "0x4200000000000000000000000000000000000006", // WETH
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", // cbETH
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", // wstETH
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", // cbBTC
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42", // EURC
  "0xd2a530170d71a9cfe1651fb468e2b98f7ed7456b", // AUDF
  "0x00fbac94fec8d4089d3fe979f39454f48c71a65d", // kVCM
]);
export const RANK_METHOD = "Pools are ranked by what they actually paid their voters in the last completed epoch: fees plus bribes, in USD, divided by the pool's final votes in that epoch, read from the pool's own fee and bribe contracts; only USD stablecoins are priced, and a pool must have paid more than 100 USD to be ranked.";
export const RANK_SPLIT = "The vote is shared equally between the pools listed, in basis points that sum to exactly 10000; when 10000 does not divide evenly, the first pools in the list take one extra basis point each.";
export const RANK_RESERVE_NOTE = "As of 2026-11-18 the Hydrex community, in a thread in Hydrex's Discord, reads about six weeks of runway in the reserve that funds most voter rewards. That is their reading, not this program's: check it yourself.";

const VOTER_HISTORY_ABI = parseAbi(["function weightsAt(address _pool, uint256 _time) view returns (uint256)"]);
const PAID_ABI = parseAbi([
  "function totalSupplyAt(uint256 _time) view returns (uint256)",
  "function rewardData(address token, uint256 epochStart) view returns (uint256 periodFinish, uint256 rewardsPerEpoch, uint256 lastUpdateTime)",
]);

/** Median pay per 1,000 votes over the pools that paid more than the floor, or null with fewer than three such pools. Pure. */
export function clearingRateFromSamples(samples) {
  const rates = samples
    .filter((x) => x.usd > RANK_MIN_PAID_USD && x.supply > 0)
    .map((x) => (x.usd / x.supply) * 1000)
    .sort((a, b) => a - b);
  if (rates.length < 3) return null;
  return rates[Math.floor((rates.length - 1) / 2)];
}
/** A market median inside the sane band, or null. Pure. */
export function boundClearingRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return null;
  return rate >= RANK_SANE_MIN_USD_PER_1K && rate <= RANK_SANE_MAX_USD_PER_1K ? rate : null;
}
/** True when a token is a tokenized equity by its symbol. Known cash and blue chips, by address, are never flagged. Pure. */
export function isEquityToken(symbol, address) {
  const a = address?.toLowerCase();
  if (a && (USD_STABLES.has(a) || KNOWN_NON_EQUITY.has(a))) return false;
  return EQUITY_SYMBOL.test(symbol ?? "");
}
/** Why a pool counts as tokenized equity, or null: Hydrex's own flag, a stock wrapper in the pool's name, or one in what it paid. Pure. */
export function equityReason({ title, apiEquity, paidTokens = [] }) {
  if (apiEquity === true) return "Hydrex flags it as tokenized equity";
  const hit = String(title ?? "").split("/").map((x) => x.trim()).find((sym) => isEquityToken(sym));
  if (hit) return `pairs ${clean(hit, 16)}`;
  const t = paidTokens.find((x) => isEquityToken(x.symbol, x.address));
  return t ? `pays ${clean(t.symbol, 16)}` : null;
}
/** Equal shares of 10000 basis points over n pools: the first pools take the remainder, one basis point each. Pure. */
export function splitBps(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_VOTE_POOLS) throw new ArgError(`a vote has from 1 to ${MAX_VOTE_POOLS} pools`);
  const base = Math.floor(10000 / n), extra = 10000 - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}
/** The pools worth reading, from Hydrex's pool list: Base only, one row per address, only pools that list a gauge. Text is cleaned. Pure. */
export function listRankPools(list) {
  if (!Array.isArray(list)) throw new Error("the Hydrex pool list is not an array; refusing");
  const seen = new Set(), out = [];
  for (const s of list) {
    if (!s || s.chainId !== 8453 || !isAddress(String(s.address)) || !s.gauge) continue;
    const pool = getAddress(s.address);
    if (seen.has(pool)) continue;
    seen.add(pool);
    out.push({ pool, title: clean(s.title, 48), apiEquity: Boolean(s.isEquity) });
  }
  return out;
}
/** Batched reads in wide chunks: a ranking is a few thousand cheap reads, so each node request carries about 200 of them, not 15. */
async function multiWide(client, calls, size = 1000) {
  const out = [];
  for (let i = 0; i < calls.length; i += size) out.push(...(await client.multicall({ contracts: calls.slice(i, i + size), allowFailure: true, batchSize: 16_384 })));
  return out;
}

/**
 * What every pool with votes paid its voters in one completed epoch, read from the chain. Fails closed: a pool whose read fails is
 * left out with a problem line, never counted as zero, and a run where nothing could be read throws (exit 1). `epochStart` is for
 * tests and for replaying an older epoch; the command reads the last completed epoch.
 */
export async function readRank(client, { apiPools, epochStart } = {}) {
  const listed = listRankPools(apiPools);
  if (!listed.length) throw new Error("the Hydrex pool list holds no pool with a gauge; refusing");
  if (listed.length > MAX_RANK_POOLS) throw new Error(`the Hydrex pool list holds ${listed.length} pools; this program reads at most ${MAX_RANK_POOLS}`);
  const block = await client.getBlock({ blockTag: "latest" });
  const E = epochStart !== undefined ? BigInt(epochStart) : (block.timestamp / EPOCH_SECONDS) * EPOCH_SECONDS - EPOCH_SECONDS;
  if (!(E > 0n) || E + EPOCH_SECONDS > block.timestamp) throw new Error("that epoch has not ended yet: a ranking reads completed epochs only");
  const problems = [], stats = { listed: listed.length, voted: 0, noGauge: 0, notAlive: 0 };
  const note = (pool, why) => problems.push(`${pool}: ${why}`);

  // 1. the votes each pool held at the flip into that epoch
  const wRes = await multiWide(client, listed.map((p) => ({ address: HYDREX.Voter, abi: VOTER_HISTORY_ABI, functionName: "weightsAt", args: [p.pool, E] })));
  if (wRes.every((r) => r.status !== "success")) throw new Error("every weightsAt read failed; nothing was decided");
  const voted = [];
  listed.forEach((p, i) => { if (wRes[i].status !== "success") note(p.pool, "weightsAt read failed"); else if (wRes[i].result > 0n) voted.push({ ...p, weightUnits: wRes[i].result }); });
  stats.voted = voted.length;

  // 2. each voted pool's gauge, whether it is alive now, and its fee and bribe contracts, all from the Voter
  const gRes = await multiWide(client, voted.map((p) => ({ address: HYDREX.Voter, abi: VOTER_ABI, functionName: "gauges", args: [p.pool] })));
  const gauged = [];
  voted.forEach((p, i) => { if (gRes[i].status !== "success") note(p.pool, "gauges read failed"); else if (gRes[i].result === ZERO) stats.noGauge += 1; else gauged.push({ ...p, gauge: gRes[i].result }); });
  const cRes = await multiWide(client, gauged.flatMap((p) => ["isAlive", "internal_bribes", "external_bribes"].map((functionName) => ({ address: HYDREX.Voter, abi: VOTER_ABI, functionName, args: [p.gauge] }))));
  const live = [];
  gauged.forEach((p, i) => {
    const [alive, fee, bribe] = [cRes[3 * i], cRes[3 * i + 1], cRes[3 * i + 2]];
    if ([alive, fee, bribe].some((r) => r.status !== "success")) return note(p.pool, "the gauge's liveness or reward contracts could not be read");
    if (alive.result !== true) { stats.notAlive += 1; return; }
    if (fee.result === ZERO) return note(p.pool, "the Voter lists no fee contract");
    live.push({ ...p, fee: fee.result, bribe: bribe.result === ZERO ? null : bribe.result });
  });

  // 3. every reward token each contract lists (the API lists the current epoch's only), and what it paid for that epoch
  const contracts = live.flatMap((p) => [{ p, kind: "fees", address: p.fee, tokens: [], err: null }, ...(p.bribe ? [{ p, kind: "bribes", address: p.bribe, tokens: [], err: null }] : [])]);
  const lens = await multiWide(client, contracts.map((c) => ({ address: c.address, abi: REWARD_ABI, functionName: "rewardsListLength" })));
  const slots = [];
  contracts.forEach((c, i) => {
    if (lens[i].status !== "success") { c.err = "rewardsListLength failed"; return; }
    const n = Number(lens[i].result);
    if (n > MAX_REWARD_TOKENS) { c.err = `a reward list of ${n} is not a real list`; return; }
    for (let k = 0; k < n; k++) slots.push({ c, k });
  });
  const toks = await multiWide(client, slots.map(({ c, k }) => ({ address: c.address, abi: REWARD_ABI, functionName: "rewardTokens", args: [BigInt(k)] })));
  slots.forEach(({ c }, j) => { if (toks[j].status === "success") c.tokens.push({ address: toks[j].result, units: 0n }); else c.err = "rewardTokens failed"; });
  const paidReads = contracts.filter((c) => !c.err).flatMap((c) => c.tokens.map((t) => ({ c, t })));
  const pRes = await multiWide(client, paidReads.map(({ c, t }) => ({ address: c.address, abi: PAID_ABI, functionName: "rewardData", args: [t.address, E] })));
  paidReads.forEach(({ c, t }, j) => { if (pRes[j].status === "success") t.units = pRes[j].result[1]; else c.err = "rewardData failed"; });
  const sRes = await multiWide(client, live.map((p) => ({ address: p.fee, abi: PAID_ABI, functionName: "totalSupplyAt", args: [E] })));
  live.forEach((p, i) => { if (sRes[i].status === "success") p.supplyUnits = sRes[i].result; else p.err = "totalSupplyAt failed"; });

  // 4. decimals for every token that paid, and the symbol of every one that is neither a stablecoin nor a known blue chip
  const paid = new Map();
  for (const c of contracts) if (!c.err) for (const t of c.tokens) if (t.units > 0n) paid.set(t.address.toLowerCase(), t.address);
  const addrs = [...paid.values()];
  const needSymbol = (a) => !USD_STABLES.has(a.toLowerCase()) && !KNOWN_NON_EQUITY.has(a.toLowerCase());
  const metaCalls = addrs.flatMap((a) => [{ address: a, abi: ERC20_ABI, functionName: "decimals" }, ...(needSymbol(a) ? [{ address: a, abi: ERC20_ABI, functionName: "symbol" }] : [])]);
  const mRes = await multiWide(client, metaCalls);
  const meta = new Map();
  let at = 0;
  for (const a of addrs) {
    const d = mRes[at++], s = needSymbol(a) ? mRes[at++] : null;
    meta.set(a.toLowerCase(), { decimals: d.status === "success" ? Number(d.result) : null, symbol: s ? (s.status === "success" ? clean(s.result, 16) : null) : "", stable: USD_STABLES.has(a.toLowerCase()) });
  }

  // 5. one row per live pool
  const rows = [];
  for (const p of live) {
    const mine = contracts.filter((c) => c.p === p);
    const bad = mine.find((c) => c.err);
    if (bad) { note(p.pool, `${bad.kind} contract: ${bad.err}`); continue; }
    if (p.err) { note(p.pool, p.err); continue; }
    let feesUsd = 0, bribesUsd = 0, broken = null;
    const unpriced = new Map(), paidTokens = [];
    for (const c of mine) for (const t of c.tokens) {
      if (!(t.units > 0n)) continue;
      const m = meta.get(t.address.toLowerCase());
      if (m.decimals === null || (!m.stable && m.symbol === null)) { broken = `could not read decimals or symbol of reward token ${t.address}`; continue; }
      paidTokens.push({ address: t.address, symbol: m.symbol });
      if (m.stable) { const v = Number(formatUnits(t.units, m.decimals)); if (c.kind === "fees") feesUsd += v; else bribesUsd += v; }
      else { const u = unpriced.get(t.address) ?? { units: 0n, decimals: m.decimals }; u.units += t.units; unpriced.set(t.address, u); }
    }
    if (broken) { note(p.pool, broken); continue; }
    const equity = equityReason({ title: p.title, apiEquity: p.apiEquity, paidTokens });
    rows.push({
      pool: p.pool, title: p.title, gauge: p.gauge, feesUsd, bribesUsd, usd: feesUsd + bribesUsd, supplyUnits: p.supplyUnits, votes: Number(formatUnits(p.supplyUnits, 18)),
      weightAgrees: p.supplyUnits === p.weightUnits, equity, unpriced: [...unpriced].map(([token, u]) => ({ token, amount: formatUnits(u.units, u.decimals) })),
    });
  }
  return { epochStart: E, epochEnd: E + EPOCH_SECONDS, stats, problems, rows };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
/**
 * The ranking and the contract-shaped report. `report` is what `--json` prints and a bot reads (its keys are fixed): the vote string is
 * ready to pass unchanged as `--vote` to `hydrex prepare vote`. `detail` carries the rest for the words. Pure.
 */
export function rankReport(read, { top = MAX_VOTE_POOLS } = {}) {
  const n = Number(top);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VOTE_POOLS) throw new ArgError(`--top is a whole number from 1 to ${MAX_VOTE_POOLS}`);
  const excludedEquity = read.rows.filter((r) => r.equity).map((r) => ({ pool: r.pool, title: r.title, reason: r.equity }));
  const mismatched = read.rows.filter((r) => !r.equity && !r.weightAgrees).map((r) => r.pool);
  const eligible = read.rows
    .filter((r) => !r.equity && r.weightAgrees && r.supplyUnits > 0n && r.usd > RANK_MIN_PAID_USD)
    .map((r) => ({ ...r, rate: (r.usd / r.votes) * 1000 }))
    .sort((a, b) => b.rate - a.rate || b.usd - a.usd || (a.pool < b.pool ? -1 : 1));
  const median = clearingRateFromSamples(eligible.map((r) => ({ usd: r.usd, supply: r.votes })));
  const detail = { eligible, median, excludedEquity, mismatched, problems: read.problems, stats: read.stats, onlyUnpriced: read.rows.filter((r) => !r.equity && r.usd <= RANK_MIN_PAID_USD && r.unpriced.length > 0).length };
  const base = { act: "hydrex rank", epochStart: Number(read.epochStart), epochEnd: Number(read.epochEnd), method: RANK_METHOD, split: RANK_SPLIT };
  if (!eligible.length) {
    if (read.problems.length) throw new Error(`reads failed for ${read.problems.length} pool(s) and no pool could be ranked from the rest; nothing was decided (${read.problems[0]})`);
    return { report: { ...base, vote: null, reason: `no pool paid more than ${RANK_MIN_PAID_USD} USD in USD stablecoins to its voters in the epoch that began at ${Number(read.epochStart)}`, pools: [], unpriced: [] }, detail };
  }
  const chosen = eligible.slice(0, n), bps = splitBps(chosen.length);
  const pools = chosen.map((r, i) => ({ pool: r.pool, gauge: r.gauge, usdPer1kVotes: round6(r.rate), feesUsd: round6(r.feesUsd), bribesUsd: round6(r.bribesUsd), finalWeight: formatUnits(r.supplyUnits, 18), bps: bps[i] }));
  const unpriced = chosen.flatMap((r) => r.unpriced.map((u) => ({ pool: r.pool, token: u.token, amount: u.amount })));
  return { report: { ...base, vote: pools.map((p) => `${p.pool}:${p.bps}`).join(","), pools, unpriced }, detail: { ...detail, chosen } };
}
export function renderRank(report, detail) {
  const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
  const lines = [`last completed epoch: ${day(report.epochStart)} to ${day(report.epochEnd)} (UTC)`, `rule: ${report.method}`];
  if (detail.median !== null) lines.push(`market: the median pool above ${RANK_MIN_PAID_USD} USD paid ${detail.median.toFixed(4)} USD per 1,000 votes (${detail.eligible.length} pools ranked of ${detail.stats.voted} with votes)${boundClearingRate(detail.median) === null ? " (OUTSIDE the usual 0.05 to 5 band: read it with care)" : ""}`);
  if (!report.vote) { lines.push(`nothing to rank: ${report.reason}`); return lines.join("\n"); }
  report.pools.forEach((p, i) => {
    const r = detail.chosen[i];
    const row = `  ${String(i + 1).padStart(2)}. ${p.pool} ${r.title.padEnd(24)} ${p.usdPer1kVotes.toFixed(4)} per 1k votes (fees ${p.feesUsd.toFixed(2)}, bribes ${p.bribesUsd.toFixed(2)}, final votes ${Math.round(r.votes)}) share ${p.bps} bps`;
    const s = standingLinesFor(row);
    lines.push(s ? `${row} (${s})` : row);
  });
  const left = report.unpriced.length;
  lines.push(left ? `left unpriced (not counted, so the rates above are lower bounds): ${left} reward(s) across these pools, listed under "unpriced" with --json; every USD figure here is a USD stablecoin at face value` : "left unpriced: none in these pools; every USD figure here is a USD stablecoin at face value");
  if (detail.onlyUnpriced) lines.push(`${detail.onlyUnpriced} other pool(s) paid ${RANK_MIN_PAID_USD} USD or less in USD stablecoins and the rest in tokens this program does not price, so they are not ranked`);
  if (detail.excludedEquity.length) lines.push(`left out as tokenized equity: ${detail.excludedEquity.length} pool(s) (the vote string passes the equity screen of hydrex prepare vote)`);
  if (detail.mismatched.length) lines.push(`left out because the pool's two weight reads disagree: ${detail.mismatched.length}`);
  lines.push(`split: ${report.split}`, `vote string (pass it unchanged): ${report.vote}`, `next: node protocol-guide.mjs hydrex prepare vote --from 0xYOU --vote ${report.vote}`, `note: ${RANK_RESERVE_NOTE} A pool's pay last epoch is a reading of the past, not a promise.`);
  return lines.join("\n");
}

/**
 * The whole `hydrex rank` act, with its output channels passed in so a test can read them. With --json, stdout is the fixed report and
 * nothing else; what a person should also know (read problems, the reserve note) goes to stderr. Exit 0 with a vote string, exit 10 with
 * none, and a failed read throws (the caller turns that into exit 1).
 */
export async function rankAct(client, { flags, fetcher, out = console.log, err = console.error }) {
  const { report, detail } = rankReport(await readRank(client, { apiPools: await getJson(`${HYDREX_API}/strategies`, { fetcher }) }), { top: flags.top });
  const say = flags.json ? err : out;
  if (flags.json) out(bigJson(report)); else out(renderRank(report, detail));
  for (const x of detail.problems.slice(0, 5)) say(`problem: ${clean(x, 200)}`);
  if (detail.problems.length > 5) say(`problem: and ${detail.problems.length - 5} more pools left out because a read failed`);
  if (flags.json) {
    if (detail.median !== null && boundClearingRate(detail.median) === null) err(`note: the market median of ${detail.median.toFixed(4)} USD per 1,000 votes is outside the usual 0.05 to 5 band: read it with care`);
    if (report.vote) err(`note: ${RANK_RESERVE_NOTE}`);
  }
  return report.vote ? 0 : 10;
}

// =====================================================================================================================
// REGEN (axlREGEN on Base, and Regen Ledger over its REST gateway)
// =====================================================================================================================
const V4Q_ABI = parseAbi(["function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)"]);
const STATE_VIEW_ABI = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)", "function getLiquidity(bytes32 poolId) view returns (uint128)"]);
const ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
export const poolIdOf = (key) => keccak256(enc("address, address, uint24, int24, address", [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
// Universal Router commands and v4 actions (the same encoding the NET circle program uses against this router deployment).
export const CMD_V4_SWAP = 0x10;
export const ACT = { SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e };
export const MSG_SENDER = "0x0000000000000000000000000000000000000001";
export const OPEN_DELTA = 0n;

/**
 * ETH to axlREGEN through the one pool, as one Universal Router call: it settles exactly amountInWei of native ETH,
 * swaps, and takes the axlREGEN straight to the sender. The pool call reverts (V4TooLittleReceived) when less than
 * minOutUnits would arrive. The transaction carries exactly amountInWei as its value, so nothing is left to refund.
 */
export function buildEthInSwapTx({ key, tokenOut, amountInWei, minOutUnits, deadline }) {
  if (!(amountInWei > 0n) || amountInWei > MAX_BUY_REGEN_WEI) throw new Error(`amountInWei must be positive and at most ${formatEther(MAX_BUY_REGEN_WEI)} ETH`);
  if (!(minOutUnits > 0n)) throw new Error("minOutUnits must be positive: it is what makes a bad fill revert");
  if (key.currency0 !== ZERO) throw new Error("this builder swaps native ETH in, so the pool's currency0 must be native ETH");
  const settle = enc("address, uint256, bool", [ZERO, amountInWei, false]);
  const swap = enc("(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", [[ZERO, [[tokenOut, key.fee, key.tickSpacing, key.hooks, "0x"]], OPEN_DELTA, minOutUnits]]);
  const take = enc("address, address, uint256", [tokenOut, MSG_SENDER, OPEN_DELTA]);
  const actions = `0x${[ACT.SETTLE, ACT.SWAP_EXACT_IN, ACT.TAKE].map((a) => a.toString(16).padStart(2, "0")).join("")}`;
  const input = enc("bytes, bytes[]", [actions, [settle, swap, take]]);
  const commands = `0x${CMD_V4_SWAP.toString(16).padStart(2, "0")}`;
  return { to: REGEN.UniversalRouter, data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "execute", args: [commands, [input], deadline] }), value: amountInWei };
}
export function buildBuyRegenTx({ amountInWei, minOutUnits, deadline }) {
  return buildEthInSwapTx({ key: REGEN_POOL, tokenOut: REGEN.axlREGEN, amountInWei, minOutUnits, deadline });
}

/** One v4 pool's state from the StateView: pool id, price, fee and liquidity. A failed read throws; it is never read as an empty pool. */
export async function readV4Pool(client, key) {
  const id = poolIdOf(key);
  const [slot0, liq] = await multi(client, [{ address: REGEN.V4StateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [id] }, { address: REGEN.V4StateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [id] }]);
  const [sqrtPriceX96, tick, , lpFee] = must(slot0, "StateView.getSlot0");
  return { poolId: id, sqrtPriceX96, tick, lpFee, liquidity: must(liq, "StateView.getLiquidity") };
}
export const readRegenPool = (client) => readV4Pool(client, REGEN_POOL);
export async function quoteEthIn(client, key, tokenOut, amountInWei) {
  const r = await client.simulateContract({ address: REGEN.V4Quoter, abi: V4Q_ABI, functionName: "quoteExactInput", args: [{ exactCurrency: ZERO, path: [{ intermediateCurrency: tokenOut, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: "0x" }], exactAmount: amountInWei }] });
  return { outUnits: r.result[0], gas: r.result[1] };
}
export const quoteBuyRegen = (client, amountInWei) => quoteEthIn(client, REGEN_POOL, REGEN.axlREGEN, amountInWei);
/** How much worse the quote is than the pool's own spot price after its fee, in basis points (0 or more). Pure. */
export function impactBps({ amountInWei, outUnits, sqrtPriceX96, lpFee }) {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const spotOut = Number(amountInWei) * sp * sp * (1 - lpFee / 1_000_000);
  if (!(spotOut > 0)) return Infinity;
  return Math.max(0, Math.round((1 - Number(outUnits) / spotOut) * 10_000));
}

/** ETH in, one token out, through one named pool: the quote sets the floor inside the swap, the simulation as `from` gates the print. */
export async function prepareEthSwap(client, { pool, from, amountInWei, slippageBps = 100, maxImpactBps = 300, deadlineSeconds = 60 }) {
  if (!(amountInWei > 0n) || amountInWei > MAX_BUY_REGEN_WEI) throw new ArgError(`--size must be above 0 and at most ${formatEther(MAX_BUY_REGEN_WEI)} ETH`);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new ArgError(`--slippage-bps is a whole number from 1 to ${MAX_SLIPPAGE_BPS}`);
  if (!Number.isInteger(maxImpactBps) || maxImpactBps < 1 || maxImpactBps > MAX_IMPACT_BPS) throw new ArgError(`--max-impact-bps is a whole number from 1 to ${MAX_IMPACT_BPS}`);
  const state = await readV4Pool(client, pool.key);
  if (state.liquidity === 0n) return { sendable: false, reason: `the ${pool.label} pool holds no liquidity right now` };
  const quote = await quoteEthIn(client, pool.key, pool.token, amountInWei);
  const impact = impactBps({ amountInWei, outUnits: quote.outUnits, sqrtPriceX96: state.sqrtPriceX96, lpFee: state.lpFee });
  if (impact > maxImpactBps) return { sendable: false, reason: `this size would move the pool price by about ${impact} basis points, above your --max-impact-bps ${maxImpactBps}; try a smaller --size`, quoteOutUnits: quote.outUnits, impactBps: impact };
  const minOutUnits = (quote.outUnits * BigInt(10_000 - slippageBps)) / 10_000n;
  const block = await client.getBlock({ blockTag: "latest" });
  const tx = buildEthInSwapTx({ key: pool.key, tokenOut: pool.token, amountInWei, minOutUnits, deadline: block.timestamp + BigInt(deadlineSeconds) });
  const failed = await simulate(client, tx, from);
  if (failed) return { sendable: false, reason: `the swap reverts in simulation (${failed})`, quoteOutUnits: quote.outUnits, minOutUnits };
  return { sendable: true, reason: null, pool: pool.label, tokenSymbol: pool.symbol, disclosure: pool.disclosure ?? null, amountInWei, quoteOut: formatUnits(quote.outUnits, pool.decimals), minOut: formatUnits(minOutUnits, pool.decimals), impactBps: impact, slippageBps, deadline: block.timestamp + BigInt(deadlineSeconds), tx: await finalizeTx(client, "base", tx, from) };
}
export async function prepareBuyRegen(client, { from, amountInWei, slippageBps = 100, maxImpactBps = 300, deadlineSeconds = 60 }) {
  const r = await prepareEthSwap(client, { pool: V4_SWAP_POOLS["eth-axlregen"], from, amountInWei, slippageBps, maxImpactBps, deadlineSeconds });
  return r.sendable ? { ...r, quoteOutAxlRegen: r.quoteOut, minOutAxlRegen: r.minOut } : r;
}

// ---- Regen Ledger over its REST gateway -----------------------------------------------------------------------------
export const REGEN_ADDRESS = /^regen1[02-9ac-hj-np-z]{38}$/;
export const JURISDICTION = /^[A-Z]{2}(-[A-Z0-9]{1,3}( [A-Za-z0-9]{1,64})?)?$/;
export const BATCH_DENOM = /^[A-Z]{1,3}\d{2,3}-\d{3}-\d{8}-\d{8}-\d{3}$/;
export function lcdUrl(base, path) {
  const u = new URL(base);
  if (u.protocol !== "https:" || u.username || u.password) throw new ArgError("--lcd must be an https URL with no credentials");
  if (!/^\/[A-Za-z0-9/_.\-?=&%]*$/.test(path)) throw new ArgError(`not a REST path: ${clean(path, 60)}`);
  return u.toString().replace(/\/$/, "") + path;
}
export async function assertRegenLedger(lcd, fetcher) {
  const info = await getJson(lcdUrl(lcd, "/cosmos/base/tendermint/v1beta1/node_info"), { fetcher });
  const net = info?.default_node_info?.network;
  if (net !== "regen-1") throw new ChainError(`the LCD reports network ${clean(net)}, not regen-1`);
}
export async function readCredits(lcd, { limit = 10, fetcher } = {}) {
  const [orders, denoms] = await Promise.all([
    getJson(lcdUrl(lcd, `/regen/ecocredit/marketplace/v1/sell-orders?pagination.limit=${Math.min(limit, 50)}`), { fetcher }),
    getJson(lcdUrl(lcd, "/regen/ecocredit/marketplace/v1/allowed-denoms"), { fetcher }),
  ]);
  const display = new Map((denoms.allowed_denoms || []).map((d) => [d.bank_denom, `${clean(d.display_denom, 16)} (${Number(d.exponent) || 0} decimals)`]));
  return (orders.sell_orders || []).map((o) => ({ sellOrderId: clean(o.id, 12), batchDenom: clean(o.batch_denom, 40), quantity: clean(o.quantity, 24), askDenom: display.get(o.ask_denom) || clean(o.ask_denom, 24), askAmountPerCreditBaseUnits: clean(o.ask_amount, 24), autoRetireDisabled: Boolean(o.disable_auto_retire), expires: o.expiration ? clean(o.expiration, 32) : null }));
}
export async function readRegenBalances(lcd, address, { fetcher } = {}) {
  if (!REGEN_ADDRESS.test(address)) throw new ArgError("--regen must be a regen1... address");
  const [bank, credits] = await Promise.all([
    getJson(lcdUrl(lcd, `/cosmos/bank/v1beta1/balances/${address}`), { fetcher }),
    getJson(lcdUrl(lcd, `/regen/ecocredit/v1/balances/${address}?pagination.limit=50`), { fetcher }),
  ]);
  return {
    address,
    coins: (bank.balances || []).map((c) => ({ denom: clean(c.denom, 70), amount: clean(c.amount, 30) })),
    credits: (credits.balances || []).filter((b) => b.address === address).map((b) => ({ batchDenom: clean(b.batch_denom, 40), tradable: clean(b.tradable_amount, 30), retired: clean(b.retired_amount, 30), escrowed: clean(b.escrowed_amount, 30) })),
  };
}

/** The MsgRetire to sign: the exact credits named, nothing else. Checks the format of every field before it prints. */
export function buildRetireMessage({ owner, batchDenom, amount, jurisdiction, reason }) {
  if (!REGEN_ADDRESS.test(owner)) throw new ArgError("--owner must be a regen1... address");
  if (!BATCH_DENOM.test(batchDenom)) throw new ArgError("--batch must be a credit batch denom such as C01-001-20150101-20151231-001");
  if (!/^(0|[1-9]\d{0,17})(\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) throw new ArgError("--amount must be a positive decimal with at most 6 places");
  if (!JURISDICTION.test(jurisdiction)) throw new ArgError("--jurisdiction must look like US or US-CA or US-CA 90001");
  const why = clean(reason, 200);
  if (!why) throw new ArgError("--reason is needed: it is written onchain with the retirement");
  return { typeUrl: "/regen.ecocredit.v1.MsgRetire", value: { owner, credits: [{ batch_denom: batchDenom, amount }], jurisdiction, reason: why } };
}
export async function prepareRetire(lcd, args, { fetcher } = {}) {
  const message = buildRetireMessage(args);
  await assertRegenLedger(lcd, fetcher);
  const bal = await getJson(lcdUrl(lcd, `/regen/ecocredit/v1/balance/${args.batchDenom}/${args.owner}`), { fetcher });
  const tradable = String(bal?.balance?.tradable_amount ?? "");
  if (!/^\d+(\.\d+)?$/.test(tradable)) return { sendable: false, reason: "could not read this account's tradable balance of that batch" };
  const [tw, tf = ""] = tradable.split("."), [aw, af = ""] = args.amount.split(".");
  const unit = (w, f) => BigInt(w) * 10n ** 6n + BigInt((f + "000000").slice(0, 6));
  if (unit(aw, af) > unit(tw, tf)) return { sendable: false, reason: `the account holds ${clean(tradable, 30)} tradable credits of that batch, less than ${args.amount}` };
  return { sendable: true, reason: null, chainId: "regen-1", message, note: "sign with your own Regen Ledger tooling (for example cosmjs with the Regen message types); gas is paid in uregen and the retirement cannot be undone" };
}

// =====================================================================================================================
// GMX (Arbitrum)
// =====================================================================================================================
const EXCHANGE_ABI = parseAbi([
  "function sendWnt(address receiver, uint256 amount) payable",
  "function sendTokens(address token, address receiver, uint256 amount) payable",
  "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath) addresses,(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime) numbers,uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) payable returns (bytes32)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);
const READER_ABI = parseAbi([
  "function getAccountPositions(address dataStore,address account,uint256 start,uint256 end) view returns (((address account,address market,address collateralToken) addresses,(uint256 sizeInUsd,uint256 sizeInTokens,uint256 collateralAmount,int256 pendingImpactAmount,uint256 borrowingFactor,uint256 fundingFeeAmountPerSize,uint256 longTokenClaimableFundingAmountPerSize,uint256 shortTokenClaimableFundingAmountPerSize,uint256 increasedAtTime,uint256 decreasedAtTime) numbers,(bool isLong) flags)[])",
  "function getAccountOrders(address dataStore,address account,uint256 start,uint256 end) view returns ((bytes32 orderKey,((address account,address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath) addresses,(uint8 orderType,uint8 decreasePositionSwapType,uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 uiFeeFactor,uint256 updatedAtTime,uint256 validFromTime,uint256 srcChainId) numbers,(bool isLong,bool shouldUnwrapNativeToken,bool isFrozen,bool autoCancel) flags,bytes32[] _dataList) order)[])",
]);
const ROLE_ABI = parseAbi(["function hasRole(address account, bytes32 roleKey) view returns (bool)"]);
const STARGATE_ABI = parseAbi(["function token() view returns (address)"]);
export const CONTROLLER_ROLE = keccak256(enc("string", ["CONTROLLER"]));
export const ORDER_TYPE = { MarketIncrease: 2, MarketDecrease: 4 };
/** GMX validates the execution fee against live gas; the unused part is refunded to the account when the order executes. */
export const EXECUTION_FEE_FLOOR_WEI = parseEther("0.0004");
const EXECUTION_GAS_GUESS = 4_000_000n;

export function deriveExecutionFee(gasPriceWei) {
  const derived = (gasPriceWei * EXECUTION_GAS_GUESS * 13n) / 10n;
  const cap = EXECUTION_FEE_FLOOR_WEI * 5n;
  return derived > cap ? cap : derived > EXECUTION_FEE_FLOOR_WEI ? derived : EXECUTION_FEE_FLOOR_WEI;
}
/** USD per token, oracle-scaled (USD * 1e30 / 10^tokenDecimals); acceptable price moves against you by slippageBps. Pure. */
export function acceptablePrice({ isLong, kind, minPrice, maxPrice, slippageBps }) {
  const worse = (kind === "increase") === isLong; // a long buy and a short sell pay a higher price: the limit sits above
  const bps = BigInt(10_000 + (worse ? slippageBps : -slippageBps));
  return ((worse ? maxPrice : minPrice) * bps) / 10_000n;
}
// WHY cancellationReceiver IS ZERO (read 2026-11-16 in GMX's own source, verified on Sourcify as an exact match of the deployed
// OrderHandler 0xa5D2d452... and ExchangeRouter 0x7dE39FF2..., compiler 0.8.29):
//  - contracts/router/ExchangeRouter.sol:223  the order's account is msg.sender, the signer.
//  - contracts/order/OrderUtils.sol:367-370   on a cancel, the collateral goes to cancellationReceiver, and when that is
//                                             address(0) it goes to order.account(): the signer.
//  - contracts/order/OrderUtils.sol:408-412   on a cancel, the execution-fee refund goes to cancellationReceiver, and when that
//                                             is address(0) it goes to order.receiver(): our `from`.
//  - contracts/order/OrderUtils.sol:492 and contracts/order/ExecuteOrderUtils.sol:110
//                                             a frozen order and a filled order refund the fee to order.receiver(); neither
//                                             reads cancellationReceiver at all.
//  - contracts/order/OrderUtils.sol:264-267   creation only refuses a cancellationReceiver equal to the OrderVault; zero is fine.
//  - GMX's own SDK passes zero for a normal order: gmx-io/gmx-interface sdk/src/utils/orderTransactions/utils.ts lines 289
//    (increase), 348 (decrease) and 224 (swap), at commit bae5439b9ebc00bcb4f77adfc1eba9c908618ef9.
// So zero sends every refund to the signer. A test pins this choice; change it only with the evidence above re-read.
function orderCall({ from, market, isLong, kind, sizeDeltaUsd, collateralUnits, acceptable, executionFee }) {
  return encodeFunctionData({ abi: EXCHANGE_ABI, functionName: "createOrder", args: [{
    addresses: { receiver: getAddress(from), cancellationReceiver: ZERO, callbackContract: ZERO, uiFeeReceiver: ZERO, market, initialCollateralToken: GMX.USDC, swapPath: [] },
    numbers: { sizeDeltaUsd, initialCollateralDeltaAmount: kind === "increase" ? collateralUnits : 0n, triggerPrice: 0n, acceptablePrice: acceptable, executionFee, callbackGasLimit: 0n, minOutputAmount: 0n, validFromTime: 0n },
    orderType: kind === "increase" ? ORDER_TYPE.MarketIncrease : ORDER_TYPE.MarketDecrease,
    decreasePositionSwapType: kind === "increase" ? 0 : 1, isLong, shouldUnwrapNativeToken: false, autoCancel: false, referralCode: `0x${"00".repeat(32)}`, dataList: [],
  }] });
}
/** MarketIncrease: send the execution fee, send the collateral, create the order. No UI fee, no referral code. */
export function buildIncreaseTx({ from, market, isLong, collateralUnits, leverageTenths, acceptable, executionFee }) {
  if (!(collateralUnits > 0n) || collateralUnits > MAX_GMX_COLLATERAL_USDC) throw new Error(`collateral must be above 0 and at most ${formatUnits(MAX_GMX_COLLATERAL_USDC, 6)} USDC`);
  if (!(leverageTenths >= 10n) || leverageTenths > MAX_GMX_LEVERAGE_TENTHS) throw new Error("leverage must be from 1x to 10x");
  const sizeDeltaUsd = (collateralUnits * leverageTenths * 10n ** 23n); // USDC units (1e6) * 1e24 = 1e30 USD, leverage in tenths
  const calls = [
    encodeFunctionData({ abi: EXCHANGE_ABI, functionName: "sendWnt", args: [GMX.OrderVault, executionFee] }),
    encodeFunctionData({ abi: EXCHANGE_ABI, functionName: "sendTokens", args: [GMX.USDC, GMX.OrderVault, collateralUnits] }),
    orderCall({ from, market, isLong, kind: "increase", sizeDeltaUsd, collateralUnits, acceptable, executionFee }),
  ];
  return { to: GMX.ExchangeRouter, data: encodeFunctionData({ abi: EXCHANGE_ABI, functionName: "multicall", args: [calls] }), value: executionFee, sizeDeltaUsd };
}
/** MarketDecrease of the whole position: send the execution fee, create the order. Nothing leaves your wallet but that fee. */
export function buildDecreaseTx({ from, market, isLong, sizeInUsd, acceptable, executionFee }) {
  if (!(sizeInUsd > 0n)) throw new Error("there is no position size to close");
  const calls = [
    encodeFunctionData({ abi: EXCHANGE_ABI, functionName: "sendWnt", args: [GMX.OrderVault, executionFee] }),
    orderCall({ from, market, isLong, kind: "decrease", sizeDeltaUsd: sizeInUsd, collateralUnits: 0n, acceptable, executionFee }),
  ];
  return { to: GMX.ExchangeRouter, data: encodeFunctionData({ abi: EXCHANGE_ABI, functionName: "multicall", args: [calls] }), value: executionFee };
}

/** Perp markets that take USDC as collateral, from GMX's own REST API. A name that matches more than one is refused. */
export function pickMarket(markets, tokens, wanted) {
  const decimals = new Map((tokens || []).map((t) => [String(t.address).toLowerCase(), { symbol: clean(t.symbol, 16), decimals: Number(t.decimals) }]));
  const usdc = GMX.USDC.toLowerCase();
  const perps = (markets || [])
    .filter((m) => m && m.isListed && isAddress(String(m.marketToken)) && isAddress(String(m.indexToken)) && String(m.indexToken) !== ZERO)
    .filter((m) => [m.longToken, m.shortToken].some((t) => String(t).toLowerCase() === usdc))
    .map((m) => ({ name: clean(m.name, 40), base: clean(String(m.name).split("/")[0], 16).toUpperCase(), marketToken: getAddress(m.marketToken), indexToken: getAddress(m.indexToken), index: decimals.get(String(m.indexToken).toLowerCase()) || null }))
    .filter((m) => m.index && Number.isInteger(m.index.decimals));
  if (wanted === undefined) return perps;
  const w = String(wanted);
  const hits = perps.filter((m) => (isAddress(w) ? m.marketToken.toLowerCase() === w.toLowerCase() : m.base === w.toUpperCase() || m.index.symbol.toUpperCase() === w.toUpperCase()));
  if (hits.length === 0) throw new ArgError(`no listed USDC-collateral market for ${clean(w, 30)} (see: gmx markets)`);
  if (hits.length > 1) throw new ArgError(`${clean(w, 30)} matches ${hits.length} markets; pass the market token address of one of: ${hits.map((m) => `${m.name} ${m.marketToken}`).join("; ")}`);
  return hits[0];
}

export async function readGmxPositions(client, address) {
  const rows = await client.readContract({ address: GMX.Reader, abi: READER_ABI, functionName: "getAccountPositions", args: [GMX.DataStore, getAddress(address), 0n, 50n] });
  return rows.map((p) => ({ market: p.addresses.market, collateralToken: p.addresses.collateralToken, isLong: p.flags.isLong, sizeInUsd: p.numbers.sizeInUsd, sizeInTokens: p.numbers.sizeInTokens, collateralUnits: p.numbers.collateralAmount, increasedAtTime: p.numbers.increasedAtTime }));
}
export async function readGmxOrders(client, address) {
  const rows = await client.readContract({ address: GMX.Reader, abi: READER_ABI, functionName: "getAccountOrders", args: [GMX.DataStore, getAddress(address), 0n, 50n] });
  return rows.map((r) => ({ orderKey: r.orderKey, market: r.order.addresses.market, orderType: r.order.numbers.orderType, sizeDeltaUsd: r.order.numbers.sizeDeltaUsd, isLong: r.order.flags.isLong, isFrozen: r.order.flags.isFrozen, executionFeeWei: r.order.numbers.executionFee }));
}
export async function assertGmxController(client) {
  const ok = await client.readContract({ address: GMX.RoleStore, abi: ROLE_ABI, functionName: "hasRole", args: [GMX.ExchangeRouter, CONTROLLER_ROLE] });
  if (ok !== true) throw new Error("GMX's RoleStore no longer lists this ExchangeRouter as a controller: GMX has moved its router. Refusing to prepare anything; compare GMX's addresses page and run: node protocol-guide.mjs verify gmx");
}
export async function readTickers(fetcher) { return getJson(`${GMX_API}/prices/tickers`, { fetcher }); }

export async function prepareGmx(client, { act, from, market, isLong, collateralUnits, leverageTenths, slippageBps = 100, fetcher }) {
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new ArgError(`--slippage-bps is a whole number from 1 to ${MAX_SLIPPAGE_BPS}`);
  if (act === "open") {
    if (!(collateralUnits > 0n) || collateralUnits > MAX_GMX_COLLATERAL_USDC) throw new ArgError(`--collateral must be above 0 and at most ${formatUnits(MAX_GMX_COLLATERAL_USDC, 6)} USDC (a starter cap; bigger orders are your own tool's job)`);
    if (!(leverageTenths >= 10n) || leverageTenths > MAX_GMX_LEVERAGE_TENTHS) throw new ArgError("--leverage must be from 1 to 10");
  }
  await assertGmxController(client);
  const [markets, tokens, tickers] = await Promise.all([getJson(`${GMX_API}/markets`, { fetcher }), getJson(`${GMX_API}/tokens`, { fetcher }), readTickers(fetcher)]);
  const m = pickMarket(markets.markets, tokens.tokens, market);
  const t = (tickers || []).find((x) => String(x.tokenAddress).toLowerCase() === m.indexToken.toLowerCase());
  if (!t) return { sendable: false, reason: "GMX's oracle has no price for that market's index token right now" };
  const price = { minPrice: BigInt(t.minPrice), maxPrice: BigInt(t.maxPrice) };
  const owner = getAddress(from);
  const gasPrice = await client.getGasPrice();
  const executionFee = deriveExecutionFee(gasPrice);
  const ethBalance = await client.getBalance({ address: owner });
  const acceptable = acceptablePrice({ isLong, kind: act === "open" ? "increase" : "decrease", slippageBps, ...price });
  const common = { market: m.marketToken, indexSymbol: m.index.symbol, side: isLong ? "long" : "short", executionFeeWei: executionFee, acceptablePriceOracleUnits: acceptable, slippageBps, uiFee: "none", referralCode: "none" };

  if (act === "close") {
    const pos = (await readGmxPositions(client, owner)).find((p) => p.market.toLowerCase() === m.marketToken.toLowerCase() && p.isLong === isLong && p.collateralToken.toLowerCase() === GMX.USDC.toLowerCase());
    if (!pos) return { sendable: false, reason: "this address has no open USDC-collateral position on that market and side" };
    const tx = buildDecreaseTx({ from, market: m.marketToken, isLong, sizeInUsd: pos.sizeInUsd, acceptable, executionFee });
    if (ethBalance < executionFee) return { sendable: false, reason: `the address holds ${formatEther(ethBalance)} ETH on Arbitrum, less than the execution fee ${formatEther(executionFee)} ETH`, ...common };
    const failed = await simulate(client, tx, from, { gasPrice });
    if (failed) return { sendable: false, reason: `the close reverts in simulation (${failed})`, ...common };
    return { sendable: true, reason: null, ...common, closesSizeUsd1e30: pos.sizeInUsd, tx: await finalizeTx(client, "arbitrum", tx, from) };
  }

  const tx = buildIncreaseTx({ from, market: m.marketToken, isLong, collateralUnits, leverageTenths, acceptable, executionFee });
  const [bal, allowance] = await Promise.all([
    client.readContract({ address: GMX.USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: GMX.USDC, abi: ERC20_ABI, functionName: "allowance", args: [owner, GMX.Router] }),
  ]);
  const detail = { ...common, collateralUsdc: formatUnits(collateralUnits, 6), leverage: `${Number(leverageTenths) / 10}x`, positionSizeUsd: formatUnits(tx.sizeDeltaUsd, 30) };
  if (bal < collateralUnits) return { sendable: false, reason: `the address holds ${formatUnits(bal, 6)} USDC on Arbitrum, less than the ${formatUnits(collateralUnits, 6)} you named`, ...detail };
  if (ethBalance < executionFee) return { sendable: false, reason: `the address holds ${formatEther(ethBalance)} ETH on Arbitrum, less than the execution fee ${formatEther(executionFee)} ETH`, ...detail };
  if (allowance < collateralUnits) {
    const approve = { to: GMX.USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [GMX.Router, collateralUnits] }), value: 0n };
    const failed = await simulate(client, approve, from);
    if (failed) return { sendable: false, reason: `the approval reverts in simulation (${failed})`, ...detail };
    return { sendable: true, reason: null, step: "approve", then: "send this exact-amount approval, wait for it, then run the same command again to get the order", ...detail, tx: await finalizeTx(client, "arbitrum", approve, from) };
  }
  const failed = await simulate(client, tx, from, { gasPrice });
  if (failed) return { sendable: false, reason: `the order reverts in simulation (${failed})`, ...detail };
  return { sendable: true, reason: null, step: "order", ...detail, tx: await finalizeTx(client, "arbitrum", tx, from) };
}

// =====================================================================================================================
// KLIMA (Base): retire carbon with kVCM through Klima's own retirement aggregator
// The entry used is the one in Klima's published usage note (KlimaDAO/retirement-aggregator USAGE.md): approve Klima's
// asset manager for kVCM, then call retireCreditViaKlima on the aggregator. It was simulated against live Base. Klima's
// settlement contract has a second entry (retireWithFee); it is not in Klima's published code, it adds a fee on top of the
// quote, and this program does not use it.
// =====================================================================================================================
const OWNER_ABI = parseAbi(["function owner() view returns (address)"]);
const KLIMA_AAM_ABI = parseAbi(["function getAllCarbonClasses() view returns (address[])"]);
const KLIMA_CLASS_ABI = parseAbi([
  "function name() view returns (string)",
  "function getAvailableTonnes() view returns (uint256)",
  "function isCarbonCreditRegistered(address creditToken, uint256 tokenId) view returns (bool)",
  "function getRegisteredTokenIds(address creditToken) view returns (uint256[])",
]);
const RETIRE_DETAILS_TYPE = "(address retiringAddress, string retiringEntityString, address beneficiaryAddress, string beneficiaryString, string retirementMessage, string beneficiaryLocation, string consumptionCountryCode, uint256 consumptionPeriodStart, uint256 consumptionPeriodEnd)";
const KLIMA_AGG_ABI = parseAbi([
  "function quoteRetireCreditViaKlima(address creditToken, uint256 tokenId, uint256 amount, address inputToken, address carbonClass, uint256 couponTonnes) view returns (uint256 tonnes, uint256 price, uint256 unnamed3, uint256 unnamed4)",
  `function retireCreditViaKlima(address creditToken, uint256 tokenId, uint256 batchId, uint256 amount, address inputToken, address carbonClass, uint256 maxInputTokenIn, uint256 couponTonnes, ${RETIRE_DETAILS_TYPE} details)`,
]);
const SAFE_ABI = parseAbi(["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)", "function VERSION() view returns (string)"]);
const ACCESS_MANAGER_ABI = parseAbi(["function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)"]);
const LOUPE_ABI = parseAbi(["function facetAddress(bytes4 selector) view returns (address)"]);
/** EIP-1967: the storage slot that holds a proxy's implementation address (zero for a contract that is not a proxy). */
export const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const isRevert = (e) => { for (let x = e; x; x = x.cause) if (x.name === "ContractFunctionRevertedError" || x.name === "ExecutionRevertedError" || x.name === "RawContractError") return true; return false; };
/** A revert named as plainly as the program can: a known error by name, else its four byte selector, else a cleaned short message. */
export function describeRevert(e) {
  let raw = null;
  for (let x = e; x; x = x.cause) if (!raw && typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) raw = x.data;
  if (raw) { try { const d = decodeErrorResult({ abi: ERRORS, data: raw }); return d.errorName + (d.args?.length ? `(${d.args.map((a) => clean(a)).join(", ")})` : ""); } catch { return `revert ${clean(raw.slice(0, 10))}, an error this program does not name`; } }
  return clean(e?.shortMessage || e?.message || e, 140);
}
const sameAddress = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export async function readKlimaClasses(client) {
  const classes = await client.readContract({ address: KLIMA.AssetManager, abi: KLIMA_AAM_ABI, functionName: "getAllCarbonClasses" });
  const reads = await multi(client, classes.flatMap((c) => [{ address: c, abi: KLIMA_CLASS_ABI, functionName: "name" }, { address: c, abi: KLIMA_CLASS_ABI, functionName: "getAvailableTonnes" }]));
  return classes.map((c, i) => ({ carbonClass: getAddress(c), name: reads[2 * i].status === "success" ? clean(reads[2 * i].result, 48) : "?", availableTonnes: reads[2 * i + 1].status === "success" ? formatUnits(reads[2 * i + 1].result, 18) : null }));
}

/** The credits Klima's published file lists under one class name. The file is outside text: shape-checked, cleaned, capped. Pure. */
export function trimKlimaCredits(file, className, { max = 50 } = {}) {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Klima's credits file is not an object; refusing");
  const group = file[className];
  if (!group || typeof group !== "object" || Array.isArray(group)) return [];
  return Object.entries(group).slice(0, max)
    .map(([label, c]) => ({ label: clean(label, 48), address: c && isAddress(String(c.address), { strict: false }) ? getAddress(String(c.address).toLowerCase()) : null, tokenId: c && /^\d{1,30}$/.test(String(c.tokenId)) ? BigInt(c.tokenId) : null }))
    .filter((r) => r.address && r.tokenId !== null);
}

/** Which credits a class registers: Klima's published list for that class name, each pair checked with the class's own isCarbonCreditRegistered. */
export async function readKlimaCredits(client, carbonClass, { fetcher } = {}) {
  const classes = await readKlimaClasses(client);
  const cls = classes.find((c) => sameAddress(c.carbonClass, carbonClass));
  if (!cls) throw new ArgError(`${clean(carbonClass, 60)} is not on Klima's live list of carbon classes (run: klima classes)`);
  const file = await getJson(KLIMA_CREDITS_URL, { fetcher });
  const rows = trimKlimaCredits(file, cls.name);
  const reg = await multi(client, rows.map((r) => ({ address: cls.carbonClass, abi: KLIMA_CLASS_ABI, functionName: "isCarbonCreditRegistered", args: [r.address, r.tokenId] })));
  const distinct = [...new Set(rows.map((r) => r.address))];
  const ids = await multi(client, distinct.map((a) => ({ address: cls.carbonClass, abi: KLIMA_CLASS_ABI, functionName: "getRegisteredTokenIds", args: [a] })));
  const idsOf = new Map(distinct.map((a, i) => [a, ids[i].status === "success" ? ids[i].result.map(String) : null]));
  return { carbonClass: cls.carbonClass, name: cls.name, credits: rows.map((r, i) => ({ label: r.label, credit: r.address, tokenId: String(r.tokenId), registered: reg[i].status === "success" ? reg[i].result === true : null, registeredTokenIds: idsOf.get(r.address) })), source: KLIMA_CREDITS_URL };
}

/** A class must be on Klima's live list and must itself register the credit and token id: nothing is trusted from the caller. */
export async function checkKlimaCredit(client, { carbonClass, credit, tokenId }) {
  const classes = await client.readContract({ address: KLIMA.AssetManager, abi: KLIMA_AAM_ABI, functionName: "getAllCarbonClasses" });
  const cls = classes.find((c) => sameAddress(c, carbonClass));
  if (!cls) return { ok: false, reason: `${clean(carbonClass, 60)} is not on Klima's live list of carbon classes right now (run: klima classes)` };
  const registered = await client.readContract({ address: cls, abi: KLIMA_CLASS_ABI, functionName: "isCarbonCreditRegistered", args: [getAddress(credit), tokenId] });
  if (registered !== true) return { ok: false, reason: `that class does not register credit ${clean(credit, 60)} with token id ${tokenId} (run: klima credits --class ${clean(carbonClass, 60)})` };
  return { ok: true, carbonClass: getAddress(cls) };
}
export async function quoteKlimaRetire(client, { carbonClass, credit, tokenId = 0n, tonnes }) {
  const chk = await checkKlimaCredit(client, { carbonClass, credit, tokenId });
  if (!chk.ok) return chk;
  try {
    const r = await client.readContract({ address: KLIMA.RetirementAggregator, abi: KLIMA_AGG_ABI, functionName: "quoteRetireCreditViaKlima", args: [getAddress(credit), tokenId, tonnes, KLIMA.kVCM, chk.carbonClass, 0n] });
    return { ok: true, carbonClass: chk.carbonClass, tonnes: r[0], priceUnits: r[1] };
  } catch (e) {
    if (isRevert(e)) return { ok: false, reason: `Klima's quote reverts for this credit and size (${describeRevert(e)})` };
    throw e;
  }
}

/** The text that goes onchain with a retirement: the name you give, cleaned. It is public and permanent. */
export function cleanBeneficiaryName(text) {
  const name = clean(text, MAX_BENEFICIARY_NAME);
  if (!name) throw new ArgError("--beneficiary-name is needed: it is written onchain with the retirement");
  return name;
}
export function buildKlimaRetireDetails({ from, name }) {
  return { retiringAddress: getAddress(from), retiringEntityString: name, beneficiaryAddress: getAddress(from), beneficiaryString: name, retirementMessage: "", beneficiaryLocation: "", consumptionCountryCode: "", consumptionPeriodStart: 0n, consumptionPeriodEnd: 0n };
}
/** The retire call: the aggregator spends at most maxInputTokenIn of kVCM, pulled from the caller by Klima's asset manager. */
export function buildKlimaRetireTx({ carbonClass, credit, tokenId, tonnes, maxKvcmIn, details }) {
  if (!(tonnes >= MIN_KLIMA_TONNES) || tonnes > MAX_KLIMA_TONNES) throw new Error(`tonnes must be from ${formatUnits(MIN_KLIMA_TONNES, 18)} to ${formatUnits(MAX_KLIMA_TONNES, 18)}`);
  if (!(maxKvcmIn > 0n) || maxKvcmIn > MAX_KLIMA_KVCM_IN) throw new Error(`the most kVCM a retirement may spend must be above 0 and at most ${formatUnits(MAX_KLIMA_KVCM_IN, 18)}`);
  return { to: KLIMA.RetirementAggregator, data: encodeFunctionData({ abi: KLIMA_AGG_ABI, functionName: "retireCreditViaKlima", args: [getAddress(credit), tokenId, 0n, tonnes, KLIMA.kVCM, getAddress(carbonClass), maxKvcmIn, 0n, details] }), value: 0n };
}
export function buildKlimaApprovalTx(amountUnits) {
  return { to: KLIMA.kVCM, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [KLIMA.AssetManager, amountUnits] }), value: 0n };
}

export async function prepareKlimaRetire(client, { from, carbonClass, credit, tokenId = 0n, tonnes, beneficiaryName, slippageBps = 100 }) {
  if (!(tonnes >= MIN_KLIMA_TONNES) || tonnes > MAX_KLIMA_TONNES) throw new ArgError(`--tonnes must be from ${formatUnits(MIN_KLIMA_TONNES, 18)} to ${formatUnits(MAX_KLIMA_TONNES, 18)} (Klima's smallest retirement, and a starter cap)`);
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new ArgError(`--slippage-bps is a whole number from 1 to ${MAX_SLIPPAGE_BPS}`);
  const name = cleanBeneficiaryName(beneficiaryName);
  const owner = getAddress(from);
  const q = await quoteKlimaRetire(client, { carbonClass, credit, tokenId, tonnes });
  if (!q.ok) return { sendable: false, reason: q.reason };
  if (q.tonnes !== tonnes) return { sendable: false, reason: `Klima would retire ${formatUnits(q.tonnes, 18)} tonnes for that request, not ${formatUnits(tonnes, 18)}; some classes only retire whole tonnes` };
  if (!(q.priceUnits > 0n)) return { sendable: false, reason: "Klima's quote is zero, which is not a real price; refusing" };
  const maxKvcmIn = (q.priceUnits * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
  const detail = { carbonClass: q.carbonClass, credit: getAddress(credit), tokenId: String(tokenId), tonnes: formatUnits(tonnes, 18), quoteKvcm: formatUnits(q.priceUnits, 18), maxKvcmIn: formatUnits(maxKvcmIn, 18), slippageBps, disclosure: KVCM_DISCLOSURE };
  if (maxKvcmIn > MAX_KLIMA_KVCM_IN) return { sendable: false, reason: `the most this retirement may spend, ${formatUnits(maxKvcmIn, 18)} kVCM, is above the ${formatUnits(MAX_KLIMA_KVCM_IN, 18)} kVCM starter cap; try fewer tonnes or a class that costs less per tonne`, ...detail };
  const [bal, allowance] = await Promise.all([
    client.readContract({ address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] }),
    client.readContract({ address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "allowance", args: [owner, KLIMA.AssetManager] }),
  ]);
  if (bal < maxKvcmIn) return { sendable: false, reason: `the address holds ${formatUnits(bal, 18)} kVCM on Base, less than the ${formatUnits(maxKvcmIn, 18)} kVCM this retirement may spend`, ...detail };
  if (allowance < maxKvcmIn) {
    const approve = buildKlimaApprovalTx(maxKvcmIn);
    const failed = await simulate(client, approve, from);
    if (failed) return { sendable: false, reason: `the approval reverts in simulation (${failed})`, ...detail };
    return { sendable: true, reason: null, step: "approve", then: "send this exact-amount approval to Klima's asset manager, wait for it, then run the same command again to get the retirement", ...detail, tx: await finalizeTx(client, "base", approve, from) };
  }
  const details = buildKlimaRetireDetails({ from, name });
  const tx = buildKlimaRetireTx({ carbonClass: q.carbonClass, credit, tokenId, tonnes, maxKvcmIn, details });
  const failed = await simulate(client, tx, from);
  if (failed) return { sendable: false, reason: `the retirement reverts in simulation (${failed})`, ...detail };
  return { sendable: true, reason: null, step: "retire", ...detail, publicOnchain: { retiringEntity: name, beneficiary: name, beneficiaryAddress: owner, message: "" }, afterwards: "Klima spends the quote, not the maximum. The unspent part of the approval stays on Klima's asset manager, which Klima's admin Safe can upgrade; run klima prepare revoke to set it back to zero.", tx: await finalizeTx(client, "base", tx, from) };
}
export async function prepareKlimaRevoke(client, { from }) {
  const allowance = await client.readContract({ address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "allowance", args: [getAddress(from), KLIMA.AssetManager] });
  if (!(allowance > 0n)) return { sendable: false, reason: "this address has no kVCM approval to Klima's asset manager, so there is nothing to revoke" };
  const tx = buildKlimaApprovalTx(0n);
  const failed = await simulate(client, tx, from);
  if (failed) return { sendable: false, reason: `the revoke reverts in simulation (${failed})` };
  return { sendable: true, reason: null, step: "revoke", approvalNowKvcm: formatUnits(allowance, 18), tx: await finalizeTx(client, "base", tx, from) };
}
export async function readKlimaBalances(client, address) {
  const owner = getAddress(address);
  const r = await multi(client, [
    { address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "balanceOf", args: [owner] },
    { address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "allowance", args: [owner, KLIMA.AssetManager] },
  ]);
  return { address: owner, kvcm: formatUnits(must(r[0], "kVCM.balanceOf"), 18), approvedToAssetManagerKvcm: formatUnits(must(r[1], "kVCM.allowance"), 18) };
}

// =====================================================================================================================
// UNISWAP v4 (Base): the pools the kits already name, read live; one prepared act (ETH in, exact in, floor inside the swap)
// =====================================================================================================================
const sortedKey = (a, b, fee, tickSpacing) => { const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a]; return { currency0, currency1, fee, tickSpacing, hooks: ZERO }; };
const KEY_ETH_ECO = sortedKey(ZERO, TOKENS.ECO, 10000, 200);
/** The pools the ETH in swap can use. Each is native ETH against one token, hookless. */
export const V4_SWAP_POOLS = {
  "eth-axlregen": { label: "ETH/axlREGEN 1%", key: REGEN_POOL, token: REGEN.axlREGEN, symbol: "axlREGEN", decimals: 6, disclosure: null },
  "eth-eco": { label: "ETH/ECO 1%", key: KEY_ETH_ECO, token: TOKENS.ECO, symbol: "ECO", decimals: 18, disclosure: ECO_DISCLOSURE },
};
/**
 * Every v4 pool the kits name, all hookless. `knownId` is the full pool id written in the EcoWealth pool records or the NET circle
 * kit, so a wrong key fails a test; `knownIdEnds` is a short form, kept only for a pool whose full id is not written down. `net`
 * marks a pool that holds NET. NET has five hookless pools on Base (with ETH, WETH, ECO, VVV and HYDROC, 0.01% fee each): this
 * program reads the four with no VVV, and the sibling kit skills/net-circle quotes the four with no HYDROC.
 */
export const V4_POOLS = [
  { id: "eth-axlregen", pair: "ETH/axlREGEN", key: REGEN_POOL, preparedFrom: "ETH", prepared: "uniswap prepare swap --pool eth-axlregen (or regen prepare buy-regen)" },
  { id: "eth-eco", pair: "ETH/ECO", key: KEY_ETH_ECO, knownId: "0x65786d98b37f2b33efda92ea5ad2787b669b21573d5c65bc4fd6d49a28563eb8", preparedFrom: "ETH", prepared: "uniswap prepare swap --pool eth-eco" },
  { id: "eco-axlregen", pair: "ECO/axlREGEN", key: sortedKey(TOKENS.ECO, REGEN.axlREGEN, 10000, 200), knownId: "0xb5e549d43ee8d4c15b2340093308712686edc9926e72efd0fbe70df79bd68afe", prepared: null },
  { id: "eco-usdc", pair: "ECO/USDC", key: sortedKey(TOKENS.ECO, BASE_USDC, 10000, 200), knownId: "0x1c06ae07151c68558114245481544acc18f24476a6eaecdb8f6896abc9850c15", prepared: null },
  { id: "net-eth", pair: "NET/ETH", net: true, key: sortedKey(ZERO, TOKENS.NET, 100, 1), knownId: "0x9f2ff5c43e7f8cd421a120a985d186ecb0a7a3f6ee915fa5e406282bc53549a8", prepared: "skills/net-circle" },
  { id: "net-weth", pair: "NET/WETH", net: true, key: sortedKey(TOKENS.WETH, TOKENS.NET, 100, 1), knownId: "0x9d11774f380cff94a226e3f79d52daeb7e093fddb2646fd2ade68794e30b2ba3", prepared: "skills/net-circle" },
  { id: "net-eco", pair: "NET/ECO", net: true, key: sortedKey(TOKENS.ECO, TOKENS.NET, 100, 1), knownId: "0xf3a5143f135434ef4e500cc128b19af0bc2dcb90b6e04c4613e3338711074301", prepared: "skills/net-circle" },
  { id: "net-hydroc", pair: "NET/HYDROC", net: true, key: sortedKey(TOKENS.HYDROC, TOKENS.NET, 100, 1), knownId: "0xc1fa68882a79a8c85cb59df4d090425902e3047c7b8182b1db3694105d15865c", prepared: null },
];
/** What a pool read says, in one word: none (not created, or no liquidity), open (it holds liquidity), unread (a read failed; never read as none). Pure. */
export function v4RoadState({ slot0, liquidity }) {
  if (slot0.status !== "success" || liquidity.status !== "success") return { state: "unread", reason: clean((slot0.status !== "success" ? slot0.error : liquidity.error)?.shortMessage || "a read failed", 100) };
  if (!(slot0.result[0] > 0n)) return { state: "none", reason: "the pool has not been created" };
  if (!(liquidity.result > 0n)) return { state: "none", reason: "the pool exists and holds no liquidity" };
  return { state: "open", reason: null };
}
export async function readV4Pools(client, pools = V4_POOLS) {
  const reads = await multi(client, pools.flatMap((p) => [{ address: REGEN.V4StateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolIdOf(p.key)] }, { address: REGEN.V4StateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolIdOf(p.key)] }]));
  return pools.map((p, i) => ({ id: p.id, pair: p.pair, venue: "Uniswap v4", chain: "Base", poolId: poolIdOf(p.key), feePct: p.key.fee / 10_000, hooks: "none", net: Boolean(p.net), disclosure: pairDisclosure(p.pair), ...v4RoadState({ slot0: reads[2 * i], liquidity: reads[2 * i + 1] }), liquidityUnits: reads[2 * i + 1].status === "success" ? String(reads[2 * i + 1].result) : null, prepared: p.prepared, preparedFrom: p.preparedFrom ?? null }));
}
export function pickSwapPool(name) {
  const p = V4_SWAP_POOLS[String(name)];
  if (!p) throw new ArgError(`--pool is eth-axlregen or eth-eco, not ${clean(name, 30)}. For NET pools and loops across several pools use skills/net-circle.`);
  return p;
}
export async function quoteSwapPool(client, { pool, amountInWei }) {
  if (!(amountInWei > 0n) || amountInWei > MAX_BUY_REGEN_WEI) throw new ArgError(`--size must be above 0 and at most ${formatEther(MAX_BUY_REGEN_WEI)} ETH`);
  const state = await readV4Pool(client, pool.key);
  if (state.liquidity === 0n) return { pool: pool.label, ethIn: formatEther(amountInWei), liquidity: "0", out: null, disclosure: pool.disclosure ?? null, reason: "the pool holds no liquidity right now" };
  const q = await quoteEthIn(client, pool.key, pool.token, amountInWei);
  return { pool: pool.label, ethIn: formatEther(amountInWei), out: formatUnits(q.outUnits, pool.decimals), symbol: pool.symbol, disclosure: pool.disclosure ?? null, impactBps: impactBps({ amountInWei, outUnits: q.outUnits, sqrtPriceX96: state.sqrtPriceX96, lpFee: state.lpFee }), liquidity: String(state.liquidity), reason: null };
}

// =====================================================================================================================
// THE MAP: the five protocols, the token each uses, and the roads between them that exist as pools today, read live
// A road is a pool that holds liquidity. A pool this kit does not hold the key for is not checked, and its absence here
// proves nothing. Anything that crosses chains is named as a bridge and is not in this kit.
// =====================================================================================================================
export const MAP_PROTOCOLS = [
  { protocol: "Hydrex", chain: "Base", tokens: `HYDX, oHYDX, veHYDX; HYDROC (${HYDROC_DISCLOSURE})`, guide: "guides/hydrex.md" },
  { protocol: "Regen", chain: "Regen Ledger (regen-1) and Base", tokens: "REGEN on Regen Ledger; axlREGEN on Base", guide: "guides/regen.md" },
  { protocol: "GMX", chain: "Arbitrum (a GMX Account reaches it from Base)", tokens: "USDC as collateral, on Arbitrum; from Base, USDC or ETH into a GMX Account", guide: "guides/gmx.md" },
  { protocol: "Klima", chain: "Base", tokens: `kVCM (${KVCM_DISCLOSURE})`, guide: "guides/klima.md" },
  { protocol: "Uniswap v4", chain: "Base", tokens: `ETH, ECO (${ECO_DISCLOSURE}), NET (${NET_DISCLOSURE})`, guide: "guides/uniswap.md" },
];
/** Steps this kit prepares, and what each one moves. */
export const MAP_STEPS = [
  { command: "uniswap prepare swap --pool eth-axlregen | eth-eco", moves: "ETH to axlREGEN, or ETH to ECO, on Base" },
  { command: "regen prepare buy-regen", moves: "ETH to axlREGEN on Base (the same step as the first pool above)" },
  { command: "klima prepare retire", moves: "kVCM to retired carbon on Base, for good" },
  { command: "regen prepare retire", moves: "Regen credits you hold to retired credits on Regen Ledger, for good" },
  { command: "hydrex prepare claim | vote", moves: "no tokens leave you: it claims fees and bribes, or votes your veHYDX lock" },
  { command: "gmx prepare open | close", moves: "USDC in your own Arbitrum wallet into a Classic position, and back out (not a GMX Account balance)" },
];
/**
 * Roads that cross chains. They are named so nothing is invented: no pool, and not prepared by this kit. The first one is GMX's own
 * multichain path (a GMX Account, read 2026-11-17 from GMX's docs and SDK config), not a missing road: GMX's own kit prepares it.
 * `id` marks the one road `map` also reads live.
 */
export const MAP_BRIDGES = [
  { id: "usdc-base-to-gmx-account", from: "USDC or ETH on Base", to: "a GMX Account on Arbitrum (GMX collateral)", road: "GMX's own multichain path (Stargate moves the tokens, LayerZero the message; GMX's docs list Base as a source chain for USDC and ETH); not prepared by this kit, GMX's own kit prepares it (github.com/gmx-io/gmx-ai); a GMX Account is traded with Express orders, which this kit does not prepare" },
  { from: "USDC on Base", to: "USDC in your own Arbitrum wallet (what this kit's gmx acts spend)", road: "any bridge you choose, not prepared here; this is not a GMX Account" },
  { from: "axlREGEN on Base", to: "REGEN on Regen Ledger", road: "bridge (Axelar, route read from Skip), not in this kit; prepare_bridge at vealth.net/mcp prepares it" },
  { from: "HYDX on Base", to: "veHYDX, a lock", road: "guide text only; lock creation is not prepared here" },
];
/** Moves that are not a pool: a retirement, a position, a vote. Each names the command that prepares it. */
export const MAP_STATIC_EDGES = [
  { from: "kVCM", to: "carbon retired for good (Klima)", prepared: "klima prepare retire" },
  { from: "Regen credits", to: "credits retired for good (Regen Ledger)", prepared: "regen prepare retire" },
  { from: "USDC on Arbitrum", to: "a GMX Classic position funded from your wallet, and back", prepared: "gmx prepare open | close" },
  { from: "veHYDX lock", to: "its votes, its claimable fees and bribes", prepared: "hydrex prepare vote | claim" },
];
/**
 * The first step of the map and the router, and the NET programs at https://vealth.net/mcp: which tool answers which need. The tool names
 * are the ones in EcoWealth's published tool list; the levels were read from `net_programs` on 2026-11-17. This is static text:
 * `net_programs` and each program's status read are the live truth, and a test pins every name here to the published list.
 */
export const MAKE_YOUR_OWN = {
  need: "make a coin of your own, the way the house made NET",
  tools: "prepare_net_workers_coin_plan, then net_workers_coin_status",
  state: "a dry plan only. The program is built and not switched on. It launches nothing, and the house holds, signs, buys and sells nothing for you. Today the plan is refused, because the priced read of ECO it needs is not built (ECO is EcoWealth's own token). Both tools are written into EcoWealth's tool list and were not yet served by vealth.net/mcp on 2026-11-17: read its tools/list before you call",
};
export const MAP_NET_DOORS = [
  { need: "find which NET program fits what you want to do", tools: "net_programs (say what you want in plain words), then net_mechanism (one program in full)", state: "free and read-only; each program's level is read from evidence, and on 2026-11-17 every program read as built (dry-executable) and none as deployed" },
  { need: "read the specialist tasks agents have posted, or act on one", tools: "net_open_tasks to read the open ones; prepare_net_order then submit_net_order to act with your own signature; net_order_status to follow it", state: "built and not switched on: its doors record nothing until it is switched on; reads stay open" },
  { need: "earn by accepted work, hold for a later obligation, or act in another NET program", tools: "that program's own prepare and submit pair (for example prepare_net_earn then submit_net_earn) and its status read (for example net_earn_status); net_programs names the program", state: "built and not switched on, the same way" },
  { need: "trade in NET's pools yourself", tools: "the sibling kit skills/net-circle, run with your own wallet (it prepares one unsigned transaction that reverts unless its floor holds)", state: "a program you run, not a NET program, and it needs no switch" },
];
/**
 * Capital loops and sinks the kit knows: capital that goes out through a protocol and comes back, written as a path. A path is never a
 * promise: every leg has fees, the map prints no price, and a loop can return less than it took. Each id in `legs` is a pool the map
 * already reads (its state is shown); a loop with no pool leg is made of prepared acts. A SINK ends the capital by design. This is
 * structure only: it prices nothing, and the kit builds no loop pricing tool.
 */
export const MAP_LOOPS = [
  { id: "kvcm-two-venues", kind: "loop", path: "USDC to kVCM on one venue and back to USDC on the other (the two pools that hold kVCM against USDC, one on Hydrex and one on Aerodrome)", legs: ["hydrex-kvcm-usdc", "aero-kvcm-usdc"], prepared: null, note: "both venues are for your own tools" },
  { id: "eth-axlregen-two-pools", kind: "loop", path: "ETH to axlREGEN on Uniswap v4, and axlREGEN back to WETH (then ETH) through a V2 style pool", legs: ["eth-axlregen", "v2-axlregen-weth"], prepared: "uniswap prepare swap --pool eth-axlregen (the way out only)", note: "the way back is not prepared here" },
  { id: "gmx-position", kind: "loop", path: "USDC in your own Arbitrum wallet into a GMX Classic position, and back to USDC when you close", legs: [], prepared: "gmx prepare open, then gmx prepare close", note: "what comes back is the collateral less fees, plus or minus the position's result; a liquidation can take all of it" },
  { id: "net-circle", kind: "loop", path: "ETH through NET's pools and back to ETH in one transaction (NET/WETH, then NET/ETH)", legs: ["net-weth", "net-eth"], prepared: "skills/net-circle", note: "the transaction reverts unless at least the input plus gas comes back" },
  { id: "hydrex-lock", kind: "loop", path: "your veHYDX lock votes in an epoch, and the fees and bribes of the pools you voted in come back to you to claim", legs: [], prepared: "hydrex rank, then hydrex prepare vote, then hydrex prepare claim", note: "the locked HYDX does not leave: what loops is the lock's reward, and it can be zero" },
  { id: "klima-retire", kind: "sink", path: "kVCM to carbon retired for good on Klima", legs: [], prepared: "klima prepare retire", note: "a retirement ends the capital by design: it does not come back" },
  { id: "regen-retire", kind: "sink", path: "Regen credits to credits retired for good on Regen Ledger", legs: [], prepared: "regen prepare retire", note: "a retirement ends the capital by design: it does not come back" },
];
/** What a loop's pool legs read, in a few words. Pure. */
export function loopReading(legStates) {
  if (!legStates.length) return "no pool to read: it is made of prepared acts";
  if (legStates.some((l) => l.state === "unread")) return "a pool leg could not be read";
  if (legStates.some((l) => l.state === "none")) return "a pool leg has no road, so there is no loop today";
  if (legStates.some((l) => l.state === "thin")) return "every pool leg exists, and one is thin";
  return "every pool leg holds liquidity";
}
/**
 * The standing lines for every token a text names: NET, ECO, kVCM, HYDROC. A token whose line the text already carries gets none.
 * With a `seen` set, ECO, kVCM and HYDROC are disclosed where the text first points at them and not again; NET is disclosed on
 * every mention, always. Pure apart from the set.
 */
export function standingLinesFor(text, seen) {
  const own = { NET: NET_DISCLOSURE, ECO: ECO_DISCLOSURE, kVCM: KVCM_DISCLOSURE, HYDROC: HYDROC_DISCLOSURE };
  const names = Object.keys(own).filter((t) => new RegExp(`\\b${t}\\b`).test(String(text)) && !String(text).includes(own[t]) && !(seen && t !== "NET" && seen.has(t)));
  if (seen) for (const t of names) seen.add(t);
  return names.length ? pairDisclosure(names.join("/")) : null;
}
/** From each token, every open or thin pool read leads somewhere. A prepared command is shown only for the direction it prepares. Pure. */
export function holdingsFrom(roads, statics = []) {
  const out = {};
  for (const r of roads) {
    if (r.state !== "open" && r.state !== "thin") continue;
    const [a, b] = String(r.pair).split("/");
    for (const [from, to] of [[a, b], [b, a]]) (out[from] ||= []).push({ to, venue: r.venue, state: r.state, prepared: r.prepared && (!r.preparedFrom || r.preparedFrom === from) ? r.prepared : null });
  }
  for (const e of statics) (out[e.from] ||= []).push({ to: e.to, venue: null, state: "open", prepared: e.prepared });
  return out;
}
/** A V2 style pool's state from its two reserves: none when a side is empty, thin when its USDC side holds under 1 USDC or its WETH side under 0.0001 ETH, open otherwise. Pure. */
export function v2RoadState({ reserve0, reserve1, token0, token1 }) {
  if (!(reserve0 > 0n) || !(reserve1 > 0n)) return { state: "none", reason: "a side of the pool is empty" };
  const anchor = [[token0, reserve0], [token1, reserve1]].find(([t]) => sameAddress(t, BASE_USDC) || sameAddress(t, TOKENS.WETH));
  if (anchor) {
    const [t, r] = anchor;
    const dust = sameAddress(t, BASE_USDC) ? 1_000_000n : 10n ** 14n;
    if (r < dust) return { state: "thin", reason: sameAddress(t, BASE_USDC) ? "the USDC side holds under 1 USDC" : "the WETH side holds under 0.0001 ETH" };
  }
  return { state: "open", reason: null };
}
const POOL_ABI = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)", "function liquidity() view returns (uint128)",
  "function getReserves() view returns (uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast)",
]);
export async function readOtherPools(client, pools = OTHER_POOLS) {
  const reads = await multi(client, pools.flatMap((p) => [
    { address: p.address, abi: POOL_ABI, functionName: "token0" }, { address: p.address, abi: POOL_ABI, functionName: "token1" },
    p.kind === "algebra" ? { address: p.address, abi: POOL_ABI, functionName: "liquidity" } : { address: p.address, abi: POOL_ABI, functionName: "getReserves" },
  ]));
  return pools.map((p, i) => {
    const [t0, t1, last] = [reads[3 * i], reads[3 * i + 1], reads[3 * i + 2]];
    const base = { id: p.id, pair: p.pair, venue: p.venue, chain: "Base", poolId: p.address, net: false, disclosure: pairDisclosure(p.pair), prepared: null };
    if (t0.status !== "success" || t1.status !== "success" || last.status !== "success") return { ...base, state: "unread", reason: "a read failed", liquidityUnits: null };
    if (!sameAddress(t0.result, p.token0) || !sameAddress(t1.result, p.token1)) return { ...base, state: "unread", reason: "the pool's tokens are not the ones this kit expects", liquidityUnits: null };
    if (p.kind === "algebra") return { ...base, ...(last.result > 0n ? { state: "open", reason: null } : { state: "none", reason: "the pool holds no liquidity" }), liquidityUnits: String(last.result) };
    const [r0, r1] = last.result;
    return { ...base, ...v2RoadState({ reserve0: r0, reserve1: r1, token0: p.token0, token1: p.token1 }), liquidityUnits: `${r0} / ${r1} (raw reserves)` };
  });
}
/** The one cross-chain road the map reads live: the Stargate USDC pool GMX's SDK lists on Base must still name Base USDC as its token. "named" is not a liquidity or a price reading. */
export async function readGmxBaseRoad(client) {
  const [r] = await multi(client, [{ address: GMX_ACCOUNT_BASE.StargateUsdcBase, abi: STARGATE_ABI, functionName: "token" }]);
  if (r.status !== "success") return { state: "unread", reason: "a read failed" };
  return sameAddress(r.result, BASE_USDC) ? { state: "named", reason: null } : { state: "unread", reason: "the pool's token is not Base USDC" };
}
export async function readMap(client) {
  const [v4, other, gmxRoad] = await Promise.all([readV4Pools(client), readOtherPools(client), readGmxBaseRoad(client)]);
  const roads = [...v4, ...other];
  const notInKit = MAP_BRIDGES.map((b) => (b.id === "usdc-base-to-gmx-account" ? { ...b, read: gmxRoad } : b));
  const loops = MAP_LOOPS.map((l) => {
    const legStates = l.legs.map((id) => { const r = roads.find((x) => x.id === id); return { id, pair: r?.pair ?? id, venue: r?.venue ?? "?", state: r?.state ?? "unread" }; });
    return { ...l, legStates, reading: loopReading(legStates) };
  });
  return { protocols: MAP_PROTOCOLS, makeYourOwn: MAKE_YOUR_OWN, roads, holdings: holdingsFrom(roads, MAP_STATIC_EDGES), loops, steps: MAP_STEPS, netDoors: MAP_NET_DOORS, notInKit, notChecked: "Pools behind hooks this kit does not hold the key for are not read. A pair missing here is not proof that no pool exists, only that none exists at the keys this kit knows.", disclosure: `NET: ${NET_DISCLOSURE}. ECO: ${ECO_DISCLOSURE}. kVCM: ${KVCM_DISCLOSURE}. HYDROC: ${HYDROC_DISCLOSURE}. Open means the pool holds liquidity, not that a trade of your size fits: quote first. Nothing here is a price.` };
}
export function renderMap(m) {
  const stand = (line) => { const s = standingLinesFor(line); return s ? `${line} (${s})` : line; };
  const lines = ["FIRST STEP: MAKE YOUR OWN", stand(`  ${m.makeYourOwn.need}: ${m.makeYourOwn.tools}`), stand(`    ${m.makeYourOwn.state}`), "", "PROTOCOLS (token, chain)"];
  for (const p of m.protocols) lines.push(`  ${p.protocol.padEnd(11)} ${p.chain.padEnd(32)} ${p.tokens}  [${p.guide}]`);
  lines.push("", "ROADS: pools that exist today, read live (open = holds liquidity, thin = near empty, none = no road, unread = a read failed)");
  for (const r of m.roads) lines.push(`  ${r.state.padEnd(7)} ${r.pair.padEnd(15)} ${r.venue.padEnd(21)} ${r.disclosure ? `(${r.disclosure}) ` : ""}${r.state === "open" || r.state === "thin" ? `liquidity ${r.liquidityUnits}` : r.reason || ""}${r.prepared ? `  -> ${r.prepared}` : ""}`.trimEnd());
  lines.push("", "WHERE A HOLDING CAN GO NEXT (open and thin pools, both ways; the command in brackets prepares that step)");
  for (const [from, edges] of Object.entries(m.holdings)) {
    const text = edges.map((e) => `${e.to}${e.venue ? ` on ${e.venue}` : ""}${e.state === "thin" ? " (thin)" : ""}${e.prepared ? ` [${e.prepared}]` : ""}`).join("; ");
    const standing = pairDisclosure([from, ...edges.map((e) => e.to)].join("/"));
    lines.push(`  ${from.padEnd(8)} -> ${text}${standing ? ` (${standing})` : ""}`);
  }
  lines.push("", "CAPITAL LOOPS AND SINKS (capital that goes out through a protocol and comes back, as a path with its costs: every leg has fees, the map prints no price, and a loop can return less than it took; a SINK ends the capital by design)");
  for (const l of m.loops) {
    const legs = l.legStates.length ? ` [${l.legStates.map((s) => `${s.pair} on ${s.venue}: ${s.state}`).join("; ")}]` : "";
    lines.push(stand(`  ${l.kind === "sink" ? "SINK" : "LOOP"} ${l.path}${legs}`), stand(`    ${l.reading}${l.prepared ? `; prepared by: ${l.prepared}` : "; this kit prepares no step on it"}; ${l.note}`));
  }
  lines.push("", "STEPS THIS KIT PREPARES");
  for (const s of m.steps) lines.push(`  ${s.command.padEnd(52)} ${s.moves}`);
  lines.push("", stand("THE NET PROGRAMS AT vealth.net/mcp: WHICH TOOL ANSWERS WHICH NEED (built, and none switched on as read on 2026-11-17; net_programs reads each program's level live)"));
  for (const d of m.netDoors) lines.push(stand(`  ${d.need}: ${d.tools}`), stand(`    ${d.state}`));
  lines.push("", "ROADS THAT CROSS CHAINS (not pools; this kit prepares none of them)");
  for (const b of m.notInKit) lines.push(`  ${b.from} -> ${b.to}: ${b.road}${b.read ? ` [read live: ${b.read.state === "named" ? "the Stargate USDC pool GMX names on Base reads, and its token is Base USDC" : `unread, ${b.read.reason}`}]` : ""}`);
  lines.push("", m.notChecked, m.disclosure);
  return lines.join("\n");
}

// =====================================================================================================================
// RECIPES: short complete recipes an agent can run on a timer from the acts above. Instructions and reads only: this program adds no
// signing, no key handling and no scheduler. The agent runs each command itself, branches on its exit code, and sends each printed
// transaction (or signs each printed message) with its OWN signer. No recipe trades for EcoWealth. guides/bots.md carries the same
// commands in prose, and a test checks that every command here is in that page and parses as a real act (no network).
// =====================================================================================================================
/** The branches every step shares. A step lists only the exit codes it adds or changes. */
export const RECIPE_STANDARD_EXITS = {
  1: "a read failed and nothing was decided: wait, run the same command again, and stop the recipe after three failures in a row",
  2: "bad arguments, or an act this program does not know: stop the recipe and fix the command; never run it again unchanged",
  3: "your node is on the wrong chain: stop and fix the RPC setting",
};
export const RECIPES = [
  {
    id: "gmx-trader",
    title: "A GMX trader starter: one small Classic position, read first, closed by your own rule",
    shape: { kind: "loop", path: "USDC in your own Arbitrum wallet goes into a GMX Classic position and comes back to USDC when you close, less fees. It is a path with its costs, not a return: it can come back as less, and a liquidation can take all of it." },
    signer: "Your own signer on Arbitrum. This program never sees a key: you send each printed tx with your own wallet. Fund an Arbitrum wallet with ETH (gas and the execution fee) and native USDC yourself. These acts spend USDC in your own Arbitrum wallet, not a GMX Account balance (guides/gmx.md says how funds get there from Base).",
    steps: [
      { run: "node protocol-guide.mjs verify gmx", on: { 0: "every address checks out: go on", 4: "a check failed, so GMX may have moved an address: stop and do not trade" } },
      { run: "node protocol-guide.mjs gmx markets", on: { 0: "choose one market from the list by your own rule; this recipe names none" } },
      { run: "node protocol-guide.mjs gmx prices --market ETH", on: { 0: "the oracle's min and max price now; the kit gives no view of where it goes" } },
      { run: "node protocol-guide.mjs gmx positions --address 0xYOU --json", on: { 0: "if the list already holds a position on that market and side, skip to the close step; never open a second one" } },
      { run: "node protocol-guide.mjs gmx prepare open --from 0xYOU --market ETH --side long --collateral 5 --leverage 2 --json", on: { 0: "branch on prepared.step: approve means send that exact-amount approval with your own wallet, wait for it to land, then run this same command once more; order means send the order and go on", 10: "nothing sendable: read prepared.reason (a balance too low, a price out of reach), do nothing this cycle and look again next cycle" } },
      { run: "node protocol-guide.mjs gmx orders --address 0xYOU", on: { 0: "an order stays in this list until a keeper fills it a moment later: wait until the list is empty before the next step; if it is still there after several minutes, stop and look at it on Arbiscan" } },
      { run: "node protocol-guide.mjs gmx positions --address 0xYOU", on: { 0: "the position is open: hold it until your own rule says close" } },
      { run: "node protocol-guide.mjs gmx prepare close --from 0xYOU --market ETH --side long --json", on: { 0: "send it: it closes the whole position, and what comes back lands when a keeper fills it", 10: "no open position on that market and side, or not sendable: read prepared.reason" } },
    ],
    caps: "Collateral at most 5 USDC and leverage 1 to 10, enforced by the program. Slippage 100 basis points by default, at most 500. One position per market and side. The example values are not advice. The program has no loss budget: set your own in your agent.",
    cost: "Up to the collateral you name (a liquidation can take all of it), GMX's position fee when you open and close, borrowing and funding fees while the position is open, the execution fee you send (the unused part is refunded), and gas on Arbitrum.",
    stop: "Stop when any step exits 2 or 4, when your own loss budget is spent, or when an order has not filled after several minutes. To get out, run the close step first. Never open a second position while one is open or an order is pending.",
  },
  {
    id: "net-circle-runner",
    title: "A NET circle runner: quote both directions, send only when the floor passes",
    shape: { kind: "loop", path: "ETH goes through NET's pools and comes back to ETH in one transaction, which reverts unless at least the input plus gas comes back. It is a path with its costs, not a return: the pools are tiny and other bots race you." },
    signer: "Your own signer on Base. The sibling kit net-circle prepares one unsigned transaction; you send it with your own wallet before its deadline. Run npm ci once in skills/net-circle.",
    steps: [
      { run: "node ../net-circle/net-circle.mjs pools", on: { 0: "every NET pool's liquidity and its burned founding positions" } },
      { run: "node ../net-circle/net-circle.mjs", on: { 0: "every loop quoted in both directions (buy-net and sell-net): a loop says PAYS x at y in only when a size pays after gas, and otherwise says no size pays after gas" } },
      { run: "node ../net-circle/net-circle.mjs prepare --from 0xYOU --size 0.0001 --json", on: { 0: "sendable is true: send prepared.tx exactly as printed, with its fee fields, before prepared.deadline", 10: "nothing is worth sending now: wait for your next cycle" } },
    ],
    caps: "Size at most 1 ETH, enforced by net-circle; the example uses 0.0001 ETH. --min-profit-wei raises the floor above input plus gas (raise it if your wallet's bundler charges a fee). Do not run it faster than once every 10 seconds.",
    cost: "Gas on every try, including a revert: a lost race or a price that moved reverts the whole transaction and costs its gas. The pools are tiny, so what comes back is cents at most, and other bots watch the same pools. The zora loops send part of the coin pool's fee back to EcoWealth as ECO's creator.",
    stop: "Stop after three reverts in a row, when the gas you have spent passes your own budget, or on exit 2 or 3. The program makes no promise that any size pays.",
  },
  {
    id: "regen-retire",
    title: "A Regen retire step: retire credits you already hold",
    shape: { kind: "sink", path: "A retirement ends the capital by design: the credits you retire do not come back. This is a sink, not a loop." },
    signer: "Your own wallet on Regen Ledger. The program prints the exact message; you sign it with your own Regen tooling and pay gas in REGEN. The credits must already be in your account: this kit does not buy credits.",
    steps: [
      { run: "node protocol-guide.mjs regen balances --regen regen1YOU --json", on: { 0: "find a batch whose tradable amount is above zero" } },
      { run: "node protocol-guide.mjs regen prepare retire --owner regen1YOU --batch C01-001-20150101-20151231-001 --amount 1 --jurisdiction US-CA --reason \"retired by my agent\" --json", on: { 0: "sendable: sign prepared.message with your own Regen Ledger tooling and broadcast it", 10: "not sendable, usually because the tradable balance is below the amount: do nothing" } },
      { run: "node protocol-guide.mjs regen balances --regen regen1YOU --json", on: { 0: "the batch's retired amount went up by what you retired: that is your proof. If it did not, wait and read again before you retry; never retire twice for one purpose" } },
    ],
    note: "Buying axlREGEN on Base (regen prepare buy-regen) gives you a token on Base, not credits. Turning it into credits takes a bridge (prepare_bridge at vealth.net/mcp) and a marketplace buy on Regen Ledger, both outside this kit.",
    caps: "The program checks every field's format and your tradable balance. The amount is yours to set: put a per-run amount in your agent. The reason is cleaned and cut to 200 characters.",
    cost: "The credits you name are retired for good, by design. Gas in REGEN. The reason and your address are public and permanent.",
    stop: "One retirement per cycle, and only after the balances read confirms the last one. Stop when the batch's tradable amount reaches zero, or on exit 2.",
  },
  {
    id: "klima-retire",
    title: "A Klima retire step: quote, approve the exact amount, retire, revoke",
    shape: { kind: "sink", path: "A retirement ends the capital by design: the kVCM it spends does not come back. This is a sink, not a loop. The loop of USDC to kVCM on one venue and back on another is on the map, and this kit prepares no swap on either venue." },
    signer: "Your own signer on Base, with kVCM and ETH in your wallet.",
    steps: [
      { run: "node protocol-guide.mjs klima classes", on: { 0: "choose a class by your own rule; Klima changes the list, and some classes do not retire through this kit (guides/klima.md)" } },
      { run: "node protocol-guide.mjs klima credits --class 0xCLASS", on: { 0: "choose a registered credit and its token id" } },
      { run: "node protocol-guide.mjs klima quote --class 0xCLASS --credit 0xCREDIT --tonnes 0.01 --json", on: { 0: "Klima's own quote in kVCM for this moment; it moves", 10: "no quote for that class or credit: choose another, or stop" } },
      { run: "node protocol-guide.mjs klima balances --address 0xYOU", on: { 0: "you must hold at least the printed maximum (the quote plus slippage)" } },
      { run: "node protocol-guide.mjs klima prepare retire --from 0xYOU --class 0xCLASS --credit 0xCREDIT --tonnes 0.01 --beneficiary-name \"my agent\" --json", on: { 0: "branch on prepared.step: approve means send that exact-amount kVCM approval with your own wallet, wait for it to land, then run this same command once more; retire means send the retirement", 10: "nothing sendable: read prepared.reason" } },
      { run: "node protocol-guide.mjs klima prepare revoke --from 0xYOU --json", on: { 0: "send it: it sets your kVCM approval to Klima's asset manager back to zero", 10: "nothing to revoke" } },
    ],
    caps: "0.001 to 0.1 tonnes per retirement and at most 100 kVCM spent per retirement, enforced by the program. In your agent: one retirement per cycle, only after the last one's receipt is confirmed, and a total kVCM budget you set.",
    cost: "The kVCM the retirement spends (Klima's quote at the moment it lands) is gone, and the carbon is retired for good. Gas on Base. The unspent part of the approval stays on Klima's asset manager, which Klima's admin Safe can upgrade, until you revoke it. Your beneficiary name is public and permanent.",
    stop: "Stop when your kVCM budget is spent, when a quote is far above the last one, or on exit 2. Always run the revoke step after a retirement.",
  },
  {
    id: "hydrex-lock-keeper",
    title: "A Hydrex lock keeper for your OWN lock: claim, then vote for the pools that paid most last epoch, once per epoch",
    shape: { kind: "loop", path: "Your lock votes, and the fees and bribes of the pools you voted in come back to you to claim. The locked HYDX stays locked, so what loops is the lock's reward, and it can be zero. It is a path with its costs, not a return." },
    signer: "Your own signer on Base, for a veHYDX lock you already hold. This kit creates no lock (guide text only) and delegates nothing. EcoWealth holds a veHYDX position.",
    steps: [
      { run: "node protocol-guide.mjs hydrex epoch --json", on: { 0: "secondsToFlip says when the epoch flips (Thursday 00:00 UTC): run the rest once per epoch, after the flip" } },
      { run: "node protocol-guide.mjs hydrex locks --address 0xYOU --json", on: { 0: "no lock in the list means stop; otherwise read your votes, which do not carry over to the new epoch" } },
      { run: "node protocol-guide.mjs hydrex claimable --address 0xYOU", on: { 0: "what you could claim in the pools you vote in now" } },
      { run: "node protocol-guide.mjs hydrex prepare claim --from 0xYOU --json", on: { 0: "one step per reward contract: send each tx exactly as printed", 10: "nothing earned yet, or a claim that reverts: read prepared.reason and the problem lines" } },
      { run: "node protocol-guide.mjs hydrex rank --json", on: { 0: "the pools that paid their voters most per 1,000 votes in the last completed epoch, read from their own reward contracts; its `vote` string goes unchanged into --vote of the next step in place of the example, and `unpriced` lists the rewards left out of the figures (which are USD stablecoins only, so they are lower bounds); As of 2026-11-18 the Hydrex community, in a thread in Hydrex's Discord, reads about six weeks of runway in the reserve that funds most voter rewards. That is their reading, not this program's: check it yourself.", 10: "no pool paid enough to rank: do not run the vote step from this rank; vote by your own rule or not at all this epoch" } },
      { run: "node protocol-guide.mjs hydrex prepare vote --from 0xYOU --vote 0xPOOL:10000 --json", on: { 0: "send the vote: it replaces your previous vote, and the basis points must sum to exactly 10000; send the claim above first, because a claim sees only the pools you vote in now", 10: "no lock, no live gauge for a pool, or the vote reverts: read prepared.reason" } },
    ],
    caps: "At most 10 pools in one vote (`hydrex rank --top` is 1 to 10). A claim covers only the pools you vote in now, and a new vote replaces them: send the claim before the vote, and pass an older pool to your own tool.",
    cost: "Gas only. A new vote replaces the last one, so a careless vote can drop votes you meant to keep.",
    stop: "Run once per epoch. Stop when no lock is found, or on exit 2.",
  },
  {
    id: "where-next",
    title: "A where-next loop: read the map's capital loops and sinks, then pick your next recipe",
    shape: { kind: "reads", path: "It reads the capital loops and sinks the kit knows, with the state of each pool leg, and moves nothing." },
    signer: "None: this recipe only reads. It moves nothing. Each next step is another recipe or act, with your own signer.",
    steps: [
      { run: "node protocol-guide.mjs map --json", on: { 0: "loops lists the capital loops and sinks the kit knows, each with the state of its pool legs; holdings lists, for each token, the roads that are open or thin and the command that prepares the step, if this kit has one; prepared is null when it does not, and then the step is guide text or your own tool" } },
      { run: "node protocol-guide.mjs list", on: { 0: "what each prepared act needs and can cost you: read it before you pick one" } },
      { run: "node protocol-guide.mjs verify", on: { 0: "all five protocols check out", 4: "a check failed: do not act on a road through that protocol" } },
    ],
    caps: "None needed: these are free reads.",
    cost: "Nothing. These are free reads and they move no funds.",
    stop: "Once per cycle. Never act on the map alone: open means a pool holds liquidity, not that your size fits, and the map prints no price, so quote with the act's own read first. NET roads carry the line that the buying in NET's pools is the house's own.",
  },
];
export const RECIPES_INTRO = "Recipes for a bot on a timer. Instructions and reads only: this program adds no signing, no key handling and no scheduler. You run each command, branch on its exit code and send each printed transaction (or sign each printed message) with your own signer. No recipe trades for EcoWealth, and none is advice or an offer. Where a recipe is a capital loop (capital that goes out through a protocol and comes back) it says so and describes a path with its costs, never a profit, and no recipe promises a return. Where it is a sink, because a retirement ends the capital by design, it says that. Run `recipes <id>` for one, `recipes all` for every one, add --json for a machine reading.";
export function pickRecipes(id) {
  if (id === undefined) return RECIPES;
  if (id === "all") return RECIPES;
  const r = RECIPES.find((x) => x.id === id);
  if (!r) throw new ArgError(`no recipe named ${clean(id, 40)}; the recipes are: ${RECIPES.map((x) => x.id).join(", ")}`);
  return [r];
}
export function renderRecipes(list, { index = false } = {}) {
  let seen = new Set();
  const stand = (line) => { const s = standingLinesFor(line, seen); return s ? `${line} (${s})` : line; };
  if (index) return [RECIPES_INTRO, "", ...RECIPES.map((r) => { seen = new Set(); return stand(`  ${r.id.padEnd(20)} [${r.shape.kind}] ${r.title}`); })].join("\n");
  const out = [];
  for (const r of list) {
    seen = new Set();
    out.push(stand(`RECIPE ${r.id}: ${r.title}`), stand(`  ${r.shape.kind.toUpperCase()}: ${r.shape.path}`), stand(`  who signs: ${r.signer}`));
    out.push(`  every step: exit 1 = ${RECIPE_STANDARD_EXITS[1]}; exit 2 = ${RECIPE_STANDARD_EXITS[2]}; exit 3 = ${RECIPE_STANDARD_EXITS[3]}`);
    r.steps.forEach((s, i) => { out.push(stand(`  ${i + 1}. ${s.run}`)); for (const [code, text] of Object.entries(s.on)) out.push(stand(`       exit ${code}: ${text}`)); });
    if (r.note) out.push(stand(`  note: ${r.note}`));
    out.push(stand(`  caps: ${r.caps}`), stand(`  can cost you: ${r.cost}`), stand(`  stop when: ${r.stop}`), "");
  }
  return out.join("\n").trimEnd();
}

// =====================================================================================================================
// verify: one live read per address the guides name; the output is the evidence behind the guides' CHECKED lines
// =====================================================================================================================
export async function verifyProtocol(protocol, { client, baseClient, lcd, fetcher } = {}) {
  const rows = [];
  const add = (name, ok, detail = "") => rows.push({ name, ok, detail: clean(detail, 120) });
  const codeOn = async (c, name, address) => { const code = (await c.getCode({ address })) || "0x"; add(`${name} has code`, code !== "0x", `${address}, ${(code.length - 2) / 2} bytes`); };
  const codeOf = (name, address) => codeOn(client, name, address);
  if (protocol === "hydrex") {
    for (const [name, a] of Object.entries(HYDREX)) await codeOf(name, a);
    const [period, pay] = await multi(client, [{ address: HYDREX.Minter, abi: MINTER_ABI, functionName: "active_period" }, { address: HYDREX.oHYDX, abi: parseAbi(["function paymentToken() view returns (address)"]), functionName: "paymentToken" }]);
    add("Minter.active_period reads", period.status === "success" && period.result > 0n, String(period.result));
    add("oHYDX pays in Base USDC", pay.status === "success" && String(pay.result).toLowerCase() === BASE_USDC.toLowerCase(), String(pay.result));
  } else if (protocol === "regen") {
    for (const [name, a] of Object.entries({ ...REGEN, BaseUSDC: BASE_USDC })) await codeOf(name, a);
    const [dec, sym] = await multi(client, [{ address: REGEN.axlREGEN, abi: ERC20_ABI, functionName: "decimals" }, { address: REGEN.axlREGEN, abi: ERC20_ABI, functionName: "symbol" }]);
    add("axlREGEN has 6 decimals", dec.status === "success" && Number(dec.result) === 6, `${clean(sym.result, 12)} ${String(dec.result)}`);
    const pool = await readRegenPool(client).catch((e) => ({ error: e }));
    add("ETH/axlREGEN pool reads", !pool.error, pool.error ? pool.error.message : `liquidity ${pool.liquidity}`);
    try { await assertRegenLedger(lcd, fetcher); add("the LCD is regen-1", true, lcd); } catch (e) { add("the LCD is regen-1", false, e.message); }
  } else if (protocol === "gmx") {
    for (const [name, a] of Object.entries(GMX)) await codeOf(name, a);
    const ctl = async (name, a) => { const ok = await client.readContract({ address: GMX.RoleStore, abi: ROLE_ABI, functionName: "hasRole", args: [a, CONTROLLER_ROLE] }); return [name, ok]; };
    const [docs, iface] = await Promise.all([ctl("ExchangeRouter (docs address)", GMX.ExchangeRouter), ctl("ExchangeRouter (interface repo address)", GMX_INTERFACE_ROUTER)]);
    add(`RoleStore lists the ${docs[0]} as CONTROLLER`, docs[1] === true, GMX.ExchangeRouter);
    rows.push({ name: `RoleStore lists the ${iface[0]} as CONTROLLER`, ok: true, detail: `${iface[1]} (information only: if the two differ GMX is mid-migration)` });
    const probe = await client.readContract({ address: GMX.Reader, abi: READER_ABI, functionName: "getAccountPositions", args: [GMX.DataStore, MSG_SENDER, 0n, 1n] }).then(() => null, (e) => e);
    add("Reader.getAccountPositions decodes", !probe, probe ? String(probe.shortMessage || probe.message) : "");
    const markets = await getJson(`${GMX_API}/markets`, { fetcher }).then((m) => m.markets, () => null);
    add("GMX's REST /markets answers", Array.isArray(markets), Array.isArray(markets) ? `${markets.length} markets` : "");
    // GMX's own multichain path (a GMX Account): the Arbitrum contracts, the Stargate pools on both chains, and the tokens they name
    const tokenOf = (c, address) => c.readContract({ address, abi: STARGATE_ABI, functionName: "token" }).then((t) => String(t), () => null);
    for (const [name, a] of Object.entries(GMX_ACCOUNT)) await codeOf(`${name} (GMX Account, Arbitrum)`, a);
    const arbUsdc = await tokenOf(client, GMX_ACCOUNT.StargateUsdcArbitrum), arbEth = await tokenOf(client, GMX_ACCOUNT.StargateEthArbitrum);
    add("the Stargate USDC pool on Arbitrum names the USDC this program uses", Boolean(arbUsdc) && sameAddress(arbUsdc, GMX.USDC), String(arbUsdc));
    add("the Stargate ETH pool on Arbitrum is the native ETH pool (token is the zero address)", Boolean(arbEth) && sameAddress(arbEth, ZERO), String(arbEth));
    if (baseClient) {
      for (const [name, a] of Object.entries(GMX_ACCOUNT_BASE)) await codeOn(baseClient, `${name} (GMX Account, Base)`, a);
      const baseUsdc = await tokenOf(baseClient, GMX_ACCOUNT_BASE.StargateUsdcBase), baseEth = await tokenOf(baseClient, GMX_ACCOUNT_BASE.StargateEthBase);
      add("the Stargate USDC pool on Base names Base USDC", Boolean(baseUsdc) && sameAddress(baseUsdc, BASE_USDC), String(baseUsdc));
      add("the Stargate ETH pool on Base is the native ETH pool (token is the zero address)", Boolean(baseEth) && sameAddress(baseEth, ZERO), String(baseEth));
    }
  } else if (protocol === "klima") {
    for (const [name, a] of Object.entries(KLIMA)) await codeOf(name, a);
    for (const [name, a] of Object.entries(KLIMA_PUBLISHED)) await codeOf(`${name} (Klima's published config)`, a);
    await codeOf("Settlement (NOT in its published code, not used)", KLIMA_SETTLEMENT);
    await codeOf("Hydrex conduit v2 (an outside party's, read only)", HYDREX_CONDUIT_V2);
    const [sym, dec] = await multi(client, [{ address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "symbol" }, { address: KLIMA.kVCM, abi: ERC20_ABI, functionName: "decimals" }]);
    add("kVCM has 18 decimals", dec.status === "success" && Number(dec.result) === 18, `${sym.status === "success" ? clean(sym.result, 12) : "?"} ${String(dec.result)}`);
    const classes = await readKlimaClasses(client).catch((e) => ({ error: e }));
    add("the asset manager lists carbon classes", !classes.error && classes.length > 0, classes.error ? classes.error.message : classes.map((c) => c.name).join(", "));
    const retireSel = toFunctionSelector("retireCreditViaKlima(address,uint256,uint256,uint256,address,address,uint256,uint256,(address,string,address,string,string,string,string,uint256,uint256))");
    const quoteSel = toFunctionSelector("quoteRetireCreditViaKlima(address,uint256,uint256,address,address,uint256)");
    for (const [name, sel] of [["retireCreditViaKlima", retireSel], ["quoteRetireCreditViaKlima", quoteSel]]) {
      const facet = await client.readContract({ address: KLIMA.RetirementAggregator, abi: LOUPE_ABI, functionName: "facetAddress", args: [sel] }).catch(() => null);
      add(`the aggregator serves ${name} (${sel})`, Boolean(facet) && facet !== ZERO, String(facet));
    }
    // who controls Klima's contracts, read from the chain
    const admin = KLIMA_PUBLISHED.AdminMultisig;
    const safe = await multi(client, [{ address: admin, abi: SAFE_ABI, functionName: "getOwners" }, { address: admin, abi: SAFE_ABI, functionName: "getThreshold" }, { address: admin, abi: SAFE_ABI, functionName: "VERSION" }]);
    const nOwners = safe[0].status === "success" ? safe[0].result.length : 0, threshold = safe[1].status === "success" ? Number(safe[1].result) : 0;
    add("the admin address is a Safe with several signers", nOwners >= 2 && threshold >= 2 && threshold <= nOwners, `${threshold} of ${nOwners} signers, Safe ${safe[2].status === "success" ? clean(safe[2].result, 12) : "?"}`);
    for (const [name, a] of [["asset manager", KLIMA.AssetManager], ["retirement aggregator", KLIMA.RetirementAggregator], ["staking manager", KLIMA_PUBLISHED.StakingManager], ["reward manager", KLIMA_PUBLISHED.RewardManager]]) {
      const owner = await client.readContract({ address: a, abi: OWNER_ABI, functionName: "owner" }).catch(() => null);
      add(`the ${name} diamond is owned by the admin Safe`, Boolean(owner) && sameAddress(owner, admin), String(owner));
    }
    const role = await client.readContract({ address: KLIMA_PUBLISHED.AccessManager, abi: ACCESS_MANAGER_ABI, functionName: "hasRole", args: [0n, admin] }).catch(() => null);
    add("the admin Safe holds the access manager's admin role (id 0)", Array.isArray(role) && role[0] === true, role ? `delay ${role[1]}` : "read failed");
    const slot = async (a) => { const v = await client.getStorageAt({ address: a, slot: EIP1967_IMPLEMENTATION_SLOT }).catch(() => null); return v && BigInt(v) !== 0n ? `0x${v.slice(26)}` : null; };
    for (const [name, a] of [["kVCM", KLIMA.kVCM], ["carbon ledger", KLIMA_PUBLISHED.CarbonLedger], ["settlement contract", KLIMA_SETTLEMENT], ...(Array.isArray(classes) && classes[0] ? [["a class vault", classes[0].carbonClass]] : [])]) {
      const impl = await slot(a);
      add(`${name} is an upgradeable proxy (EIP-1967 implementation set)`, Boolean(impl), String(impl));
    }
    const am = await slot(KLIMA_PUBLISHED.AccessManager);
    rows.push({ name: "the access manager is not a proxy (Klima's source says non-upgradeable)", ok: true, detail: am ? `information only: an implementation is set, ${am}` : "no implementation slot set" });
  } else if (protocol === "uniswap") {
    for (const [name, a] of Object.entries({ ...UNISWAP, ...TOKENS })) await codeOf(name, a);
    for (const p of V4_POOLS) {
      const id = poolIdOf(p.key);
      if (p.knownId) add(`${p.pair} pool id matches the one in EcoWealth's pool records`, id.toLowerCase() === p.knownId.toLowerCase(), id);
      if (p.knownIdEnds) add(`${p.pair} pool id matches the short form in EcoWealth's records`, id.startsWith(p.knownIdEnds[0]) && id.endsWith(p.knownIdEnds[1]), id);
    }
    for (const r of await readV4Pools(client)) rows.push({ name: `${r.pair} v4 pool reads`, ok: r.state !== "unread", detail: clean(`${r.state}${r.reason ? `: ${r.reason}` : ""}, ${r.poolId.slice(0, 12)}`, 120) });
  }
  return rows;
}

// =====================================================================================================================
// command line
// =====================================================================================================================
const KNOWN_FLAGS = new Set(["json", "rpc", "lcd", "from", "address", "regen", "owner", "size", "slippage-bps", "max-impact-bps", "deadline-seconds", "vote", "kind", "include-equity", "market", "side", "collateral", "leverage", "batch", "amount", "jurisdiction", "reason", "limit", "top", "class", "credit", "token-id", "tonnes", "beneficiary-name", "pool"]);
export function parseArgs(argv) {
  const words = [], flags = {}, votes = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { words.push(a); continue; }
    const name = a.slice(2);
    if (!KNOWN_FLAGS.has(name)) throw new ArgError(`unknown flag --${clean(name, 30)}`);
    if (name === "json" || name === "include-equity") { flags[name] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new ArgError(`--${name} needs a value`);
    // one --vote may carry the whole comma-joined string `hydrex rank` prints, or each POOL:BPS may be its own --vote
    if (name === "vote") votes.push(...v.split(",")); else flags[name] = v;
    i++;
  }
  for (const k of ["from", "address", "class", "credit"]) if (flags[k] !== undefined && !isAddress(flags[k])) throw new ArgError(`--${k} must be an address (a mixed-case address must have a valid checksum)`);
  if (flags["token-id"] !== undefined && !/^\d{1,30}$/.test(flags["token-id"])) throw new ArgError("--token-id is a whole number (0 for most credits)");
  if (flags.tonnes !== undefined && !/^\d+(\.\d{1,6})?$/.test(flags.tonnes)) throw new ArgError("--tonnes is an amount of tonnes with at most 6 places, e.g. 0.01");
  if (flags.size !== undefined && !/^\d+(\.\d+)?$/.test(flags.size)) throw new ArgError("--size is an amount of ETH, e.g. 0.001");
  const int = (name, lo, hi, dflt) => { const n = Number(flags[name] ?? dflt); if (!Number.isInteger(n) || n < lo || n > hi) throw new ArgError(`--${name} is a whole number from ${lo} to ${hi}`); return n; };
  flags.slippageBps = int("slippage-bps", 1, MAX_SLIPPAGE_BPS, 100);
  flags.maxImpactBps = int("max-impact-bps", 1, MAX_IMPACT_BPS, 300);
  flags.deadlineSeconds = int("deadline-seconds", 5, MAX_DEADLINE_SECONDS, 60);
  flags.limit = int("limit", 1, 100, 15);
  flags.top = int("top", 1, MAX_VOTE_POOLS, MAX_VOTE_POOLS);
  if (flags.kind !== undefined && !["fees", "bribes", "both"].includes(flags.kind)) throw new ArgError("--kind is fees, bribes or both");
  if (flags.side !== undefined && !["long", "short"].includes(flags.side)) throw new ArgError("--side is long or short");
  if (flags.collateral !== undefined && !/^\d+(\.\d{1,6})?$/.test(flags.collateral)) throw new ArgError("--collateral is an amount of USDC, e.g. 5");
  if (flags.leverage !== undefined && !/^\d+(\.\d)?$/.test(flags.leverage)) throw new ArgError("--leverage is a number with at most one decimal, e.g. 2 or 2.5");
  return { words, flags, votes };
}

const HELP = `protocol-guide: reads and prepared steps for Hydrex, Regen, Klima and Uniswap (Base), Regen Ledger and GMX (Arbitrum), for an agent with its own wallet.
Holds no key, signs nothing, sends nothing. Never an offer or advice, no return promised.

  list                                    every act, what it needs, what it can cost you
  map                                     the five protocols, their tokens, and the roads between them, read live
  recipes [id|all]                        short complete recipes a bot can run on a timer from these acts (a read, offline)
  verify [hydrex|regen|gmx|klima|uniswap] live check of every address the guides name (gmx reads Base and Arbitrum)
  hydrex epoch | pools [--limit N] [--include-equity] | proposals [--limit N] | locks --address 0x | claimable --address 0x
  hydrex rank [--top N]                   the pools that paid their voters most last epoch (N 1 to 10) and a --vote string for hydrex prepare vote
  hydrex prepare claim --from 0x [--kind fees|bribes|both] [--include-equity]
  hydrex prepare vote --from 0x --vote 0xPOOL:BPS [--vote 0xPOOL:BPS ...]     (BPS sum to 10000)
  regen balances [--address 0x] [--regen regen1...] | pools | credits [--limit N]
  regen prepare buy-regen --from 0x --size ETH [--slippage-bps 100] [--max-impact-bps 300]
  regen prepare retire --owner regen1... --batch C01-... --amount 1 --jurisdiction US-CA --reason "text"
  gmx markets | prices [--market ETH] | positions --address 0x | orders --address 0x
  gmx prepare open --from 0x --market ETH --side long --collateral 5 --leverage 2 [--slippage-bps 100]
  gmx prepare close --from 0x --market ETH --side long [--slippage-bps 100]
  klima classes | credits --class 0x | quote --class 0x --credit 0x --tonnes 0.01 [--token-id N] | balances --address 0x
  klima prepare retire --from 0x --class 0x --credit 0x --tonnes 0.01 --beneficiary-name "text" [--token-id N] [--slippage-bps 100]
  klima prepare revoke --from 0x                                              (sets your kVCM approval to Klima back to zero)
  uniswap pools | quote --pool eth-axlregen|eth-eco --size ETH
  uniswap prepare swap --from 0x --pool eth-axlregen|eth-eco --size ETH [--slippage-bps 100] [--max-impact-bps 300]
  --json machine-readable   --rpc <url> or BASE_RPC_URL / ARBITRUM_RPC_URL   --lcd <url> or REGEN_LCD_URL

Exit codes: 0 ok (prepare: a sendable step was printed) | 2 bad arguments or an act this program does not know |
3 wrong chain | 4 verify failed | 10 the act ran and found nothing to act on now (a prepare act with no sendable step,
a klima or uniswap quote with no quote, or a hydrex rank with no pool to rank) | 1 a read failed (nothing decided).`;

const need = (flags, ...names) => { for (const n of names) if (flags[n] === undefined) throw new ArgError(`--${n} is needed for this act`); };
const REQUIRED = {
  "hydrex locks": ["address"], "hydrex claimable": ["address"], "hydrex prepare claim": ["from"], "hydrex prepare vote": ["from"],
  "regen prepare buy-regen": ["from", "size"], "regen prepare retire": ["owner", "batch", "amount", "jurisdiction", "reason"],
  "gmx positions": ["address"], "gmx orders": ["address"], "gmx prepare open": ["from", "market", "side", "collateral", "leverage"], "gmx prepare close": ["from", "market", "side"],
  "klima credits": ["class"], "klima quote": ["class", "credit", "tonnes"], "klima balances": ["address"],
  "klima prepare retire": ["from", "class", "credit", "tonnes", "beneficiary-name"], "klima prepare revoke": ["from"],
  "uniswap quote": ["pool", "size"], "uniswap prepare swap": ["from", "pool", "size"],
};
/**
 * Everything that can be refused without a network call is refused here, before any client exists: an act this program
 * does not know, a missing flag, a vote that does not sum to 10000, a size or collateral above the starter caps, a
 * malformed Regen message. It throws ArgError (exit 2) and never reads a chain.
 */
export function preflight({ words, flags, votes }) {
  const [protocol, verb, act] = words;
  const key = `${protocol} ${verb === "prepare" ? `prepare ${act}` : verb}`;
  if (!ACTS.some((a) => `${a.protocol} ${a.act}` === key)) throw new ArgError(`I do not know "${clean(words.join(" "), 60)}". Run: node protocol-guide.mjs list`);
  need(flags, ...(REQUIRED[key] || []));
  if (key === "regen balances" && !flags.address && !flags.regen) throw new ArgError("--address and/or --regen is needed");
  if (key === "hydrex prepare vote") parseVotes(votes);
  if (key === "hydrex rank" && flags["include-equity"]) throw new ArgError("hydrex rank leaves tokenized equity out and has no flag to bring it back, so that its vote string always passes the equity screen of hydrex prepare vote");
  if (key === "regen prepare buy-regen") { const wei = parseEther(flags.size); if (!(wei > 0n) || wei > MAX_BUY_REGEN_WEI) throw new ArgError(`--size must be above 0 and at most ${formatEther(MAX_BUY_REGEN_WEI)} ETH`); }
  if (key === "regen prepare retire") buildRetireMessage({ owner: flags.owner, batchDenom: flags.batch, amount: flags.amount, jurisdiction: flags.jurisdiction, reason: flags.reason });
  if (key === "gmx prepare open") {
    const c = parseUnits(flags.collateral, 6), lev = BigInt(Math.round(Number(flags.leverage) * 10));
    if (!(c > 0n) || c > MAX_GMX_COLLATERAL_USDC) throw new ArgError(`--collateral must be above 0 and at most ${formatUnits(MAX_GMX_COLLATERAL_USDC, 6)} USDC (a starter cap)`);
    if (!(lev >= 10n) || lev > MAX_GMX_LEVERAGE_TENTHS) throw new ArgError("--leverage must be from 1 to 10");
  }
  if (key === "klima quote" || key === "klima prepare retire") {
    const t = parseUnits(flags.tonnes, 18);
    if (key === "klima prepare retire" && (!(t >= MIN_KLIMA_TONNES) || t > MAX_KLIMA_TONNES)) throw new ArgError(`--tonnes must be from ${formatUnits(MIN_KLIMA_TONNES, 18)} to ${formatUnits(MAX_KLIMA_TONNES, 18)} (Klima's smallest retirement, and a starter cap)`);
    if (!(t > 0n)) throw new ArgError("--tonnes must be above 0");
  }
  if (key === "klima prepare retire") cleanBeneficiaryName(flags["beneficiary-name"]);
  if (key === "uniswap quote" || key === "uniswap prepare swap") {
    pickSwapPool(flags.pool);
    const wei = parseEther(flags.size);
    if (!(wei > 0n) || wei > MAX_BUY_REGEN_WEI) throw new ArgError(`--size must be above 0 and at most ${formatEther(MAX_BUY_REGEN_WEI)} ETH`);
  }
}
const show = (flags, value, text) => console.log(flags.json ? bigJson(value) : text());

export async function main(argv, io = { fetcher: globalThis.fetch }) {
  if (!argv.length || argv[0] === "help" || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { if (e instanceof ArgError) { console.error(`protocol-guide: ${e.message}`); return 2; } throw e; }
  const { words, flags, votes } = parsed;
  const [protocol, verb, act] = words;
  if (!protocol || protocol === "help" || argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return 0; }
  try {
    if (protocol === "list") { show(flags, ACTS, () => ACTS.map((a) => `${a.protocol.padEnd(7)} ${a.act.padEnd(18)} ${a.kind.padEnd(8)} needs: ${a.needs}\n${" ".repeat(7)} can cost you: ${a.loss}`).join("\n") + "\n\nNot prepared here (guide text only):\n" + Object.entries(NOT_PREPARED).map(([k, v]) => `  ${k}: ${v}`).join("\n") + "\n\nRecipes for a bot on a timer, built from these acts: node protocol-guide.mjs recipes"); return 0; }
    if (protocol === "map") {
      const client = makeClient("base", flags.rpc); await assertChain(client, "base");
      const m = await readMap(client);
      show(flags, m, () => renderMap(m));
      return 0;
    }
    if (protocol === "recipes") {
      if (act !== undefined) throw new ArgError("recipes takes one word: an id, or all");
      const list = pickRecipes(verb);
      if (flags.json) console.log(bigJson({ intro: RECIPES_INTRO, standardExits: RECIPE_STANDARD_EXITS, recipes: list.map((r) => ({ ...r, disclosure: standingLinesFor(JSON.stringify(r)) })) }));
      else console.log(renderRecipes(list, { index: verb === undefined }));
      return 0;
    }
    if (protocol === "verify") {
      const protocols = ["hydrex", "regen", "gmx", "klima", "uniswap"];
      const which = verb ? [verb] : protocols;
      if (which.some((w) => !protocols.includes(w))) throw new ArgError(`verify takes ${protocols.join(", ")}, not ${clean(verb, 30)}`);
      let bad = 0;
      for (const w of which) {
        const chainKey = w === "gmx" ? "arbitrum" : "base";
        const client = makeClient(chainKey, flags.rpc);
        await assertChain(client, chainKey);
        // GMX is read on two chains: --rpc picks the Arbitrum node (as before), and the Base side reads BASE_RPC_URL or the default node
        let baseClient;
        if (w === "gmx") { baseClient = makeClient("base"); await assertChain(baseClient, "base"); }
        const rows = await verifyProtocol(w, { client, baseClient, lcd: flags.lcd || process.env.REGEN_LCD_URL || DEFAULT_LCD, fetcher: io.fetcher });
        bad += rows.filter((r) => !r.ok).length;
        show(flags, { protocol: w, rows }, () => `${w}\n` + rows.map((r) => `  ${r.ok ? "ok  " : "FAIL"} ${r.name}${r.detail ? `: ${r.detail}` : ""}`).join("\n"));
      }
      return bad ? 4 : 0;
    }
    const key = [protocol, verb, act].filter(Boolean).join(" ");
    if (NOT_PREPARED[key] || NOT_PREPARED[`${protocol} ${act || verb}`]) { console.error(`protocol-guide: ${NOT_PREPARED[key] || NOT_PREPARED[`${protocol} ${act || verb}`]}`); return 2; }
    preflight(parsed);
    const lcd = flags.lcd || process.env.REGEN_LCD_URL || DEFAULT_LCD;
    const prepared = verb === "prepare";
    const done = (res) => { show(flags, flags.json ? { sendable: Boolean(res.sendable), prepared: res } : res, () => renderPrepared(res)); return res.sendable ? 0 : 10; };

    if (protocol === "hydrex") {
      const client = makeClient("base", flags.rpc); await assertChain(client, "base");
      if (verb === "epoch") { const r = await readEpoch(client); show(flags, r, () => `epoch started ${new Date(Number(r.epochStart) * 1000).toISOString()}; flips in ${r.secondsToFlip}s; weekly emission ${r.weeklyOhydx} oHYDX (read it, never project it)`); return 0; }
      if (verb === "pools") { const r = trimPools(await getJson(`${HYDREX_API}/strategies`, { fetcher: io.fetcher }), { limit: flags.limit, includeEquity: Boolean(flags["include-equity"]) }); show(flags, r, () => r.map((p) => `${p.pool} ${p.title.padEnd(24)} ${p.type.padEnd(12)} tvl $${Math.round(p.tvlUsd)} ${p.gaugeAlive ? "gauge alive" : "no live gauge"}${p.isEquity ? " TOKENIZED EQUITY" : ""}`).join("\n")); return 0; }
      if (verb === "proposals") { const r = trimProposals(await getJson(HYDREX_GOVERNANCE_API, { fetcher: io.fetcher }), { limit: flags.limit }); show(flags, r, () => r.map((p) => `${p.id.slice(0, 12)} ${p.state.padEnd(10)} for ${p.forVotes} against ${p.againstVotes} quorum ${p.quorumVotes} | ${p.title}`).join("\n")); return 0; }
      if (verb === "rank") return rankAct(client, { flags, fetcher: io.fetcher });
      if (verb === "locks") { need(flags, "address"); const r = await readLocks(client, flags.address); show(flags, r, () => `${r.nfts.length} lock(s), last vote ${r.lastVoted}\n` + r.nfts.map((n) => `  #${n.tokenId} locked ${formatUnits(n.lockedAmountUnits, 18)} HYDX, voting power ${formatUnits(n.votingPowerUnits, 18)}, lockType ${n.lockType}, endTime ${n.endTime}`).join("\n") + "\n" + r.votes.map((v) => `  vote ${v.pool} weight ${v.weightUnits}`).join("\n")); return 0; }
      if (verb === "claimable") { need(flags, "address"); const r = await readClaimable(client, flags.address); const shown = r.contracts.filter((c) => c.readError || c.tokens.some((t) => t.earnedUnits > 0n)); show(flags, r, () => shown.map((c) => `${c.kind} ${c.contract} (pool ${c.pool})${c.readError ? ` READ ERROR: ${c.readError}` : ""}\n` + c.tokens.filter((t) => t.earnedUnits > 0n).map((t) => `    ${t.symbol} ${formatUnits(t.earnedUnits, t.decimals)}`).join("\n")).join("\n") || "nothing earned in the pools this address votes in"); return 0; }
      if (prepared && act === "claim") { need(flags, "from"); return done(await prepareClaim(client, { from: flags.from, kind: flags.kind || "both", includeEquity: Boolean(flags["include-equity"]) })); }
      if (prepared && act === "vote") { need(flags, "from"); let apiPools = null; try { apiPools = await getJson(`${HYDREX_API}/strategies`, { fetcher: io.fetcher }); } catch { apiPools = null; } return done(await prepareVote(client, { from: flags.from, votes, apiPools, includeEquity: Boolean(flags["include-equity"]) })); }
    }
    if (protocol === "regen") {
      if (verb === "credits") { await assertRegenLedger(lcd, io.fetcher); const r = await readCredits(lcd, { limit: flags.limit, fetcher: io.fetcher }); show(flags, r, () => r.map((o) => `sell order ${o.sellOrderId}: ${o.quantity} of ${o.batchDenom} at ${o.askAmountPerCreditBaseUnits} base units of ${o.askDenom} each${o.autoRetireDisabled ? " (seller disabled auto-retire)" : ""}`).join("\n")); return 0; }
      if (verb === "balances") {
        if (!flags.address && !flags.regen) throw new ArgError("--address and/or --regen is needed");
        const out = {};
        if (flags.address) { const c = makeClient("base", flags.rpc); await assertChain(c, "base"); const r = await multi(c, [{ address: REGEN.axlREGEN, abi: ERC20_ABI, functionName: "balanceOf", args: [getAddress(flags.address)] }]); out.axlRegenBase = formatUnits(must(r[0], "axlREGEN.balanceOf"), 6); }
        if (flags.regen) { await assertRegenLedger(lcd, io.fetcher); out.regenLedger = await readRegenBalances(lcd, flags.regen, { fetcher: io.fetcher }); }
        show(flags, out, () => bigJson(out)); return 0;
      }
      const client = makeClient("base", flags.rpc);
      if (verb === "pools") { await assertChain(client, "base"); const pool = await readRegenPool(client); const sizes = ["0.0001", "0.001", "0.01"]; const quotes = []; for (const s of sizes) { const q = await quoteBuyRegen(client, parseEther(s)); quotes.push({ ethIn: s, axlRegenOut: formatUnits(q.outUnits, 6), impactBps: impactBps({ amountInWei: parseEther(s), outUnits: q.outUnits, sqrtPriceX96: pool.sqrtPriceX96, lpFee: pool.lpFee }) }); } const r = { poolId: pool.poolId, liquidity: pool.liquidity, tick: pool.tick, feePct: pool.lpFee / 10_000, quotes }; show(flags, r, () => `ETH/axlREGEN (Uniswap v4, 1% fee) liquidity ${r.liquidity}\n` + quotes.map((q) => `  ${q.ethIn} ETH -> ${q.axlRegenOut} axlREGEN, about ${q.impactBps} bps worse than the pool's spot price`).join("\n")); return 0; }
      if (prepared && act === "buy-regen") { need(flags, "from", "size"); await assertChain(client, "base"); return done(await prepareBuyRegen(client, { from: flags.from, amountInWei: parseEther(flags.size), slippageBps: flags.slippageBps, maxImpactBps: flags.maxImpactBps, deadlineSeconds: flags.deadlineSeconds })); }
      if (prepared && act === "retire") { need(flags, "owner", "batch", "amount", "jurisdiction", "reason"); return done(await prepareRetire(lcd, { owner: flags.owner, batchDenom: flags.batch, amount: flags.amount, jurisdiction: flags.jurisdiction, reason: flags.reason }, { fetcher: io.fetcher })); }
    }
    if (protocol === "gmx") {
      if (verb === "markets") { const [m, t] = await Promise.all([getJson(`${GMX_API}/markets`, { fetcher: io.fetcher }), getJson(`${GMX_API}/tokens`, { fetcher: io.fetcher })]); const r = pickMarket(m.markets, t.tokens); show(flags, r, () => r.map((x) => `${x.index.symbol.padEnd(8)} ${x.name.padEnd(28)} market ${x.marketToken}`).join("\n")); return 0; }
      if (verb === "prices") { const [m, t, k] = await Promise.all([getJson(`${GMX_API}/markets`, { fetcher: io.fetcher }), getJson(`${GMX_API}/tokens`, { fetcher: io.fetcher }), readTickers(io.fetcher)]); let ms = pickMarket(m.markets, t.tokens); if (flags.market) ms = [pickMarket(m.markets, t.tokens, flags.market)]; const r = ms.map((x) => { const tk = k.find((y) => String(y.tokenAddress).toLowerCase() === x.indexToken.toLowerCase()); const scale = 30 - x.index.decimals; return { symbol: x.index.symbol, minUsd: tk ? formatUnits(BigInt(tk.minPrice), scale) : null, maxUsd: tk ? formatUnits(BigInt(tk.maxPrice), scale) : null }; }); show(flags, r, () => r.map((x) => `${x.symbol.padEnd(8)} min $${x.minUsd} max $${x.maxUsd}`).join("\n")); return 0; }
      const client = makeClient("arbitrum", flags.rpc); await assertChain(client, "arbitrum");
      if (verb === "positions") { need(flags, "address"); const r = await readGmxPositions(client, flags.address); show(flags, r, () => r.map((p) => `${p.isLong ? "long" : "short"} market ${p.market} size $${formatUnits(p.sizeInUsd, 30)} collateral ${formatUnits(p.collateralUnits, 6)} (token ${p.collateralToken})`).join("\n") || "no open positions"); return 0; }
      if (verb === "orders") { need(flags, "address"); const r = await readGmxOrders(client, flags.address); show(flags, r, () => r.map((o) => `order ${o.orderKey} type ${o.orderType} market ${o.market} size $${formatUnits(o.sizeDeltaUsd, 30)}${o.isFrozen ? " FROZEN" : ""}`).join("\n") || "no open orders"); return 0; }
      if (prepared && (act === "open" || act === "close")) {
        need(flags, "from", "market", "side"); if (act === "open") need(flags, "collateral", "leverage");
        const lev = flags.leverage !== undefined ? BigInt(Math.round(Number(flags.leverage) * 10)) : 0n;
        return done(await prepareGmx(client, { act, from: flags.from, market: flags.market, isLong: flags.side === "long", collateralUnits: flags.collateral !== undefined ? parseUnits(flags.collateral, 6) : 0n, leverageTenths: lev, slippageBps: flags.slippageBps, fetcher: io.fetcher }));
      }
    }
    if (protocol === "klima") {
      const client = makeClient("base", flags.rpc); await assertChain(client, "base");
      const tokenId = BigInt(flags["token-id"] ?? "0");
      if (verb === "classes") { const r = await readKlimaClasses(client); show(flags, r, () => r.map((c) => `${c.carbonClass} ${c.name.padEnd(34)} ${c.availableTonnes === null ? "tonnes unread" : `${c.availableTonnes} tonnes available`}`).join("\n")); return 0; }
      if (verb === "credits") { const r = await readKlimaCredits(client, flags.class, { fetcher: io.fetcher }); show(flags, r, () => `class ${r.name} ${r.carbonClass} (credits from Klima's published file, each checked against the class)\n` + (r.credits.map((c) => `  ${c.registered === true ? "registered " : c.registered === false ? "NOT registered" : "unread    "} ${c.label.padEnd(26)} credit ${c.credit} token id ${c.tokenId}${c.registeredTokenIds ? ` (class registers ids: ${c.registeredTokenIds.join(",") || "none"})` : ""}`).join("\n") || "  Klima's published file lists no credits under this class name")); return 0; }
      if (verb === "quote") {
        const tonnes = parseUnits(flags.tonnes, 18);
        const q = await quoteKlimaRetire(client, { carbonClass: flags.class, credit: flags.credit, tokenId, tonnes });
        const out = q.ok ? { carbonClass: q.carbonClass, credit: getAddress(flags.credit), tokenId: String(tokenId), tonnes: formatUnits(q.tonnes, 18), kvcm: formatUnits(q.priceUnits, 18), note: "Klima's own quote for this moment; it moves. Retiring spends this in kVCM and nothing comes back.", disclosure: KVCM_DISCLOSURE } : { ok: false, reason: q.reason };
        show(flags, out, () => (q.ok ? `Klima quotes ${out.kvcm} kVCM to retire ${out.tonnes} tonnes of credit ${out.credit} (token id ${out.tokenId}) from class ${out.carbonClass}. ${out.note} ${out.disclosure}.` : `no quote: ${clean(q.reason, 300)}`)); return q.ok ? 0 : 10;
      }
      if (verb === "balances") { const r = { ...(await readKlimaBalances(client, flags.address)), disclosure: KVCM_DISCLOSURE }; show(flags, r, () => `${r.address} holds ${r.kvcm} kVCM on Base and has approved ${r.approvedToAssetManagerKvcm} kVCM to Klima's asset manager. ${r.disclosure}.`); return 0; }
      if (prepared && act === "retire") return done(await prepareKlimaRetire(client, { from: flags.from, carbonClass: flags.class, credit: flags.credit, tokenId, tonnes: parseUnits(flags.tonnes, 18), beneficiaryName: flags["beneficiary-name"], slippageBps: flags.slippageBps }));
      if (prepared && act === "revoke") return done(await prepareKlimaRevoke(client, { from: flags.from }));
    }
    if (protocol === "uniswap") {
      const client = makeClient("base", flags.rpc); await assertChain(client, "base");
      if (verb === "pools") { const r = await readV4Pools(client); show(flags, r, () => r.map((p) => `${p.state.padEnd(7)} ${p.pair.padEnd(13)} fee ${p.feePct}% id ${p.poolId.slice(0, 12)}... ${p.disclosure ? `(${p.disclosure}) ` : ""}${p.state === "open" ? `liquidity ${p.liquidityUnits}` : p.reason || ""}`).join("\n") + "\nOpen means the pool holds liquidity (v4 units, not a price). For NET loops across pools use skills/net-circle."); return 0; }
      if (verb === "quote") { const pool = pickSwapPool(flags.pool); const r = await quoteSwapPool(client, { pool, amountInWei: parseEther(flags.size) }); show(flags, r, () => (r.out ? `${r.ethIn} ETH -> ${r.out} ${r.symbol} through ${r.pool}, about ${r.impactBps} bps worse than the pool's spot price (quote, not a promise)${r.disclosure ? `. ${r.disclosure}.` : ""}` : `no quote: ${r.reason}${r.disclosure ? `. ${r.disclosure}.` : ""}`)); return r.out ? 0 : 10; }
      if (prepared && act === "swap") return done(await prepareEthSwap(client, { pool: pickSwapPool(flags.pool), from: flags.from, amountInWei: parseEther(flags.size), slippageBps: flags.slippageBps, maxImpactBps: flags.maxImpactBps, deadlineSeconds: flags.deadlineSeconds }));
    }
    console.error(`protocol-guide: I do not know ${clean(key, 60) || "that"}. Run: node protocol-guide.mjs list`);
    return 2;
  } catch (e) {
    if (e instanceof ArgError) { console.error(`protocol-guide: ${e.message}`); return 2; }
    if (e instanceof ChainError) { console.error(`protocol-guide: ${e.message}`); return 3; }
    console.error(`protocol-guide: read failed, nothing decided: ${clean(e?.shortMessage || e?.message || e, 300)}`);
    return 1;
  }
}

function renderPrepared(r) {
  const lines = [r.sendable ? "SENDABLE: sign and send exactly this, with your own wallet" : `not sendable: ${clean(r.reason, 300)}`];
  const steps = r.steps ?? (r.tx || r.message ? [r] : []);
  for (const s of steps) {
    if (s.kind || s.rewardContract) lines.push(`  ${s.kind} claim in pool ${s.pool}: ${(s.tokens || []).map((t) => `${t.symbol} ${t.earned}`).join(", ")}`);
    if (s.step) lines.push(`  step: ${s.step}${s.then ? ` (${s.then})` : ""}`);
    if (s.bps) lines.push("  vote: " + s.pools.map((p, i) => `${p}:${s.bps[i]}`).join(" ") + " (this replaces your previous vote)");
    if (s.minOut) lines.push(`  buys at least ${s.minOut} ${s.tokenSymbol} for ${formatEther(s.amountInWei)} ETH through ${s.pool} (quote ${s.quoteOut}, price impact about ${s.impactBps} bps), or reverts`, ...(s.disclosure ? [`  ${s.disclosure}`] : []));
    if (s.step === "approve" && s.maxKvcmIn) lines.push(`  approves exactly ${s.maxKvcmIn} kVCM to Klima's asset manager, for ${s.tonnes} tonnes of credit ${s.credit} (Klima's quote ${s.quoteKvcm} kVCM)`, ...(s.disclosure ? [`  ${s.disclosure}`] : []));
    if (s.step === "retire") lines.push(`  retires ${s.tonnes} tonnes of credit ${s.credit} for good, spending at most ${s.maxKvcmIn} kVCM (Klima's quote ${s.quoteKvcm}); written onchain, public and permanent: entity and beneficiary "${s.publicOnchain.beneficiary}", beneficiary address ${s.publicOnchain.beneficiaryAddress}`, `  ${s.afterwards}`, ...(s.disclosure ? [`  ${s.disclosure}`] : []));
    if (s.step === "revoke") lines.push(`  sets your kVCM approval to Klima's asset manager from ${s.approvalNowKvcm} back to 0`);
    if (s.positionSizeUsd) lines.push(`  ${s.side} ${s.indexSymbol} position of $${s.positionSizeUsd} on ${s.collateralUsdc} USDC at ${s.leverage}; execution fee ${formatEther(s.executionFeeWei)} ETH is sent with it (the unused part is refunded)`);
    if (s.message) lines.push("  message: " + JSON.stringify(s.message), `  ${s.note}`);
    if (s.tx) lines.push("  tx: " + bigJson(s.tx).replace(/\s+/g, " "));
  }
  if (r.skipped?.length) lines.push(...r.skipped.map((x) => `  left out: ${x}`));
  if (r.failures?.length) lines.push(...r.failures.map((x) => `  problem: ${clean(x, 200)}`));
  return lines.join("\n");
}

const self = fileURLToPath(import.meta.url);
let invokedDirectly = false;
try { invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(self); } catch { invokedDirectly = false; }
if (invokedDirectly) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`protocol-guide: ${clean(e?.shortMessage || e?.message || e)}`); process.exit(1); });
}
