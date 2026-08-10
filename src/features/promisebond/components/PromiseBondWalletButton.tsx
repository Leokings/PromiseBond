import { LogOut, RotateCw, Wallet, X } from "lucide-react";
import { useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { promiseBondChain } from "../../../providers/PromiseBondWalletProvider";
import { useModalDialog } from "./useModalDialog";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function PromiseBondWalletButton() {
  const account = useAccount();
  const connectState = useConnect();
  const disconnectState = useDisconnect();
  const switchState = useSwitchChain();
  const [open, setOpen] = useState(false);
  const walletReady = account.status === "connected";
  const wrongNetwork = walletReady && account.chainId !== promiseBondChain.id;
  const dialogRef = useModalDialog(open, () => setOpen(false));

  function disconnect() {
    disconnectState.disconnect();
    setOpen(false);
  }

  return (
    <>
      <button
        className={`wallet-button ${walletReady ? "account" : ""} ${wrongNetwork ? "warning" : ""}`}
        onClick={() => setOpen(true)}
        type="button"
      >
        {wrongNetwork ? <RotateCw size={17} /> : <Wallet size={17} />}
        <span>
          {wrongNetwork
            ? "Switch network"
            : account.isReconnecting
              ? "Restoring wallet…"
            : account.address
              ? shortAddress(account.address)
              : "Connect wallet"}
        </span>
      </button>

      {open ? (
        <div className="pb-wallet-scrim" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setOpen(false);
        }} role="presentation">
          <section
            aria-labelledby="wallet-dialog-title"
            aria-modal="true"
            className="pb-wallet-modal"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div>
                <span>SELF-CUSTODIAL ACCESS</span>
                <h2 id="wallet-dialog-title">{walletReady ? "Wallet connected" : account.isReconnecting ? "Restoring wallet" : "Choose a wallet"}</h2>
              </div>
              <button aria-label="Close wallet dialog" onClick={() => setOpen(false)} type="button"><X size={18} /></button>
            </header>

            <div className="pb-wallet-content">
              {walletReady ? (
                <>
                  <div className="pb-wallet-account">
                    <span>CONNECTED ADDRESS</span>
                    <strong>{account.address}</strong>
                  </div>
                  {wrongNetwork ? (
                    <button
                      className="pb-button primary"
                      disabled={switchState.isPending}
                      onClick={() => switchState.switchChain({ chainId: promiseBondChain.id })}
                      type="button"
                    >
                      <RotateCw size={16} /> {switchState.isPending ? "Switching…" : "Switch to GenLayer Bradbury"}
                    </button>
                  ) : (
                    <div className="pb-wallet-network">
                      <i /> GenLayer Bradbury / {promiseBondChain.id} · {promiseBondChain.nativeCurrency.symbol}
                    </div>
                  )}
                  <button className="pb-button quiet" onClick={disconnect} type="button">
                    <LogOut size={16} /> Disconnect
                  </button>
                </>
              ) : account.isReconnecting ? (
                <div className="pb-wallet-network">
                  <i /> Restoring the previously connected wallet. Transaction actions remain disabled until it is ready.
                </div>
              ) : (
                <div className="pb-wallet-options">
                  {connectState.connectors.map((connector) => (
                    <button
                      disabled={connectState.isPending}
                      key={connector.uid}
                      onClick={() => connectState.connect({ chainId: promiseBondChain.id, connector }, { onSuccess: () => setOpen(false) })}
                      type="button"
                    >
                      <Wallet size={17} />
                      <span>{connector.name}</span>
                      <small>Bradbury · {promiseBondChain.nativeCurrency.symbol}</small>
                    </button>
                  ))}
                </div>
              )}

              {connectState.error ? <p className="pb-wallet-error" role="alert">{connectState.error.message}</p> : null}
              {switchState.error ? <p className="pb-wallet-error" role="alert">{switchState.error.message}</p> : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
