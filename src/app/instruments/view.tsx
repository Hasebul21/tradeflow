"use client";

import { Card, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { SectorLabel } from "@/components/ui/sector-label";
import Link from "next/link";
import { formatShares, money } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { Signed } from "@/components/ui/signed";
import { EmptyState } from "@/components/ui/states";
import { numeric } from "@/components/ui/table-helpers";
import type { InstrumentRow } from "@/lib/instrument-view";

export function InstrumentsView({ rows, asOf, range }: { rows: InstrumentRow[]; asOf: string; range: { first: string; last: string } | null }) {
  const columns: TableColumnsType<InstrumentRow> = [
    {
      title: "Symbol",
      dataIndex: "symbol",
      render: (s: string, r) => (
        <div>
          <Link href={`/instruments/${s}${asOf === range?.last ? "" : `?as_of=${asOf}`}`}>
            <strong>{s}</strong>
          </Link>
          <div className="muted sub-name">
            {r.name}
          </div>
        </div>
      ),
    },
    { title: "Sector", dataIndex: "sector", render: (s: string) => <SectorLabel sector={s} /> },
    { title: "Last price", dataIndex: "ltp", ...numeric, render: (n: number | null) => money(n) },
    { title: "Week", dataIndex: "weekChangePct", ...numeric, render: (n: number | null) => <Signed value={n} kind="pct" /> },
    { title: "Shares held", dataIndex: "sharesHeld", ...numeric, render: (n: number) => (n ? formatShares(n) : "—") },
    { title: "Latest quarterly EPS", dataIndex: "latestEps", ...numeric, render: (n: number | null) => money(n) },
    { title: "Trailing P/E", dataIndex: "trailingPe", ...numeric, render: (n: number | null) => (n === null ? "—" : n.toFixed(1)) },
  ];
  return (
    <div className="stack">
      <PageHeader title="Instruments" purpose="Every symbol in the data, with its price, your holding and its reported earnings. Open one for the full panel." asOf={asOf} range={range ?? undefined} />
      <Card>
        <DataTable rowKey="symbol" size="small" columns={columns} dataSource={rows} pagination={false} sticky locale={{ emptyText: <EmptyState message="No instruments in data/instruments.json." /> }} />
      </Card>
    </div>
  );
}
