import { useEffect, useRef, useState } from "react";
import { PublicHomePage } from "../../home/components/PublicHomePage";
import { HowItWorksPage } from "./HowItWorksPage";

const HOW_IT_WORKS_PATH = "/how-it-works";
const SUPPORTED_PATHS = new Set(["/", HOW_IT_WORKS_PATH]);

type PromiseBondRoute = {
  hash: string;
  key: string;
  pathname: "/" | typeof HOW_IT_WORKS_PATH;
};

function routeFromLocation(): PromiseBondRoute {
  const pathname = window.location.pathname === HOW_IT_WORKS_PATH ? HOW_IT_WORKS_PATH : "/";
  return {
    hash: window.location.hash,
    key: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    pathname
  };
}

export function PromiseBondRoutes() {
  const [route, setRoute] = useState<PromiseBondRoute>(routeFromLocation);
  const mounted = useRef(false);

  useEffect(() => {
    function syncRoute() {
      setRoute(routeFromLocation());
    }

    window.addEventListener("popstate", syncRoute);
    return () => window.removeEventListener("popstate", syncRoute);
  }, []);

  useEffect(() => {
    function navigateWithinPromiseBond(event: MouseEvent) {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
      ) return;

      const target = event.target instanceof Element ? event.target.closest("a") : null;
      const href = target?.getAttribute("href");
      if (!target || !href || target.target || target.hasAttribute("download")) return;

      const nextUrl = new URL(href, window.location.href);
      if (nextUrl.origin !== window.location.origin || !SUPPORTED_PATHS.has(nextUrl.pathname)) return;

      event.preventDefault();
      window.history.pushState(null, "", `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`);
      setRoute(routeFromLocation());
    }

    document.addEventListener("click", navigateWithinPromiseBond);
    return () => document.removeEventListener("click", navigateWithinPromiseBond);
  }, []);

  useEffect(() => {
    document.title = route.pathname === HOW_IT_WORKS_PATH
      ? "How PromiseBond works"
      : "PromiseBond — Commit with conviction";

    const initialRender = !mounted.current;
    mounted.current = true;

    window.requestAnimationFrame(() => {
      const target = route.hash ? document.getElementById(route.hash.slice(1)) : null;
      if (target) target.scrollIntoView({ block: "start" });
      else window.scrollTo({ left: 0, top: 0 });

      const heading = target?.querySelector("h1, h2")
        ?? (!initialRender ? document.querySelector("h1") : null);
      if (heading instanceof HTMLElement) heading.focus({ preventScroll: true });
    });
  }, [route.hash, route.key, route.pathname]);

  return route.pathname === HOW_IT_WORKS_PATH
    ? <HowItWorksPage />
    : <PublicHomePage currentPage={route.hash === "#bond-feed" ? "my-bonds" : "open-bond"} />;
}
