"use client";

import { Flex, Tag, Tooltip } from "antd";
import Link from "next/link";
import type { RunSummary } from "@/agent/trace-read";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { statusHint } from "../names";
import { runColumns } from "../queue/view";

const STATUS_COLOR: Record<string, string> = { success: "green", needs_human: "orange", error: "red" };

const COLUMNS = runColumns<RunSummary>([
  {
    title: "Status",
    dataIndex: "status",
    key: "status",
    render: (status: string) => (
      <Tooltip title={statusHint(status)}>
        <Tag color={STATUS_COLOR[status] ?? "default"}>{status}</Tag>
      </Tooltip>
    ),
  },
]);

/** Past runs: every run with a trace file, read only. */
export function RunsView({ runs }: { runs: RunSummary[] }) {
  return (
    <Flex vertical gap={16}>
      <PageHeader title="Past runs" purpose="Every run on this computer, newest first. Open one to see its steps." extra={<Flex wrap gap={12}><Link href="/explain">Explain</Link><Link href="/explain/queue">Review queue</Link></Flex>} />
      {runs.length === 0 ? (
        <EmptyState message="No runs yet. Run a review on the Explain page, then come back." />
      ) : (
        <DataTable<RunSummary> rowKey="run_id" columns={COLUMNS} dataSource={runs} pagination={{ pageSize: 20, hideOnSinglePage: true }} data-testid="runs" />
      )}
    </Flex>
  );
}
