# PromiseBond

[![PromiseBond CI](https://github.com/Leokings/PromiseBond/actions/workflows/ci.yml/badge.svg)](https://github.com/Leokings/PromiseBond/actions/workflows/ci.yml)

PromiseBond turns a public promise into a financially backed commitment. A creator defines verifiable terms, locks native GEN in a GenLayer intelligent contract, and names a beneficiary. After the deadline, GenLayer validators evaluate the approved evidence and the contract settles the bond.

**Live app:** [promisebond-alpha.vercel.app](https://promisebond-alpha.vercel.app)

## How it works

1. The creator defines the promise, success and failure criteria, evidence URLs, beneficiary, deadlines, and GEN amount.
2. The app deploys one PromiseBond intelligent contract and funds it with the exact amount.
3. After the resolution deadline, GenLayer validators inspect the approved evidence.
4. Fulfilled promises return the bond to the creator; failed promises queue payment to the beneficiary; unresolved evidence follows the contract's refund policy.

Custody, resolution, and settlement all happen on GenLayer. MongoDB is used only as an advisory public index and recovery layer; finalized GenLayer state remains authoritative.

## Finalized lifecycle proof

- Network: GenLayer Bradbury (chain `4221`)
- Contract: `0xd5b018f1449598a2af54b8b39d433328D32ccE79`
- Lifecycle: deployment, `0.001 GEN` funding, and resolution all finalized with `AGREE / FINISHED_WITH_RETURN`
- Finalized outcome: `FULFILLED`; settlement state: `PAYOUT_QUEUED` to the creator
- Finalized contract state: `0` locked and `0` contract balance after all three approved sources matched
- Evidence record: [`config/promisebond/live-validation.json`](config/promisebond/live-validation.json)

The record proves the finalized contract state and queued payout. It does not independently assert that the recipient's wallet balance was credited.

## Run locally

Requirements: Node.js 22+, Python 3.11+, and a browser wallet configured for Bradbury.

```bash
npm install
npm run check:env
npm run dev
```

Copy `config/promisebond/.env.example` to `config/promisebond/.env.local` and supply your own isolated values. Never commit that file.

## Verify

```bash
npm run build
npm run test:server
npm run test:contract
npm run contracts:lint
```

Direct contract tests cover the state machine and authorization logic. Real-network verification is still required for native transfer delivery because direct-mode tests do not execute GenLayer's finalized external transfer lifecycle.

## Architecture

- `contracts/PromiseBond.py` — native-GEN intelligent contract
- `src/features/promisebond/` — wallet, deployment, funding, reconciliation, and lifecycle UI
- `shared/promisebond/` — strict Bradbury receipt and state verification
- `server/promisebond/` — Mongo-backed public index and reconciliation worker
- `api/promisebond.js` — Vercel serverless adapter

## Deployment

The repository includes an isolated `vercel.json`. A deployment needs a dedicated PromiseBond MongoDB credential, Bradbury RPC configuration, and matching cron secrets. The deployed frontend and API are intentionally isolated from other projects.

## Current scope

PromiseBond currently runs on GenLayer Bradbury using native GEN. The public deployment is production-capable software operating on the Bradbury network; it is not a mainnet financial product.
