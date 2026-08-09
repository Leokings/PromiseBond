import { PromiseBondWalletProvider } from "../../../providers/PromiseBondWalletProvider";
import { PromiseBondRoutes } from "./PromiseBondRoutes";

export function PromiseBondApp() {
  return (
    <PromiseBondWalletProvider>
      <PromiseBondRoutes />
    </PromiseBondWalletProvider>
  );
}
