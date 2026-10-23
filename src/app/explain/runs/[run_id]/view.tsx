"use client";

import { Alert, Descriptions, Flex, Steps, Tag, Typography } from "antd";
import Link from "next/link";
import type { Proof } from "@/agent/proof";
import type { TraceLine } from "@/agent/trace";
import type { RunSummary } from "@/agent/trace-read";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { ProofRow } from "../../view";
import { stepRows, waitingFor } from "../../trace-steps";

const BAD = new Set(["error", "rejected", "blocked"]);

/** The trace viewer: the run's four Proof cards, then every trace line as a step on a timeline. */
export function RunView({ runId, lines, proof, done, summary }: { runId: string; lines: TraceLine[]; proof: Proof; done: boolean; summary: RunSummary }) {
  const rows = stepRows(lines);
  return (
    <Flex vertical gap={16}>
      <PageHeader title={`Run ${runId}`} purpose="Every step the agents took, in order, with the source of each query and the memory each step recalled." extra={<Link href="/explain/queue">Review queue</Link>} />
      <Descriptions size="small" bordered column={{ xs: 1, sm: 2, md: 4 }} data-testid="run-summary">
        <Descriptions.Item label="Task">{summary.task ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Status">{done ? summary.status : "running"}</Descriptions.Item>
        <Descriptions.Item label="As of">{summary.as_of ?? "-"}</Descriptions.Item>
        <Descriptions.Item label="Steps">{rows.length}</Descriptions.Item>
      </Descriptions>
      {summary.status === "needs_human" ? <Alert type="warning" showIcon message="This run waits for you" description={waitingFor(summary)} /> : null}
      <ProofRow proof={proof} />
      {rows.length === 0 ? (
        <EmptyState message="This trace has no lines yet." />
      ) : (
        <Steps
          orientation="vertical"
          size="small"
          current={rows.length}
          data-testid="timeline"
          items={rows.map((row) => ({
            title: `${row.n}. ${row.agent}: ${row.action}`,
            status: BAD.has(row.status) ? "error" : "finish",
            content: (
              <div data-testid={`step-${row.n}`}>
                <Tag>{row.status}</Tag>
                <span>{`retry ${row.retry}`}</span>
                {row.confidence !== null ? <span>{`, confidence ${row.confidence}`}</span> : null}
                {row.model !== null ? <Tag style={{ marginLeft: 8 }}>{row.model}</Tag> : null}
                {row.prompt_hash !== null ? <Tag style={{ marginLeft: 8 }} title="The first 8 characters of the SHA-256 of the agent's prompt file">prompt {row.prompt_hash}</Tag> : null}
                {row.source !== null ? <Tag color={row.source === "zetaris" ? "blue" : row.source === "local-fallback" ? "orange" : "default"}>{row.source}</Tag> : null}
                {row.usage !== null ? <div className="muted">{row.usage}</div> : null}
                {row.why !== null ? <div className="muted">{`Why: ${row.why}`}</div> : null}
                {row.child !== null ? (
                  <div data-testid={`handoff-${row.n}`}>
                    <Typography.Text strong>{`Handed to ${row.child.task}, ${row.child.status}: `}</Typography.Text>
                    <Link href={`/explain/runs/${row.child.run_id}`}>{row.child.run_id}</Link>
                    {row.times !== null ? <div className="muted" data-testid={`handoff-times-${row.n}`}>{`Started ${row.times.started_at}, finished ${row.times.finished_at}`}</div> : null}
                  </div>
                ) : null}
                {row.detail !== null ? (
                  <div>
                    <Typography.Text strong>{`${row.detail.label}: `}</Typography.Text>
                    <Typography.Text>{row.detail.text}</Typography.Text>
                  </div>
                ) : null}
              </div>
            ),
          }))}
        />
      )}
    </Flex>
  );
}
