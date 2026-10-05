"use client";

import { ArrowDownOutlined, ArrowUpOutlined } from "@ant-design/icons";
import { money, pct, pts, signedMoney } from "@/components/format";

type Kind = "money" | "pct" | "pts";

const TEXT: Record<Kind, (n: number) => string> = { money: signedMoney, pct, pts };

/**
 * A gain or a loss: an arrow, a sign and a colour together, so the meaning
 * never rests on colour alone. Zero and unknown values get neither.
 */
export function Signed({ value, kind = "money" }: { value: number | null | undefined; kind?: Kind }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="muted">—</span>;
  const shown = TEXT[kind](value);
  const rounded = kind === "money" ? Math.round(value * 100) / 100 : Math.round(value * 10) / 10;
  if (rounded === 0) return <span className="num">{kind === "money" ? money(0) : shown}</span>;
  const up = rounded > 0;
  return (
    <span className={`num signed ${up ? "up" : "down"}`}>
      {up ? <ArrowUpOutlined aria-hidden /> : <ArrowDownOutlined aria-hidden />}
      {"\u00a0"}
      {shown}
      <span className="sr-only">{up ? " (up)" : " (down)"}</span>
    </span>
  );
}
