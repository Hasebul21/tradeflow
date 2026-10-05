"use client";

import { Card, Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import Link from "next/link";
import { formatShares, money, shortDate } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { numeric, pageIf } from "@/components/ui/table-helpers";
import type { BankDepositRow, BrokerStatementRow } from "@/lib/sources";

export function SourcesView({ broker, bank }: { broker: BrokerStatementRow[]; bank: BankDepositRow[] }) {
  const brokerColumns: TableColumnsType<BrokerStatementRow> = [
    { title: "Ref", dataIndex: "broker_ref" },
    { title: "Trade date", dataIndex: "trade_date", render: (d: string) => shortDate(d) },
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <strong>{s}</strong> },
    { title: "Side", dataIndex: "side", render: (s: string) => <Tag color={s === "buy" ? "green" : "volcano"}>{s}</Tag> },
    { title: "Shares", dataIndex: "quantity", ...numeric, render: (n: number) => formatShares(n) },
    { title: "Price", dataIndex: "price", ...numeric, render: (n: number) => money(n) },
    { title: "Commission", dataIndex: "commission_bdt", ...numeric, render: (n: number) => money(n) },
    { title: "Settles", dataIndex: "settlement_date", render: (d: string) => shortDate(d) },
  ];
  const bankColumns: TableColumnsType<BankDepositRow> = [
    { title: "Ref", dataIndex: "bank_ref" },
    { title: "Value date", dataIndex: "value_date", render: (d: string) => shortDate(d) },
    { title: "Narration", dataIndex: "narration" },
    { title: "Amount", dataIndex: "amount_bdt", ...numeric, render: (n: number) => money(n) },
  ];
  return (
    <div className="stack">
      <PageHeader
        title="Sources"
        purpose="The files a broker and a bank would send, read as they are from data/sources/. Both are synthetic."
        extra={<Link href="/reconciliation">Compare them with the ledger</Link>}
      />
      <Card title={`Broker statement: ${broker.length} rows`} extra={<span className="muted">broker_statement.csv</span>}>
        <DataTable rowKey="broker_ref" size="small" columns={brokerColumns} dataSource={broker} pagination={pageIf(broker.length)} sticky locale={{ emptyText: <EmptyState message="No broker statement in data/sources/." /> }} />
      </Card>
      <Card title={`Bank deposits: ${bank.length} rows`} extra={<span className="muted">bank_deposits.csv</span>}>
        <DataTable rowKey="bank_ref" size="small" columns={bankColumns} dataSource={bank} pagination={false} locale={{ emptyText: <EmptyState message="No bank file in data/sources/." /> }} />
      </Card>
    </div>
  );
}
