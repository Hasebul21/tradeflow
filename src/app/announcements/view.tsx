"use client";

import { Card, Flex, Segmented, Select, Typography } from "antd";
import { useRouter } from "next/navigation";
import { AnnouncementTable } from "@/components/ui/announcement-table";
import { PageHeader } from "@/components/ui/page-header";
import type { Announcement } from "@/lib/data-types";

export function AnnouncementsView({
  rows,
  total,
  mineOnly,
  symbol,
  symbols,
}: {
  rows: Announcement[];
  total: number;
  mineOnly: boolean;
  symbol: string;
  symbols: string[];
}) {
  const router = useRouter();
  return (
    <div className="stack">
      <PageHeader
        title="Announcements"
        purpose="Company announcements, newest first. Every one is synthetic: made up by the seed script, not taken from the exchange."
      />
      <Card>
        <Flex wrap gap={12} align="center" style={{ marginBottom: 12 }}>
          <Segmented
            aria-label="Which announcements"
            value={symbol ? "symbol" : mineOnly ? "mine" : "all"}
            options={[
              { label: "All symbols", value: "all" },
              { label: "My holdings only", value: "mine" },
              ...(symbol ? [{ label: symbol, value: "symbol" }] : []),
            ]}
            onChange={(v) => router.push(v === "mine" ? "/announcements?holdings=1" : v === "all" ? "/announcements" : `/announcements?symbol=${symbol}`)}
          />
          <Select
            aria-label="One symbol"
            allowClear
            showSearch
            placeholder="One symbol"
            style={{ width: 180 }}
            value={symbol || undefined}
            options={symbols.map((s) => ({ value: s, label: s }))}
            onChange={(s?: string) => router.push(s ? `/announcements?symbol=${s}` : "/announcements")}
          />
          <Typography.Text type="secondary">
            Showing {rows.length} of {total}
          </Typography.Text>
        </Flex>
        <AnnouncementTable rows={rows} />
      </Card>
    </div>
  );
}
