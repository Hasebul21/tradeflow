"use client";

import { Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { WrapText } from "@/components/ui/wrap-text";
import Link from "next/link";
import { shortDate } from "@/components/format";
import { EmptyState } from "@/components/ui/states";
import { pageIf } from "@/components/ui/table-helpers";
import type { Announcement, AnnouncementCategory } from "@/lib/data-types";

const CATEGORY: Record<AnnouncementCategory, [label: string, color: string]> = {
  earnings: ["Earnings", "blue"],
  dividend_declaration: ["Dividend", "green"],
  bonus_declaration: ["Bonus shares", "cyan"],
  agm: ["AGM", "default"],
  price_sensitive: ["Price-sensitive", "magenta"],
  other: ["Other", "default"],
};

function dhakaClock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });
}

export function AnnouncementTable({ rows, showSymbol = true }: { rows: Announcement[]; showSymbol?: boolean }) {
  const columns: TableColumnsType<Announcement> = [
    {
      title: "Date",
      dataIndex: "published_at",
      width: 120,
      render: (d: string) => (
        <div>
          <div>{shortDate(d)}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {dhakaClock(d)} Dhaka
          </div>
        </div>
      ),
    },
    ...(showSymbol
      ? [{ title: "Symbol", dataIndex: "symbol", width: 120, render: (s: string) => <Link href={`/instruments/${s}`}><strong>{s}</strong></Link> }]
      : []),
    {
      title: "Category",
      dataIndex: "category",
      width: 150,
      render: (c: AnnouncementCategory, a) => (
        <div>
          <Tag color={CATEGORY[c][1]}>{CATEGORY[c][0]}</Tag>
          {a.price_sensitive ? <Tag color="red">price-sensitive</Tag> : null}
        </div>
      ),
    },
    {
      title: "Title",
      dataIndex: "title",
      className: "cell-wrap",
      render: (t: string, a) => (
        <WrapText width={420}>
          <strong>{t}</strong>
          <div className="muted" style={{ fontSize: 13 }}>
            {a.body}
          </div>
        </WrapText>
      ),
    },
  ];
  return (
    <DataTable
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={pageIf(rows.length, 20)}
      sticky
      locale={{ emptyText: <EmptyState message="No announcements match." /> }}
    />
  );
}
