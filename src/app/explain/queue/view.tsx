"use client";

import { Flex, Tooltip, type TableColumnsType } from "antd";
import Link from "next/link";
import type { RunSummary } from "@/agent/trace-read";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { shortRunId, taskName } from "../names";

export type QueueRun = RunSummary & { waiting_for: string };

/** The columns of a run list; the queue adds why each run waits. */
export function runColumns<T extends RunSummary>(extra: TableColumnsType<T> = []): TableColumnsType<T> {
  return [
    {
      title: "Run",
      dataIndex: "run_id",
      key: "run_id",
      render: (id: string) => (
        <Tooltip title={id}>
          <Link href={`/explain/runs/${id}`}>{shortRunId(id)}</Link>
        </Tooltip>
      ),
    },
    { title: "Task", dataIndex: "task", key: "task", render: (task: string | null) => taskName(task) },
    { title: "As of", dataIndex: "as_of", key: "as_of", render: (asOf: string | null) => asOf ?? "-" },
    ...extra,
    { title: "Finished (UTC)", dataIndex: "at", key: "at", render: (at: string) => at.replace("T", " ").slice(0, 19) },
    { title: "Trace", key: "trace", render: (_: unknown, run) => <Link href={`/explain/runs/${run.run_id}`}>Open the trace</Link> },
  ];
}

const COLUMNS = runColumns<QueueRun>([{ title: "Why it waits", key: "why", render: (_: unknown, run) => run.waiting_for }]);

/** The review queue: read only. Approving a fix happens on the Explain page, never here. */
export function QueueView({ runs }: { runs: QueueRun[] }) {
  return (
    <Flex vertical gap={16}>
      <PageHeader title="Pending Approvals" purpose="Runs that wait for you: escalated trades, reconciliation proposals and runs that hit a limit. Newest first." extra={<Flex gap={12}><Link href="/explain">Analysis & Verification</Link><Link href="/explain/metrics">Metrics</Link></Flex>} />
      {runs.length === 0 ? <EmptyState message="No run is waiting for you. Runs that need your decision appear here after you use Analysis & Verification." /> : <DataTable<QueueRun> rowKey="run_id" columns={COLUMNS} dataSource={runs} pagination={{ pageSize: 20, hideOnSinglePage: true }} data-testid="queue" />}
    </Flex>
  );
}
