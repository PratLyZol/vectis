"use client";

import { useState, type ReactNode } from "react";

type IconKind = "sports" | "crypto" | "weather" | "commodities" | "economics" | "combo" | "vault" | "market";

const PATHS: Record<IconKind, ReactNode> = {
  // trophy
  sports: (
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4Z" />
      <path d="M8 6H5a3 3 0 0 0 3 3M16 6h3a3 3 0 0 1-3 3M12 13v4M8.5 20h7M10 17h4" />
    </>
  ),
  // coin
  crypto: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M10 8.5v7M10 8.5h3a1.75 1.75 0 0 1 0 3.5h-3M10 12h3.5a1.75 1.75 0 0 1 0 3.5H10M11.5 7v1.5M11.5 15.5V17" />
    </>
  ),
  // cloud and sun
  weather: (
    <>
      <path d="M7 18h9.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.6 12.1 3 3 0 0 0 7 18Z" />
      <path d="M12 3v1.5M5.6 5.6l1.1 1.1M3 12h1.5" />
    </>
  ),
  // barrel
  commodities: (
    <>
      <path d="M7 4h10M7 20h10M7 4c-1.3 2.4-2 5-2 8s.7 5.6 2 8M17 4c1.3 2.4 2 5 2 8s-.7 5.6-2 8" />
      <path d="M5.3 9h13.4M5.3 15h13.4" />
    </>
  ),
  // bank
  economics: (
    <>
      <path d="M4 9.5 12 5l8 4.5M5 19h14M7 10v7M12 10v7M17 10v7" />
    </>
  ),
  // stacked layers
  combo: (
    <>
      <path d="m12 4 8 4-8 4-8-4 8-4Z" />
      <path d="m4 12 8 4 8-4M4 16l8 4 8-4" />
    </>
  ),
  // vault door
  vault: (
    <>
      <rect x="4" y="5" width="16" height="14" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 9V7.5M12 16.5V15M15 12h1.5M7.5 12H9" />
    </>
  ),
  // rising line
  market: (
    <>
      <path d="M4 19h16" />
      <path d="m5 15 4.5-5 3.5 3 6-7" />
      <path d="M15.5 6H19v3.5" />
    </>
  ),
};

const KIND_BY_CATEGORY: Record<string, IconKind> = {
  sports: "sports",
  crypto: "crypto",
  weather: "weather",
  commodities: "commodities",
  economics: "economics",
  combo: "combo",
  vault: "vault",
};

/**
 * Square tile for a market: Gemini's event image when there is one, otherwise a stroke icon
 * chosen from the category. The icon also stands in if the image fails to load, so the tile is
 * never empty. Decorative: the market's title is always beside it.
 */
export function IconTile({
  category,
  image,
  small = false,
  eager = false,
}: {
  category?: string;
  image?: string | null;
  small?: boolean;
  eager?: boolean; // load at once (the landing hero); other tiles load lazily
}) {
  // Remember which URL failed, so a new image gets its own chance.
  const [failed, setFailed] = useState<string | null>(null);
  const kind = KIND_BY_CATEGORY[(category ?? "").toLowerCase()] ?? "market";
  const size = small ? 40 : 44;

  if (image && failed !== image) {
    return (
      <span className={`icon-tile overflow-hidden ${small ? "icon-tile-sm" : ""}`} aria-hidden="true">
        {/* A plain img: these are small remote thumbnails and need no optimiser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image}
          alt=""
          width={size}
          height={size}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(image)}
          // An image that failed before the page became interactive never fires onError here.
          ref={(el) => {
            if (el && el.complete && el.naturalWidth === 0) setFailed(image);
          }}
        />
      </span>
    );
  }

  return (
    <span className={`icon-tile ${small ? "icon-tile-sm" : ""}`} aria-hidden="true">
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {PATHS[kind]}
      </svg>
    </span>
  );
}

/**
 * Icon tile, then two lines: the market title, and the outcome followed by its side.
 * Sits at the top of the trade panel and of each position card.
 */
export function MarketHeader({
  title,
  outcome,
  side,
  category,
  image,
  eagerImage,
  headingId,
  as: Heading = "h2",
  right,
}: {
  title: ReactNode;
  outcome: ReactNode;
  side: "yes" | "no" | null;
  category?: string;
  image?: string | null;
  eagerImage?: boolean;
  headingId?: string;
  as?: "h2" | "h3";
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <IconTile category={category} image={image} eager={eagerImage} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-muted">{title}</p>
        <Heading id={headingId} className="text-[16px] leading-snug">
          {outcome}
          {side ? (
            <span className={side === "yes" ? "text-accent" : "text-danger"}> · {side === "yes" ? "Yes" : "No"}</span>
          ) : null}
        </Heading>
      </div>
      {right ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{right}</div> : null}
    </div>
  );
}
