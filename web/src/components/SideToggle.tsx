"use client";

import { SIDE_NO, SIDE_YES, type Side } from "@/lib/math";

/** The Yes / No choice, as a radio group. Optional prices sit beside each outcome. */
export function SideToggle({
  legend,
  name,
  side,
  onChange,
  yesPrice,
  noPrice,
  compact = false,
}: {
  legend: string;
  name: string;
  side: Side;
  onChange: (s: Side) => void;
  yesPrice?: string;
  noPrice?: string;
  compact?: boolean;
}) {
  return (
    <div className="min-w-0">
      <span id={`${name}-legend`} className={compact ? "sr-only" : "label"}>
        {legend}
      </span>
      <div className={`seg ${compact ? "w-[168px]" : ""}`} role="radiogroup" aria-labelledby={`${name}-legend`}>
        <label className="seg-item" data-tone="yes">
          <input type="radio" name={name} checked={side === SIDE_YES} onChange={() => onChange(SIDE_YES)} />
          Yes
          {yesPrice ? <span className="num font-medium">{yesPrice}</span> : null}
        </label>
        <label className="seg-item" data-tone="no">
          <input type="radio" name={name} checked={side === SIDE_NO} onChange={() => onChange(SIDE_NO)} />
          No
          {noPrice ? <span className="num font-medium">{noPrice}</span> : null}
        </label>
      </div>
    </div>
  );
}
