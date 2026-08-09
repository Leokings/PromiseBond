import { Menu, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { PromiseBondWalletButton } from "./PromiseBondWalletButton";

export type PromiseBondPage = "open-bond" | "my-bonds" | "how-it-works";

export type PromiseBondHeaderProps = {
  currentPage: PromiseBondPage;
  homeHref?: string;
  openBondHref?: string;
  myBondsHref?: string;
  howItWorksHref?: string;
  onHome?: () => void;
  onOpenBond?: () => void;
  onMyBonds?: () => void;
  onHowItWorks?: () => void;
  walletControl?: ReactNode;
};

type NavigationLinkProps = {
  children: ReactNode;
  current: boolean;
  href: string;
  onActivate?: () => void;
  onCloseMenu: () => void;
};

function NavigationLink({
  children,
  current,
  href,
  onActivate,
  onCloseMenu
}: NavigationLinkProps) {
  function activate(event: MouseEvent<HTMLAnchorElement>) {
    onCloseMenu();
    if (!onActivate) return;

    event.preventDefault();
    onActivate();
  }

  return (
    <a aria-current={current ? "page" : undefined} href={href} onClick={activate}>
      {children}
    </a>
  );
}

export function PromiseBondHeader({
  currentPage,
  homeHref = "/",
  openBondHref = "/#create-bond",
  myBondsHref = "/#bond-feed",
  howItWorksHref = "/how-it-works",
  onHome,
  onOpenBond,
  onMyBonds,
  onHowItWorks,
  walletControl
}: PromiseBondHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigationId = useId();
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen]);

  function closeMenu() {
    setMenuOpen(false);
  }

  function activateHome(event: MouseEvent<HTMLAnchorElement>) {
    closeMenu();
    if (!onHome) return;

    event.preventDefault();
    onHome();
  }

  const wallet = walletControl ?? <PromiseBondWalletButton />;

  return (
    <header className="pb-nav" id="top">
      <a
        aria-label="PromiseBond home"
        className="pb-brand"
        href={homeHref}
        onClick={activateHome}
      >
        <span aria-hidden="true" className="pb-brand-mark"><span>P</span><i /></span>
        <span>promisebond</span>
      </a>

      <button
        aria-controls={navigationId}
        aria-expanded={menuOpen}
        aria-label={menuOpen ? "Close navigation" : "Open navigation"}
        className="pb-menu-toggle"
        onClick={() => setMenuOpen((open) => !open)}
        ref={menuButtonRef}
        type="button"
      >
        {menuOpen ? <X aria-hidden="true" size={19} /> : <Menu aria-hidden="true" size={20} />}
      </button>

      <nav
        aria-label="PromiseBond navigation"
        className={menuOpen ? "open" : ""}
        id={navigationId}
      >
        <NavigationLink
          current={currentPage === "open-bond"}
          href={openBondHref}
          onActivate={onOpenBond}
          onCloseMenu={closeMenu}
        >
          OPEN A BOND
        </NavigationLink>
        <NavigationLink
          current={currentPage === "my-bonds"}
          href={myBondsHref}
          onActivate={onMyBonds}
          onCloseMenu={closeMenu}
        >
          MY BONDS
        </NavigationLink>
        <NavigationLink
          current={currentPage === "how-it-works"}
          href={howItWorksHref}
          onActivate={onHowItWorks}
          onCloseMenu={closeMenu}
        >
          HOW IT WORKS
        </NavigationLink>
        <div className="pb-mobile-wallet">{wallet}</div>
      </nav>

      <div className="pb-nav-status">
        <span aria-hidden="true" className="pb-status-dot" />
        <span>BRADBURY / 4221</span>
        {wallet}
      </div>
    </header>
  );
}
