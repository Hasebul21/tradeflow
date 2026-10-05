"use client";

import { Card, Col, Row, Tag, Typography, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { SectorLabel } from "@/components/ui/sector-label";
import Link from "next/link";
import { formatShares, money, pct, plainPct, pts, shortDate } from "@/components/format";
import { Findings } from "@/components/ui/findings";
import { PageHeader } from "@/components/ui/page-header";
import { Signed } from "@/components/ui/signed";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/states";
import { numeric, pageIf } from "@/components/ui/table-helpers";
import type { Attribution, HoldingContribution } from "@/lib/attribution";
import type { HoldingView, PortfolioView } from "@/lib/portfolio-view";

function MovedTable({ a }: { a: Attribution }) {
  const columns: TableColumnsType<HoldingContribution> = [
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <Link href={`/instruments/${s}`}>{s}</Link> },
    { title: "Sector", dataIndex: "sector", render: (s: string) => <SectorLabel sector={s} /> },
    { title: "Stock", dataIndex: "changePct", ...numeric, render: (v: number) => <Signed value={v} kind="pct" /> },
    { title: "Its sector", dataIndex: "sectorChangePct", ...numeric, render: (v: number | null) => <Signed value={v} kind="pct" /> },
    { title: "Stock less sector", dataIndex: "versusSectorPts", ...numeric, render: (v: number | null) => <Signed value={v} kind="pts" /> },
    {
      title: "Compared with sector",
      dataIndex: "comparison",
      render: (c: HoldingContribution["comparison"]) =>
        c === null ? <span className="muted">no sector index</span> : <Tag color={c === "stock-specific" ? "volcano" : "green"}>{c}</Tag>,
    },
    { title: "Contribution", dataIndex: "contributionBdt", ...numeric, render: (v: number) => <Signed value={v} /> },
    { title: "Of the portfolio", dataIndex: "contributionPts", ...numeric, render: (v: number) => <Signed value={v} kind="pts" /> },
  ];
  return (
    <Card
      title="What moved the portfolio this week"
      extra={<Typography.Text type="secondary">{a.fromDate ? `${shortDate(a.fromDate)} to ${shortDate(a.toDate)}` : null}</Typography.Text>}
    >
      <Typography.Paragraph>
        The portfolio moved <Signed value={a.changePct} kind="pct" /> (<Signed value={a.changeBdt} />) and DSEX{" "}
        <Signed value={a.indexChangePct} kind="pct" />, a difference of <Signed value={a.differencePts} kind="pts" />. Largest fall first.
        A stock is &ldquo;in line with sector&rdquo; when it moved within 2 points of its sector index; this is arithmetic, not a reason.
      </Typography.Paragraph>
      <DataTable
        rowKey="symbol"
        size="small"
        columns={columns}
        dataSource={a.holdings}
        pagination={false}
        sticky
        locale={{ emptyText: <EmptyState message="No holding has five sessions of prices yet." /> }}
      />
    </Card>
  );
}

function HoldingsTable({ rows }: { rows: HoldingView[] }) {
  const columns: TableColumnsType<HoldingView> = [
    {
      title: "Symbol",
      dataIndex: "symbol",
      render: (s: string, h) => (
        <div>
          <Link href={`/instruments/${s}`}>
            <strong>{s}</strong>
          </Link>
          {h.name ? <div className="muted sub-name">{h.name}</div> : null}
        </div>
      ),
    },
    { title: "Sector", dataIndex: "sector", render: (s: string | null) => <SectorLabel sector={s} /> },
    { title: "Shares", dataIndex: "shares", ...numeric, render: (n: number) => formatShares(n) },
    { title: "Avg cost", dataIndex: "avgPrice", ...numeric, render: (n: number) => money(n) },
    { title: "Break-even", dataIndex: "breakEvenPrice", ...numeric, render: (n: number) => money(n) },
    { title: "Last price", dataIndex: "ltp", ...numeric, render: (n: number | null) => money(n) },
    { title: "Day", dataIndex: "dayChangePct", ...numeric, render: (n: number | null) => <Signed value={n} kind="pct" /> },
    { title: "Week", dataIndex: "weekChangePct", ...numeric, render: (n: number | null) => <Signed value={n} kind="pct" /> },
    { title: "Market value", dataIndex: "marketValue", ...numeric, render: (n: number | null) => money(n) },
    { title: "Unrealised P/L", dataIndex: "unrealizedPl", ...numeric, render: (n: number | null) => <Signed value={n} /> },
    { title: "Weight", dataIndex: "weightPct", ...numeric, render: (n: number | null) => plainPct(n) },
  ];
  return (
    <Card title="Holdings">
      <DataTable
        rowKey="symbol"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={pageIf(rows.length)}
        sticky
        locale={{ emptyText: <EmptyState message="No open positions. Record a buy on the Transactions page." /> }}
      />
    </Card>
  );
}

export function Dashboard({
  view: v,
  attribution,
  asOf,
  range,
}: {
  view: PortfolioView;
  attribution: Attribution;
  asOf: string;
  range: { first: string; last: string } | null;
}) {
  const s = v.summary;
  const paid = v.dividends.filter((d) => d.paid).length;
  const toCome = v.dividends.filter((d) => !d.paid);
  const broken = v.findings.filter((f) => f.kind !== "trade_plan_reached");
  const plans = v.findings.filter((f) => f.kind === "trade_plan_reached");

  return (
    <div className="stack">
      <PageHeader
        title="Portfolio"
        purpose="Where the portfolio stands at the close, what moved it this week, and which of your rules it breaks."
        asOf={asOf}
        range={range ?? undefined}
      />

      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Market value" value={money(v.totalMarketValue)} hint={`${v.holdings.length} open positions`} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="This week" value={<Signed value={v.weekChangeBdt} />} hint={<>Portfolio {pct(v.weekChangePct)}, last five sessions</>} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="Market (DSEX) this week"
            value={<Signed value={v.market?.weekChangePct} kind="pct" />}
            hint={v.market ? <>Portfolio less DSEX: {pts(attribution.differencePts)}</> : "No index data"}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard
            title="Dividend income"
            value={money(v.dividendIncomeBdt)}
            hint={`${paid} paid${toCome.length ? `, ${money(toCome.reduce((t, d) => t + d.amountBdt, 0))} still to come` : ""}`}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Invested" value={money(s.totalInvested)} hint="Cost of open positions, fees included" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Unrealised P/L" value={<Signed value={s.unrealizedGainLoss} />} hint="Against break-even" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Realised P/L" value={<Signed value={s.realizedGainLoss} />} hint="Net of both commissions" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Net P/L" value={<Signed value={s.netGainLoss} />} hint="Realised plus unrealised" />
        </Col>
      </Row>

      <MovedTable a={attribution} />

      <Card title="Rules broken">
        <Findings findings={broken} emptyText="Every rule holds on this date." />
        {plans.length > 0 ? (
          <div style={{ marginTop: 12 }}>
            <Typography.Title level={3} style={{ fontSize: 15 }}>
              Trade plans whose price is reached
            </Typography.Title>
            <Findings findings={plans} />
          </div>
        ) : null}
      </Card>

      <HoldingsTable rows={v.holdings} />
    </div>
  );
}
