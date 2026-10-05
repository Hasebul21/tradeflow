"use client";

import { Tooltip } from "antd";

const SHORT: Record<string, string> = {
  "Pharmaceuticals & Chemicals": "Pharma",
  Telecommunication: "Telecom",
  "Food & Allied": "Food",
};

/** A sector name short enough for a table column, with the full name on hover and for screen readers. */
export function SectorLabel({ sector }: { sector: string | null | undefined }) {
  if (!sector) return <span className="muted">—</span>;
  const short = SHORT[sector];
  if (!short) return <span>{sector}</span>;
  return (
    <Tooltip title={sector}>
      <span aria-label={sector} tabIndex={0}>
        {short}
      </span>
    </Tooltip>
  );
}
