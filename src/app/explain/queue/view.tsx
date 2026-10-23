"use client";

import { Flex, Tag, type TableColumnsType } from "antd";
import Link from "next/link";
import type { RunSummary } from "@/agent/trace-read";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";

export type QueueRun = RunSummary & { waiting_for: string };

const COLUMNS: TableColumnsType<QueueRun> = [
  { title: "Run", dataIndex: "run_id", key: "run_id", render: (id: string) => <Link href={`/explain/runs/${id}`}>{id}</Link> },
  { title: "Task", dataIndex: "task", key: "task", render: (task: string | null) => task ?? "-" },
  { title: "As of", dataIndex: "as_of", key: "as_of", render: (asOf: string | null) => asOf ?? "-" },
  {
    title: "Why it waits",
    key: "why",
    render: (_: unknown, run) => (
      <span>
        <Tag color="orange">{run.stop_reason ?? run.escalation_rule ?? "waiting"}</Tag>
        {run.waiting_for}
      </span>
    ),
  },
  { title: "Finished", dataIndex: "at", key: "at", render: (at: string) => at.replace("T", " ").slice(0, 19) },
  { title: "Trace", key: "trace", render: (_: unknown, run) => <Link href={`/explain/runs/${run.run_id}`}>Open the trace</Link> },
];

/** The review queue: read only. Approving a fix happens on the Explain page, never here. */
export function QueueView({ runs }: { runs: QueueRun[] }) {
  return (
    <Flex vertical gap={16}>
      <PageHeader title="Review queue" purpose="Runs that wait for you: escalated trades, reconciliation proposals and runs that hit a limit. Newest first." extra={<Link href="/explain">Explain</Link>} />
      {runs.length === 0 ? <EmptyState message="No run is waiting for you." /> : <DataTable<QueueRun> rowKey="run_id" columns={COLUMNS} dataSource={runs} pagination={{ pageSize: 20, hideOnSinglePage: true }} data-testid="queue" />}
    </Flex>
  );
}
