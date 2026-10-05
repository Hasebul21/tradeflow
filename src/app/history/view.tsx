"use client";

import { Card, Col, Row, Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { formatShares, money, shortDate } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { Signed } from "@/components/ui/signed";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/states";
import { numeric, pageIf } from "@/components/ui/table-helpers";
import type { DividendView } from "@/lib/corporate-actions";
import type { PortfolioView } from "@/lib/portfolio-view";

export type SellRow = {
  id: string;
  created_at: string;
  symbol: string;
  account_type: string;
  quantity: number;
  price: number;
  fees: number;
  avgCost: number | null;
  pnl: number | null;
};

export function HistoryView({
  asOf,
  sells,
  realized,
  dividends,
  dividendIncome,
  bonus,
}: {
  asOf: string | null;
  sells: SellRow[];
  realized: number;
  dividends: DividendView[];
  dividendIncome: number;
  bonus: PortfolioView["bonusShares"];
}) {
  const sellColumns: TableColumnsType<SellRow> = [
    { title: "Date", dataIndex: "created_at", render: (d: string) => shortDate(d) },
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <strong>{s}</strong> },
    { title: "Account", dataIndex: "account_type", render: (a: string) => (a === "trade" ? "Trade" : "Long-term") },
    { title: "Shares sold", dataIndex: "quantity", ...numeric, render: (n: number) => formatShares(n) },
    { title: "Sell price", dataIndex: "price", ...numeric, render: (n: number) => money(n) },
    { title: "Avg cost then", dataIndex: "avgCost", ...numeric, render: (n: number | null) => money(n) },
    { title: "Fees", dataIndex: "fees", ...numeric, render: (n: number) => money(n) },
    { title: "Realised P/L", dataIndex: "pnl", ...numeric, render: (n: number | null) => <Signed value={n} /> },
  ];
  const dividendColumns: TableColumnsType<DividendView> = [
    { title: "Paid on", dataIndex: "paid_on", render: (d: string) => shortDate(d) },
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <strong>{s}</strong> },
    { title: "Record date", dataIndex: "record_date", render: (d: string) => shortDate(d) },
    { title: "Shares then", dataIndex: "shares", ...numeric, render: (n: number) => formatShares(n) },
    { title: "Per share", dataIndex: "cash_per_share_bdt", ...numeric, render: (n: number) => money(n) },
    { title: "Amount", dataIndex: "amountBdt", ...numeric, render: (n: number) => money(n) },
    { title: "Status", dataIndex: "paid", render: (p: boolean) => (p ? <Tag color="green">paid</Tag> : <Tag>to come</Tag>) },
  ];
  const bonusColumns: TableColumnsType<PortfolioView["bonusShares"][number]> = [
    { title: "Credited on", dataIndex: "credited_on", render: (d: string) => shortDate(d) },
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <strong>{s}</strong> },
    { title: "Bonus shares", dataIndex: "shares", ...numeric, render: (n: number) => formatShares(n) },
  ];

  return (
    <div className="stack">
      <PageHeader title="History" purpose="Every sell with its realised profit or loss, and every dividend and bonus issue." asOf={asOf} />
      <Row gutter={[12, 12]}>
        <Col xs={24} sm={8}>
          <StatCard title="Realised P/L" value={<Signed value={realized} />} hint="Net of both commissions" />
        </Col>
        <Col xs={24} sm={8}>
          <StatCard title="Dividend income" value={money(dividendIncome)} hint="Cash dividends paid so far" />
        </Col>
        <Col xs={24} sm={8}>
          <StatCard title="Bonus shares" value={formatShares(bonus.reduce((s, b) => s + b.shares, 0))} hint="Credited at zero cost" />
        </Col>
      </Row>
      <Card title={`Sells (${sells.length})`}>
        <DataTable rowKey="id" size="small" columns={sellColumns} dataSource={sells} pagination={pageIf(sells.length)} sticky locale={{ emptyText: <EmptyState message="No sells yet." /> }} />
      </Card>
      <Card title="Cash dividends" extra={<span className="muted">For the shares held on the record date</span>}>
        <DataTable rowKey="actionId" size="small" columns={dividendColumns} dataSource={dividends} pagination={false} locale={{ emptyText: <EmptyState message="No dividends yet." /> }} />
      </Card>
      <Card title="Bonus issues" extra={<span className="muted">Added as zero-cost buys, so the average cost falls</span>}>
        <DataTable rowKey={(b) => `${b.symbol}-${b.credited_on}`} size="small" columns={bonusColumns} dataSource={bonus} pagination={false} locale={{ emptyText: <EmptyState message="No bonus shares yet." /> }} />
      </Card>
    </div>
  );
}
