"use client";

import { Card, Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { WrapText } from "@/components/ui/wrap-text";
import Link from "next/link";
import { formatShares, money, shortDate } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { pageIf } from "@/components/ui/table-helpers";
import type { JournalEntry } from "@/lib/data-types";

export type JournalRow = JournalEntry & {
  trade: { symbol: string; side: "buy" | "sell"; quantity: number; price: number } | null;
};

export function JournalView({ rows }: { rows: JournalRow[] }) {
  const columns: TableColumnsType<JournalRow> = [
    { title: "Date", dataIndex: "created_at", render: (d: string) => shortDate(d) },
    {
      title: "Trade",
      dataIndex: "trade",
      render: (t: JournalRow["trade"]) =>
        t ? (
          <div>
            <Tag color={t.side === "buy" ? "green" : "volcano"}>{t.side}</Tag>
            <Link href={`/instruments/${t.symbol}`}>
              <strong>{t.symbol}</strong>
            </Link>
            <div className="muted num" style={{ fontSize: 12 }}>
              {formatShares(t.quantity)} at {money(t.price)}
            </div>
          </div>
        ) : (
          <span className="muted">trade not in the ledger</span>
        ),
    },
    { title: "Thesis", dataIndex: "thesis", className: "cell-wrap", render: (t: string) => <WrapText width={280}>{t}</WrapText> },
    { title: "Horizon", dataIndex: "horizon" },
    { title: "Exit condition", dataIndex: "exit_condition", className: "cell-wrap", render: (e: string | null) => <WrapText width={190}>{e ?? "—"}</WrapText> },
    { title: "Tags", dataIndex: "tags", render: (tags: string[]) => tags.map((t) => <Tag key={t}>{t}</Tag>) },
  ];
  return (
    <div className="stack">
      <PageHeader title="Journal" purpose="Why each trade was made, written on the day. Add one with the optional fields on the Transactions page." />
      <Card title={`Entries (${rows.length})`}>
        <DataTable rowKey="id" size="small" columns={columns} dataSource={rows} pagination={pageIf(rows.length)} sticky locale={{ emptyText: <EmptyState message="No journal entries yet." /> }} />
      </Card>
    </div>
  );
}
