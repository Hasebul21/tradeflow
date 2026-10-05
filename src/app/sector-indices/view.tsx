"use client";

import { Card, Flex, Segmented, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { shortDate } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { Signed } from "@/components/ui/signed";
import { EmptyState } from "@/components/ui/states";
import { numeric } from "@/components/ui/table-helpers";
import type { SectorMove, sectorMovesAsOf } from "@/lib/market-views";

export function SectorIndicesView({
  moves,
  windows,
  range,
}: {
  moves: ReturnType<typeof sectorMovesAsOf>;
  windows: number[];
  range: { first: string; last: string } | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const rows = moves.dsex ? [...moves.sectors, moves.dsex] : moves.sectors;
  const columns: TableColumnsType<SectorMove> = [
    { title: "Index", dataIndex: "sector", render: (s: string) => (s === "DSEX" ? <strong>DSEX (whole market)</strong> : s) },
    { title: "From", dataIndex: "fromDate", render: (d: string) => shortDate(d) },
    { title: "Close", dataIndex: "close", ...numeric, render: (n: number) => n.toFixed(2) },
    { title: "Change", dataIndex: "changePct", ...numeric, render: (n: number) => <Signed value={n} kind="pct" /> },
    {
      title: "Against DSEX",
      key: "vs",
      ...numeric,
      render: (_: unknown, r) => (r.sector === "DSEX" || !moves.dsex ? "—" : <Signed value={r.changePct - moves.dsex.changePct} kind="pts" />),
    },
  ];
  const setSessions = (n: number) => {
    const next = new URLSearchParams(params?.toString());
    if (n === 5) next.delete("sessions");
    else next.set("sessions", String(n));
    const q = next.toString();
    router.push(q ? `${pathname}?${q}` : pathname);
  };
  return (
    <div className="stack">
      <PageHeader
        title="Sector indices"
        purpose="How each sector index (synthetic) moved over the window, largest fall first, against the whole market."
        asOf={moves.asOf}
        range={range ?? undefined}
      />
      <Card>
        <Flex gap={12} align="center" style={{ marginBottom: 12 }}>
          <span id="window-label">Window</span>
          <Segmented
            aria-labelledby="window-label"
            value={moves.sessions}
            options={windows.map((w) => ({ value: w, label: `${w} sessions` }))}
            onChange={(v) => setSessions(Number(v))}
          />
        </Flex>
        <DataTable rowKey="sector" size="small" columns={columns} dataSource={rows} pagination={false} locale={{ emptyText: <EmptyState message="No sector index data in data/sector_index_bars.json." /> }} />
      </Card>
    </div>
  );
}
