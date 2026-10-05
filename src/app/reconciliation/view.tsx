"use client";

import { Alert, Card, Col, Row, Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { WrapText } from "@/components/ui/wrap-text";
import { formatShares, money, shortDate } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/states";
import { numeric } from "@/components/ui/table-helpers";
import type { Contribution } from "@/lib/data-types";
import type { TransactionRow } from "@/lib/portfolio";
import { PRICE_TOLERANCE_BDT, type Reconciliation, type TradePair } from "@/lib/reconcile";
import type { BankDepositRow, BrokerStatementRow } from "@/lib/sources";

type Issue = { key: string; kind: string; date: string; what: string; detail: string };

const FIELD: Record<string, string> = { commission_bdt: "commission", price: "price" };

function issues(r: Reconciliation): Issue[] {
  const trade = (t: TransactionRow) => `${t.side} ${formatShares(Number(t.quantity))} ${t.symbol} at ${money(Number(t.price_per_share))}`;
  const brokerTrade = (b: BrokerStatementRow) => `${b.side} ${formatShares(b.quantity)} ${b.symbol} at ${money(b.price)}`;
  return [
    ...r.trades.mismatched.map((p: TradePair) => ({
      key: `m-${p.broker.broker_ref}`,
      kind: "Field differs",
      date: p.broker.trade_date,
      what: `${brokerTrade(p.broker)} (${p.broker.broker_ref}, ledger ${p.ledger.id})`,
      detail: p.differences.map((d) => `${FIELD[d.field]}: broker ${money(d.broker)}, ledger ${money(d.ledger)}`).join("; "),
    })),
    ...r.trades.ledgerOnly.map((t) => ({ key: `l-${t.id}`, kind: "In the ledger only", date: t.created_at, what: `${trade(t)} (${t.id})`, detail: "No broker row for this trade." })),
    ...r.trades.brokerOnly.map((b) => ({ key: `b-${b.broker_ref}`, kind: "On the broker statement only", date: b.trade_date, what: `${brokerTrade(b)} (${b.broker_ref})`, detail: "No ledger trade matches it." })),
    ...r.deposits.bankOnly.map((b: BankDepositRow) => ({ key: `k-${b.bank_ref}`, kind: "In the bank file only", date: b.value_date, what: `${money(b.amount_bdt)} (${b.bank_ref})`, detail: "No contribution on this date for this amount." })),
    ...r.deposits.contributionsOnly.map((c: Contribution) => ({ key: `c-${c.id}`, kind: "In contributions only", date: c.created_at, what: `${money(c.amount_bdt)} (${c.id})`, detail: "No bank credit matches it." })),
  ];
}

export function ReconciliationView({ r }: { r: Reconciliation }) {
  const list = issues(r);
  const columns: TableColumnsType<Issue> = [
    { title: "Kind", dataIndex: "kind", render: (k: string) => <Tag color={k === "Field differs" ? "orange" : "red"}>{k}</Tag> },
    { title: "Date", dataIndex: "date", render: (d: string) => shortDate(d) },
    { title: "Row", dataIndex: "what", className: "cell-wrap", render: (w: string) => <WrapText width={260}>{w}</WrapText> },
    { title: "What differs", dataIndex: "detail", className: "cell-wrap", render: (d: string) => <WrapText width={240}>{d}</WrapText> },
  ];
  const matchedColumns: TableColumnsType<TradePair> = [
    { title: "Broker ref", key: "ref", render: (_: unknown, p) => p.broker.broker_ref },
    { title: "Ledger id", key: "id", render: (_: unknown, p) => p.ledger.id },
    { title: "Date", key: "date", render: (_: unknown, p) => shortDate(p.broker.trade_date) },
    { title: "Symbol", key: "sym", render: (_: unknown, p) => <strong>{p.broker.symbol}</strong> },
    { title: "Shares", key: "q", ...numeric, render: (_: unknown, p) => formatShares(p.broker.quantity) },
    { title: "Price", key: "p", ...numeric, render: (_: unknown, p) => money(p.broker.price) },
    { title: "Commission", key: "c", ...numeric, render: (_: unknown, p) => money(p.broker.commission_bdt) },
  ];
  return (
    <div className="stack">
      <PageHeader
        title="Reconciliation"
        purpose={`The broker statement against the ledger (same day, symbol, side and shares; price within ${money(PRICE_TOLERANCE_BDT)}), and bank deposits against contributions. It only reports; it changes nothing.`}
      />
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <StatCard title="Trades matched" value={String(r.trades.matched.length)} />
        </Col>
        <Col xs={12} md={6}>
          <StatCard title="Deposits matched" value={String(r.deposits.matched.length)} />
        </Col>
        <Col xs={24} md={12}>
          <StatCard title="Rows to look at" value={String(r.issueCount)} hint="Differences and rows found on one side only" />
        </Col>
      </Row>
      <Card title="Differences">
        {list.length === 0 ? (
          <Alert type="success" showIcon title="Everything matches." />
        ) : (
          <DataTable rowKey="key" size="small" columns={columns} dataSource={list} pagination={false} />
        )}
      </Card>
      <Card title={`Matched trades (${r.trades.matched.length})`}>
        <DataTable rowKey={(p) => p.broker.broker_ref} size="small" columns={matchedColumns} dataSource={r.trades.matched} pagination={{ pageSize: 15, showSizeChanger: false }} locale={{ emptyText: <EmptyState message="No trades matched." /> }} />
      </Card>
    </div>
  );
}
