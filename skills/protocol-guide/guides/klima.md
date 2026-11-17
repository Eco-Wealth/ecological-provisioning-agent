# Klima on Base: a guide for an agent with its own wallet

Never an offer or advice, no return promised. This guide says how Klima works and how to use it. It does not say you should. The thesis and its limits: https://vealth.net/tokens.html

Read on 2026-11-16 from Klima's published protocol code (github.com/KlimaDAO/protocol-v2-core, MIT, release v1.0.0 of 2026-10-19), Klima's retirement usage note (github.com/KlimaDAO/retirement-aggregator, USAGE.md), the chain, and Regen Ledger's REST gateway. Run `node protocol-guide.mjs verify klima` to re-check every address below against the live chain. Each claim below says how it was read.

## What Klima is for

Klima Protocol (version 2) runs on Base. Carbon credits are deposited into class vaults, one per kind of credit, and the protocol's token, kVCM (18 decimals), is backed by them. You can spend kVCM to retire a carbon credit. A retirement is a public, permanent record that someone took tonnes of carbon out of circulation, with a name attached. The program here reads Klima and prepares that one act: retiring carbon with kVCM you already hold.

## Which chain

Base, chain id 8453. Nothing here uses Ethereum mainnet.

## Before you start

- A wallet you control, with kVCM and ETH on Base. This program never sees your key.
- Node 20 or newer, and `npm ci` in this folder for viem.
- Where to get kVCM: this program does not prepare a kVCM purchase. `node protocol-guide.mjs map` reads, live, the pools that hold kVCM against USDC (one on Hydrex, one on Aerodrome). Use your own tools to trade there. EcoWealth holds some kVCM and gains if it rises (listed at the end of this page).

## Contracts (Base, chain 8453)

| Name | Address | What it is |
|---|---|---|
| kVCM | `0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d` | the token you spend |
| Retirement aggregator | `0xdA0A793D7C32AB80bcdab7F8c725c96DB22464f4` | the contract you call to retire |
| Asset manager | `0x1C24239309398220883207681602BfF4D10fbde1` | Klima's diamond: lists the carbon classes and pulls your kVCM. Approve this one |
| Admin multisig | `0xD23CCDc650b2a5709e0Eb3C7e68B9C77c20e361b` | the one address Klima's config names for every control seat |
| Treasury | `0x75295D12C90d59Bd038D7CB7102c466f8017fa25` | named in Klima's config. A different address from the admin multisig. What it holds was not read |
| Access manager | `0xf158AE8e6DeC82353E52E92Cc90dced63a861Ff1` | roles for the protocol |
| Staking manager | `0x5101a7ca3E8815C0FeeD8976F109EE01D8ED0c3D` | staking and locks. Not used by this program |
| Reward manager | `0xada87d6f68054d0caB4789b332279b18932e928F` | yield engine. Not used by this program |
| Carbon ledger | `0xAD87E90614276430b25801Dfc0C76E01e309d6E1` | the registry of vaults. Not called by this program |
| zkMe verify | `0x8c81bbc5cC9B6cdbb5c0e5DD8b9D5bfaF3575710` | the identity check that staking calls |
| kVCM and USDC pool | `0x5C0D76fab1822bDeb47308eD6028231761ED723E` | named in Klima's config. Read by the map |
| Settlement | `0x290e98e95dacE244c73376C0c39A4D53b22E34B6` | **not in Klima's published code.** It has code on Base and is an upgradeable proxy (`verify klima`). This program does not use it |

Every address had code on 2026-11-16 (`verify klima`). The first three are the ones the retire act touches. The rest come from Klima's published config file `protocol-config/8453/protocol-config.toml`. The settlement contract is in none of Klima's published files we read. What anyone can check is that it has code on Base, that it is a proxy, and, by simulating its `retireWithFee` entry against live Base, that the entry adds a fee on top of Klima's quote (see "Which entry it uses" below).

## Who controls Klima's contracts

Read this before you approve anything. How each line was read is in brackets.

- **One admin address.** Klima's published config names `0xD23C...` as owner, vault manager, liquidity manager, admin multisig and kVCM locks manager. [config file, read]
- **It is a Safe.** Version 1.4.1, with a threshold of 3 signers out of 6 on 2026-11-16. [chain, `verify klima`]
- **It owns the main contracts.** The asset manager, the retirement aggregator, the staking manager and the reward manager are EIP-2535 diamonds, and `owner()` on each returned that same Safe. The owner of a diamond can replace its logic. [chain, `verify klima`]
- **Most of the rest is upgradeable too.** kVCM, the carbon ledger and the settlement contract are proxies with an implementation set (EIP-1967), and so is a class vault. [chain, `verify klima`]. Klima's source marks the class vault as upgradeable by its system admin. [`CarbonClassVault.sol`, read]
- **One part is not.** The access manager is not a proxy. [chain: no implementation set; Klima's source says "Non-upgradeable" in `ProtocolAccessManager.sol`] The Safe holds its admin role with no delay. [chain, `verify klima`]
- **Parts can be paused.** The asset manager's retire and swap entry points refuse while a system pause is on, and the staking manager has its own pause facet. [Klima's source, `OperationsFacet.sol` and `StakingManagerPauseFacet.sol`, read. Whether any pause is on today was not read.] A pause makes your retirement revert and costs you gas only.
- **Not checked.** Whether the retirement aggregator's own logic or the settlement contract can be paused. The aggregator's code is in a separate Klima repository that we did not read, and the settlement code is not published.

In plain words: a group of six, three of whom must agree, can change how Klima's main contracts work. Nothing in the code we read stops that. If you use Klima you rely on that group.

## Staking asks who you are. Retiring does not.

- Klima's published staking code calls a zkMe identity check before it accepts a stake or a lock, and reverts with `ZkMeNotVerified` if you have not passed it. It is in the three staking facets (kVCM, K2 and LP tokens). [Klima's source, read; a search of the whole repository found zkMe only in those facets, the staking config and the zkMe library]
- The retire path (the aggregator, then the asset manager's `retireCarbonCreditViaAggregator`) has no zkMe call in the code we read. [Klima's source, read] A retirement from an address that the zkMe contract does not approve also ran cleanly against a fork of live Base. [zkMe contract read, then simulation, 2026-11-16]

## The classes

`klima classes` reads Klima's live list. On 2026-11-16 the asset manager listed six: SOLAR_PV_INDIA, BCHAR, OAE, REGEN_CFC, WIND_INDIA and AVOIDED_DEFORESTATION_2018_2026. What the retire act did with each, simulated as an address holding kVCM:

| Class | What it is | Result |
|---|---|---|
| REGEN_CFC | credits from Regen Ledger class C02, the "Urban Forest Carbon Credit Class" whose source registry is City Forest Credits | works |
| WIND_INDIA | wind power credits, UCR registry | works |
| OAE | ocean alkalinity credits | works. Priced far above the others per tonne, so the starter cap on kVCM spent applies quickly |
| SOLAR_PV_INDIA | solar power credits, UCR registry | the quote reverted (selector `0xce71efe8`, which this program does not name), so nothing is prepared |
| BCHAR | biochar credits, Puro registry | reverts with `InvalidBeneficiaryLocation`. Puro retirements need a batch id, a location, a country and a period, which this program does not send. Not prepared |
| AVOIDED_DEFORESTATION_2018_2026 | avoided deforestation credits, ERC-1155 with token ids | the quote reverts. Klima's usage note lists this credit type as coming soon. Not prepared |

[Class names: chain. Class C02: Regen Ledger over REST, its published metadata names City Forest Credits as the source registry. Results: simulations as the program, 2026-11-16.] Klima changes this list. Run `klima classes` and `klima quote` before you rely on any row.

## The acts

### 1. Read (free)

```
node protocol-guide.mjs klima classes
node protocol-guide.mjs klima credits --class 0x..
node protocol-guide.mjs klima quote --class 0x.. --credit 0x.. --tonnes 0.01 [--token-id N]
node protocol-guide.mjs klima balances --address 0x..
```

`credits` takes the credits Klima's published file lists for that class and checks each one with the class's own `isCarbonCreditRegistered`. A credit Klima added after that file was last updated is not shown. For a credit with token ids, `credits` also prints the ids the class vault reports. `quote` is Klima's own quote for that credit and size at this moment, in kVCM. It moves.

### 2. Retire carbon

```
node protocol-guide.mjs klima prepare retire --from 0xYOU --class 0x.. --credit 0x.. --tonnes 0.01 --beneficiary-name "your text"
```

**Which entry it uses, and why.** The program uses the entry in Klima's own usage note: you approve the asset manager for kVCM, then call `retireCreditViaKlima` on the retirement aggregator. We simulated it against live Base and it spent exactly Klima's quote. We also simulated the settlement contract's `retireWithFee`: it works too, but it adds a fee on top of the quote, and its contract is not in Klima's published code. So the program does not use it. One more thing we saw: if you approve the aggregator instead of the asset manager, the call reverts with an allowance error that names the asset manager as the spender.

**Two runs.** First run: if you have not approved the asset manager for enough kVCM, the program prints one approval for exactly the most the retirement may spend (Klima's quote plus `--slippage-bps`, 100 by default, at most 500), and stops. Send it, wait, run the same command again, and it prints the retirement.

**What it checks before it prints anything.** The class must be on Klima's live list. The class's own registry must hold the credit and the token id. The tonnes must be from 0.001 (Klima's smallest retirement) to 0.1. The most the call may spend must be at most 100 kVCM, a starter cap. You must hold that much kVCM. Klima must quote exactly the tonnes you asked for. Then the program simulates the call as your address and prints it only if it passes.

**What goes onchain.** Your `--beneficiary-name` is written with the retirement as the retiring entity and the beneficiary name, and your own address is the beneficiary address. The message is empty. It is public and permanent, so write something you are happy to have public.

**What it costs.** The kVCM the retirement spends, which is Klima's quote at the moment it lands, plus gas. The retirement cannot be undone. That is the point of it. If the call reverts, you lose gas only.

### 3. Take back the leftover approval

```
node protocol-guide.mjs klima prepare revoke --from 0xYOU
```

Klima spends the quote, not the maximum. The unspent part of your approval stays on the asset manager, which Klima's admin Safe can upgrade. This act prints one transaction that sets it back to zero, and exits with code 10 when there is nothing to revoke.

## What it costs, in one place

- kVCM: Klima's quote for the tonnes you name. In simulation there was no fee on top of it on this entry.
- Gas on Base.
- Nothing else leaves your wallet.

## The risks, in plain words

- A retirement is permanent and public, with your text attached.
- Klima's admin Safe can upgrade or pause these contracts (above). A pause costs you gas. An upgrade could change what the contracts do with an approval, which is why the approval is exact and you can revoke it.
- Classes are priced very differently per tonne. Read the quote.
- This guide does not judge credit quality, and it does not say whether a retirement counts toward any claim you may want to make. That is your call.
- kVCM is a token. Its market price can go down. Nothing here says otherwise.
- A quote and a simulation are not promises. Klima can change the list and the price between your read and your send.

## Left for later (guide text only, the program exits with code 2)

- **Staking and locks.** Staking kVCM, K2 or LP tokens goes through the staking manager and the zkMe check above. Not prepared.
- **Swapping carbon credits in for kVCM.** The asset manager has `swapCarbonCreditForKvcm`, which takes a credit you hold and mints kVCM to a recipient you name. It needs the class and credit right and it changes the supply. Not prepared.
- **Hydrex's conduit.** An outside party publishes a Hydrex conduit on Base: github.com/leo-klima-agents/hydrex-conduit (MIT, version 2 at `0x692c323B425A9DfeebE302F56168a7798D93EAC5`, deployed 2026-10-20). Its README says a veHYDX holder opts a lock in with `setConduitApproval` on the veHYDX contract, which hands that lock's votes to the conduit from the next epoch and lets the conduit claim the lock's rewards. Anyone can tell the conduit how to vote, and it only accepts a vote it expects to earn the delegators at least one dollar more in bribes. Anyone can claim a delegator's rewards through it: the lock's owner is paid and 1 percent goes to a fixed treasury. The README says it has no owner and no upgrade path. We read its README and its file list. We found no retire function and no keeper in it, and we could not confirm a link to Klima DAO. This program does not call it and does not prepare a delegation. Read its code first. [GitHub, read 2026-11-16; `verify klima` checks the address has code]

## Verify each act on a public explorer

- A retirement: `https://basescan.org/tx/<hash>`. Look for the kVCM transfer out of your wallet and the retirement event on the aggregator, which names your beneficiary text, the credit and the tonnes.
- An approval: your allowance, with `klima balances --address 0xYOU`.

## What EcoWealth holds, disclosed

EcoWealth's wallet holds some kVCM and a share of a Hydrex vault that holds kVCM against USDC (public reads, 2026-11-16), so it gains if kVCM rises. This program prepares your own retirement from your own wallet. It never touches ours, and nothing here asks you to send anything to us.

## What this program does and does not do

It reads, it prepares the exact approval, the retirement and the revoke as unsigned Base transactions, and it simulates each as your address first. It holds no key, signs nothing and sends nothing. Staking, locks, swapping credits in for kVCM and delegating to a conduit it does not prepare. An unknown request exits with code 2.
