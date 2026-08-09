/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROMISEBOND_GENLAYER_CHAIN_ID?: string;
  readonly VITE_PROMISEBOND_GENLAYER_EXPLORER_URL?: string;
  readonly VITE_PROMISEBOND_GENLAYER_FAUCET_URL?: string;
  readonly VITE_PROMISEBOND_GENLAYER_NETWORK?: string;
  readonly VITE_PROMISEBOND_GENLAYER_RPC_URL?: string;
  readonly VITE_PROMISEBOND_WALLET_RPC_URL?: string;
  readonly VITE_PROMISEBOND_NATIVE_ASSET_DECIMALS?: string;
  readonly VITE_PROMISEBOND_NATIVE_ASSET_SYMBOL?: string;
  readonly VITE_PROMISEBOND_WALLETCONNECT_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
