"use client";

import { Collapse, Flex, Typography, theme, type TableColumnsType } from "antd";
import Link from "next/link";
// Types only: metrics.ts reads files, so the server page builds the rows and this component gets plain data.
import type { TaskMetrics } from "@/agent/metrics";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { taskName } from "../names";

export type PromptVersionRow = { agent: string; prompt_hash: string; runs: number };
export type MetricsGroup = { task: string; metrics: TaskMetrics; rows: [string, string][] };
type Segment = { label: string; count: number; color: string };

/** One stacked bar: each segment's width is its share of the total, with the legend under it. */
function Bar({ title, segments }: { title: string; segments: Segment[] }) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return (
    <div>
      <Typography.Text type="secondary">{title}</Typography.Text>
      <Flex style={{ height: 14, borderRadius: 4, overflow: "hidden", marginTop: 4, background: "rgba(128,128,128,0.15)" }} role="img" aria-label={`${title}: ${segments.map((s) => `${s.label} ${s.count}`).join(", ")}`}>
        {total === 0 ? null : segments.filter((s) => s.count > 0).map((s) => <div key={s.label} title={`${s.label} ${s.count}`} style={{ width: `${(s.count / total) * 100}%`, background: s.color }} />)}
      </Flex>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {segments.map((s) => `${s.label} ${s.count}`).join(" · ")}
      </Typography.Text>
    </div>
  );
}

const ROW_COLUMNS: TableColumnsType<{ name: string; value: string }> = [
  { title: "Number", dataIndex: "name", key: "name", width: 220 },
  { title: "Value", dataIndex: "value", key: "value" },
];

const VERSION_COLUMNS: TableColumnsType<PromptVersionRow> = [
  { title: "Agent", dataIndex: "agent", key: "agent" },
  { title: "Prompt hash", dataIndex: "prompt_hash", key: "prompt_hash", render: (hash: string) => <code>{hash}</code> },
  { title: "Runs", dataIndex: "runs", key: "runs" },
];

/** The same numbers as GET /metrics: one table per task with all runs first, the status and query-source bars, and the prompt versions. */
export function MetricsView({ runsRead, groups, versions }: { runsRead: number; groups: MetricsGroup[]; versions: PromptVersionRow[] }) {
  const { token } = theme.useToken();
  const all = groups[0]?.metrics;
  return (
    <Flex vertical gap={16}>
      <PageHeader title="Metrics" purpose="Numbers across runs, counted from the trace files. Nothing here is estimated." extra={<Flex gap={12}><Link href="/explain">Analysis & Verification</Link><Link href="/explain/queue">Pending Approvals</Link></Flex>} />
      <Typography.Text type="secondary">{`Counted from the newest ${runsRead} runs on this computer.`}</Typography.Text>
      {all === undefined || runsRead === 0 ? (
        <EmptyState message="No runs yet. Run a review on the Analysis & Verification page, then come back." />
      ) : (
        groups.map(({ task, metrics, rows }) => (
          <Flex vertical gap={12} key={task} data-testid={`metrics-${task}`}>
            <Typography.Title level={3} style={{ margin: 0 }}>
              {task === "all" ? "All runs" : taskName(task)}
            </Typography.Title>
            <Bar
              title="Status"
              segments={[
                { label: "success", count: metrics.by_status.success, color: token.colorSuccess },
                { label: "needs_human", count: metrics.by_status.needs_human, color: token.colorWarning },
                { label: "error", count: metrics.by_status.error, color: token.colorError },
                { label: "unknown", count: metrics.by_status.unknown, color: token.colorTextQuaternary },
              ]}
            />
            <Bar
              title="Query sources"
              segments={[
                { label: "zetaris", count: metrics.queries.zetaris, color: token.colorPrimary },
                { label: "local", count: metrics.queries.local, color: token.colorInfo },
                { label: "local-fallback", count: metrics.queries.local_fallback, color: token.colorWarning },
              ]}
            />
            <DataTable<{ name: string; value: string }> rowKey="name" size="small" columns={ROW_COLUMNS} dataSource={rows.map(([name, value]) => ({ name, value }))} pagination={false} />
          </Flex>
        ))
      )}
      {versions.length > 0 ? (
        <Collapse
          items={[
            {
              key: "versions",
              label: "Prompt versions (for developers)",
              children: <DataTable rowKey={(row) => `${row.agent}-${row.prompt_hash}`} size="small" columns={VERSION_COLUMNS} dataSource={versions} pagination={false} />,
            },
          ]}
        />
      ) : null}
    </Flex>
  );
}
