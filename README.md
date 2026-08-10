# PromiseBond

[![PromiseBond CI](https://github.com/Leokings/PromiseBond/actions/workflows/ci.yml/badge.svg)](https://github.com/Leokings/PromiseBond/actions/workflows/ci.yml)

Public promises backed by native GEN and resolved by GenLayer validator consensus.

[Live app](https://promisebond-alpha.vercel.app) · [Intelligent contract](contracts/PromiseBond.py) · [Finalized lifecycle proof](config/promisebond/live-validation.json)

## How it works

1. Define the promise, decision criteria, beneficiary, deadlines, and three evidence sources.
2. Deploy and fund one PromiseBond intelligent contract.
3. After the deadline, GenLayer validators resolve the bond and the contract settles it.

## Verified on Bradbury

Contract `0xd5b018f1449598a2af54b8b39d433328D32ccE79` completed deployment, `0.001 GEN` funding, and resolution with `FINALIZED / AGREE`. The outcome was `FULFILLED`. Full transaction IDs and finalized state are in the [lifecycle manifest](config/promisebond/live-validation.json).

## Run locally

Requirements: Node.js 22+, Python 3.11+, and a browser wallet configured for Bradbury.

```bash
npm install
npm run check:env
npm run dev
```

Copy `config/promisebond/.env.example` to `config/promisebond/.env.local` and add your values.

## Verify

```bash
npm run build
npm run test:server
npm run test:contract
npm run contracts:lint
```

## Project map

- `contracts/PromiseBond.py` — intelligent contract
- `src/features/promisebond/` — app and wallet flows
- `server/promisebond/` — public index and reconciliation
- `shared/promisebond/` — finalized-state verification
