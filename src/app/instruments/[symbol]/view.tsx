"use client";

import { Card, Col, Descriptions, Row, Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { WrapText } from "@/components/ui/wrap-text";
import { formatShares, money, plainPct, shortDate } from "@/components/format";
import { AnnouncementTable } from "@/components/ui/announcement-table";
import { PageHeader } from "@/components/ui/page-header";
import { Signed } from "@/components/ui/signed";
import { EmptyState } from "@/components/ui/states";
import { numeric } from "@/components/ui/table-helpers";
import type { Fundamental } from "@/lib/data-types";
import type { InstrumentView } from "@/lib/instrument-view";

export function InstrumentPanel({ v, range }: { v: InstrumentView; range: { first: string; last: string } | null }) {
  const f = v.fundamentals;
  const h = v.holding;
  const quarterColumns: TableColumnsType<Fundamental> = [
    { title: "Quarter to", dataIndex: "period_end", render: (d: string) => shortDate(d) },
    { title: "Reported", dataIndex: "reported_on", render: (d: string) => shortDate(d) },
    { title: "EPS", dataIndex: "eps_bdt", ...numeric, render: (n: number) => money(n) },
    { title: "NAV per share", dataIndex: "nav_per_share_bdt", ...numeric, render: (n: number) => money(n) },
    { title: "Revenue (Tk mn)", dataIndex: "revenue_mn_bdt", ...numeric, render: (n: number) => money(n) },
    { title: "Net profit (Tk mn)", dataIndex: "net_profit_mn_bdt", ...numeric, render: (n: number) => money(n) },
  ];
  const journalColumns: TableColumnsType<InstrumentView["journal"][number]> = [
    { title: "Trade", key: "trade", render: (_: unknown, e) => <span><Tag color={e.side === "buy" ? "green" : "volcano"}>{e.side}</Tag>{shortDate(e.trade_date)}, {formatShares(e.quantity)} at {money(e.price)}</span> },
    { title: "Thesis", dataIndex: "thesis", className: "cell-wrap", render: (t: string) => <WrapText width={300}>{t}</WrapText> },
    { title: "Horizon", dataIndex: "horizon" },
    { title: "Exit condition", dataIndex: "exit_condition", className: "cell-wrap", render: (x: string | null) => <WrapText width={200}>{x ?? "—"}</WrapText> },
  ];
  const vsSector = v.weekChangePct !== null && v.sectorWeekChangePct !== null ? v.weekChangePct - v.sectorWeekChangePct : null;

  return (
    <div className="stack">
      <PageHeader
        title={`${v.instrument.symbol}: ${v.instrument.name}`}
        purpose="One company: its price against its sector, your holding, its reported quarters, its announcements and your journal notes."
        asOf={v.asOf}
        range={range ?? undefined}
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card title="Price and holding" style={{ height: "100%" }}>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: "sector", label: "Sector", children: v.instrument.sector },
                { key: "ltp", label: "Last price", children: <span className="num">{money(v.quote?.ltp)}</span> },
                { key: "day", label: "Day", children: <Signed value={v.quote?.dayChangePct} kind="pct" /> },
                { key: "week", label: "Week", children: <Signed value={v.weekChangePct} kind="pct" /> },
                { key: "sectorWeek", label: "Sector index, week", children: <Signed value={v.sectorWeekChangePct} kind="pct" /> },
                { key: "vs", label: "Stock less sector", children: <Signed value={vsSector} kind="pts" /> },
                { key: "held", label: "Shares held", children: h ? <span className="num">{formatShares(h.shares)}</span> : "None" },
                ...(h
                  ? [
                      { key: "avg", label: "Average cost", children: <span className="num">{money(h.avgPrice)}</span> },
                      { key: "weight", label: "Weight", children: <span className="num">{plainPct(h.weightPct)}</span> },
                      { key: "pl", label: "Unrealised P/L", children: <Signed value={h.unrealizedPl} /> },
                    ]
                  : []),
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="Fundamentals (synthetic)" style={{ height: "100%" }}>
            <Descriptions
              column={1}
              size="small"
              items={[
                { key: "latest", label: "Latest quarter", children: f.latest ? `to ${shortDate(f.latest.period_end)}, reported ${shortDate(f.latest.reported_on)}` : "None reported yet" },
                { key: "eps", label: "EPS, latest quarter", children: <span className="num">{money(f.latest?.eps_bdt)}</span> },
                { key: "epsq", label: "EPS against the quarter before", children: <Signed value={f.epsChangePct} kind="pct" /> },
                { key: "profit", label: "Net profit against the quarter before", children: <Signed value={f.netProfitChangePct} kind="pct" /> },
                { key: "pe", label: "Trailing P/E", children: <span className="num">{f.trailingPe === null ? "—" : f.trailingPe.toFixed(1)}</span> },
                {
                  key: "basis",
                  label: "P/E basis",
                  children: f.peBasis === "trailing_4_quarters" ? "sum of the last 4 quarters" : f.peBasis === "annualised" ? `${f.quarters.length} quarters scaled to a year` : "—",
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
      <Card title="Reported quarters">
        <DataTable rowKey="period_end" size="small" columns={quarterColumns} dataSource={f.quarters} pagination={false} locale={{ emptyText: <EmptyState message="No quarter reported by this date." /> }} />
      </Card>
      {v.actions.length > 0 ? (
        <Card title="Dividends and bonus issues">
          <Descriptions
            column={1}
            size="small"
            items={v.actions.map((a) => ({
              key: a.id,
              label: `Record date ${shortDate(a.record_date)}`,
              children: a.kind === "cash_dividend" ? `Cash dividend of ${money(a.cash_per_share_bdt)} per share, paid ${shortDate(a.paid_on)}` : `Bonus shares: ${Math.round((a.bonus_ratio ?? 0) * 100)} for every 100, credited ${shortDate(a.paid_on)}`,
            }))}
          />
        </Card>
      ) : null}
      <Card title={`Announcements (${v.announcements.length})`}>
        <AnnouncementTable rows={v.announcements} showSymbol={false} />
      </Card>
      <Card title={`Your journal (${v.journal.length})`}>
        <DataTable rowKey="id" size="small" columns={journalColumns} dataSource={v.journal} pagination={false} locale={{ emptyText: <EmptyState message="No journal entries for this symbol." /> }} />
      </Card>
    </div>
  );
}
