"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isMock } from "@/config/contracts";
import { WalletButton } from "./WalletButton";

const LINKS = [
  { href: "/markets", label: "Markets" },
  { href: "/combos", label: "Combos" },
  { href: "/replay", label: "Replay" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/vault", label: "Vault" },
  { href: "/lend", label: "Lend" },
];

export function Nav() {
  const pathname = usePathname();

  // Presentation only: tells the stylesheet whether the page is scrolled, for the bottom rule.
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const sync = () => {
      if (header.current) header.current.dataset.scrolled = window.scrollY > 4 ? "true" : "false";
    };
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, []);
  const isCurrent = (href: string) => (href === "/markets" ? pathname.startsWith("/market") : href === "/combos" ? pathname.startsWith("/combo") : pathname.startsWith(href));

  return (
    <header ref={header} data-scrolled="false" className="nav-rule sticky top-0 z-40 bg-ground">
      <div className="wrap relative flex min-h-16 flex-wrap items-center gap-x-4 pt-2 md:gap-x-6 md:pt-0">
        <a className="skip-link" href="#top">
          Skip to content
        </a>
        <Link
          href="/"
          className="flex min-h-11 items-center gap-2 text-[17px] font-medium tracking-tight text-text no-underline"
          aria-label="Vectis home"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M2 16.5h16" className="stroke-muted" strokeWidth="1.5" />
            <path d="M3 13.5 17 4.5" className="stroke-accent" strokeWidth="2" strokeLinecap="square" />
            <path d="M7 16.5 10 11l3 5.5" className="stroke-text" strokeWidth="1.5" />
          </svg>
          Vectis
        </Link>

        {isMock ? (
          <span className="chip chip-no" title="Contracts are not deployed. Positions and vault balances are simulated in this browser.">
            Demo data
          </span>
        ) : null}

        <div className="ml-auto md:order-3">
          <WalletButton />
        </div>

        <nav aria-label="Main" className="order-last -mx-3 flex w-full md:order-2 md:mx-0 md:w-auto">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-link" aria-current={isCurrent(l.href) ? "page" : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
