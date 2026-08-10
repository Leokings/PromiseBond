import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { testnetBradbury } from "genlayer-js/chains";
import type { ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";

const walletConnectProjectId = import.meta.env.VITE_PROMISEBOND_WALLETCONNECT_PROJECT_ID?.trim();
const genLayerRpcUrl = import.meta.env.VITE_PROMISEBOND_GENLAYER_RPC_URL?.trim()
  || testnetBradbury.rpcUrls.default.http[0];
const walletRpcUrl = import.meta.env.VITE_PROMISEBOND_WALLET_RPC_URL?.trim()
  || "https://rpc.testnet-chain.genlayer.com";
const defaultExplorer = testnetBradbury.blockExplorers?.default;
const explorerUrl = import.meta.env.VITE_PROMISEBOND_GENLAYER_EXPLORER_URL?.trim()
  || defaultExplorer?.url
  || "https://explorer-bradbury.genlayer.com/";

export const promiseBondChain = {
  ...testnetBradbury,
  blockExplorers: {
    default: {
      name: defaultExplorer?.name || "GenLayer Bradbury Explorer",
      url: explorerUrl
    }
  },
  rpcUrls: {
    default: {
      // Wallets broadcast signed EVM transactions to the underlying GenLayer Chain RPC.
      // GenLayer consensus reads use promiseBondGenLayerChain below.
      http: [walletRpcUrl]
    }
  }
} as const;

export const promiseBondGenLayerChain = {
  ...promiseBondChain,
  rpcUrls: {
    default: {
      http: [genLayerRpcUrl]
    }
  }
} as const;

const walletConnectConnector = walletConnectProjectId
  ? walletConnect({
      metadata: {
        description: "Public commitments backed by GEN and resolved on GenLayer Bradbury.",
        icons: [`${window.location.origin}/og.png`],
        name: "PromiseBond",
        url: window.location.origin
      },
      projectId: walletConnectProjectId,
      showQrModal: true
    })
  : undefined;

const connectors = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({ appName: "PromiseBond" }),
  ...(walletConnectConnector ? [walletConnectConnector] : [])
] as const;

export const promiseBondWalletConfig = createConfig({
  chains: [promiseBondChain],
  connectors,
  transports: {
    [promiseBondChain.id]: http(walletRpcUrl)
  }
});

export type PromiseBondConnectorIdentity = {
  readonly id: string;
  readonly type: string;
  readonly uid: string;
  getProvider?: (parameters?: { chainId?: number }) => Promise<unknown>;
};

function resolvePromiseBondWalletConnector(
  connector: PromiseBondConnectorIdentity,
  runtimeConnectors: readonly PromiseBondConnectorIdentity[]
) {
  if (typeof connector.getProvider === "function") return connector;

  const uidMatches = runtimeConnectors.filter(
    (candidate) => candidate.uid === connector.uid && typeof candidate.getProvider === "function"
  );
  if (uidMatches.length === 1) return uidMatches[0];
  if (uidMatches.length > 1) return undefined;

  const identityMatches = runtimeConnectors.filter(
    (candidate) => candidate.id === connector.id
      && candidate.type === connector.type
      && typeof candidate.getProvider === "function"
  );
  return identityMatches.length === 1 ? identityMatches[0] : undefined;
}

/**
 * Wagmi persists only a connector's identity fields. During hydration, `useAccount()` can
 * temporarily expose that partial object before reconnect replaces it with the live connector.
 * Resolve the current runtime connector so every wallet kind uses its actual EIP-1193 provider.
 */
export async function getPromiseBondWalletProvider(
  connector: PromiseBondConnectorIdentity,
  runtimeConnectors: readonly PromiseBondConnectorIdentity[] = promiseBondWalletConfig.connectors
) {
  const liveConnector = resolvePromiseBondWalletConnector(connector, runtimeConnectors);

  if (!liveConnector || typeof liveConnector.getProvider !== "function") {
    throw new Error("Wallet connection is still restoring. Wait for it to finish, then retry. No transaction was submitted.");
  }
  return liveConnector.getProvider({ chainId: promiseBondChain.id });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 2,
      staleTime: 10_000
    }
  }
});

export function PromiseBondWalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={promiseBondWalletConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
