"use client";

import { Alert, Badge, Button, Card, Collapse, DatePicker, Descriptions, Drawer, Flex, Form, Input, InputNumber, Radio, Select, Space, Steps, Tabs, Tag, Tooltip, Typography, type TableColumnsType } from "antd";
import dayjs from "dayjs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Citation, RunResult } from "@/agent/orchestrator";
import type { Proof } from "@/agent/proof";
import type { TraceLine } from "@/agent/trace";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { acceptedText, adviceBadge, correctionChip, movedBadge, outOfScopeBadge, scoresText, selfCorrectionBanner, stoppedBadge, stopReasonLabel, usageText } from "./badges";
import { approveFix, runPreTrade, runReconcile, runTheses, runWeek, sendCorrection, type PreTradeChoice } from "./actions";
import { splitCitations } from "./citations";
import { asOfHelp, CITATION_HELP, ERROR_TITLE, errorAdvice, fallbackText, modelText, PROOF_HELP, PROOF_HINTS, statusHint, STEPS_HELP } from "./names";

type Range = { first: string; last: string };
type Plan = { id: string; label: string };
const POLL_MS = 1500;

const BREAK_ADVICE = "Should I sell BXPHARMA now?";
const BREAK_POEM = "Write me a poem about Dhaka.";
const BREAK_SATURDAY = "2026-09-26";
const BREAK_SATURDAY_LABEL = "Sat 26 Sep 2026";

const QUESTIONS = ["Why did my portfolio move this week?", "Which of my rules are broken this week?", "How does this week compare with last week?"];

// ---------------------------------------------------------------------------------------------------------------
// One run: a client-made run id, a poll of GET /run/<run_id> while the action is awaited, then the result.

type RunState = { running: boolean; runId: string | null; steps: TraceLine[]; started: boolean; result: RunResult | null; proof: Proof | null; stopping: boolean };

async function fetchProof(runId: string): Promise<Proof | null> {
  try {
    const response = await fetch(`/run/${runId}/proof`, { cache: "no-store" });
    return response.ok ? ((await response.json()) as Proof) : null;
  } catch {
    return null;
  }
}

async function fetchSteps(runId: string): Promise<TraceLine[] | null> {
  try {
    const response = await fetch(`/run/${runId}`, { cache: "no-store" });
    if (!response.ok) return null;
    return ((await response.json()) as { lines: TraceLine[] }).lines;
  } catch {
    return null;
  }
}

function useRun() {
  const [state, setState] = useState<RunState>({ running: false, runId: null, steps: [], started: false, result: null, proof: null, stopping: false });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const start = async (action: (runId: string) => Promise<RunResult>) => {
    const runId = crypto.randomUUID();
    setState({ running: true, runId, steps: [], started: false, result: null, proof: null, stopping: false });
    timer.current = setInterval(async () => {
      const lines = await fetchSteps(runId);
      const proof = await fetchProof(runId);
      if (lines !== null) setState((s) => (s.runId === runId && s.running ? { ...s, steps: lines, started: true, proof: proof ?? s.proof } : s));
    }, POLL_MS);
    let result: RunResult;
    try {
      result = await action(runId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result = { run_id: runId, task: "", status: "error", output: null, error: { type: "ActionFailed", message, recoverable: true }, agents: [], usage: { model_calls: 0, query_calls: 0, tokens_in: 0, tokens_out: 0, duration_ms: 0 }, trace_id: runId, log_file: null, execution_time_seconds: 0 };
    }
    if (timer.current) clearInterval(timer.current);
    const lines = (await fetchSteps(runId)) ?? [];
    const proof = await fetchProof(runId);
    setState({ running: false, runId, steps: lines, started: lines.length > 0, result, proof, stopping: false });
  };

  /** Asks the server to stop the run in progress. The action still returns the result: needs_human, stopped by you. */
  const stop = async () => {
    const runId = state.runId;
    if (runId === null || !state.running) return;
    setState((s) => (s.runId === runId ? { ...s, stopping: true } : s));
    try {
      await fetch(`/run/${runId}/cancel`, { method: "POST" });
    } catch {
      // The run may have finished already (404); the action's result shows what happened.
    }
  };
  return { state, start, stop };
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces of a result.

function StepsList({ steps }: { steps: TraceLine[] }) {
  return (
    <>
      <Typography.Paragraph type="secondary">{STEPS_HELP}</Typography.Paragraph>
      <Steps
        orientation="vertical"
        size="small"
        current={steps.length}
        items={steps.map((l) => ({
          title: `${l.agent_name}: ${l.action}`,
          status: l.status === "error" || l.status === "rejected" || l.status === "blocked" ? "error" : "finish",
          content: (
            <span>
              <Tag>{l.status}</Tag>
              <span>retry {l.retry_count}</span>
              {l.confidence !== null && l.confidence !== undefined ? <span>{`, confidence ${l.confidence}`}</span> : null}
              {l.why ? <div className="muted">{l.why}</div> : null}
            </span>
          ),
        }))}
      />
    </>
  );
}

const PROOF_CARDS = [
  { key: "zetaris", sponsor: "Zetaris" },
  { key: "meterless", sponsor: "Meterless" },
  { key: "nemotron", sponsor: "Nemotron" },
  { key: "guards", sponsor: "Guards" },
] as const;

/** The numbers of the Proof cards, each read from the proof counts and nothing else. */
export function proofCards(p: Proof): { key: string; sponsor: string; big: number; caption: string }[] {
  const calls = p.nemotron.models.reduce((n, m) => n + m.calls, 0);
  const models = p.nemotron.models.map((m) => `${m.model_id} x${m.calls}`).join(", ") || "no model calls";
  const big = {
    zetaris: p.zetaris.queries,
    meterless: p.meterless.memories_recalled,
    nemotron: calls,
    guards: p.guards.checked,
  };
  const caption = {
    zetaris: `${p.zetaris.via_zetaris} via Zetaris, ${p.zetaris.local} local`,
    meterless: `${p.meterless.taken_by_tag} by tag, ${p.meterless.corrections_applied} corrections applied`,
    nemotron: `${models}; ${p.nemotron.tokens_in} tokens in, ${p.nemotron.tokens_out} out`,
    guards: `${p.guards.blocked} blocked, ${p.guards.injections_flagged} injections flagged`,
  };
  return PROOF_CARDS.map((c) => ({ ...c, big: big[c.key], caption: caption[c.key] }));
}

export function ProofRow({ proof }: { proof: Proof | null }) {
  if (proof === null) return null;
  return (
    <div>
      <Typography.Text strong>Proof</Typography.Text>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>{PROOF_HELP}</Typography.Paragraph>
      <Flex wrap gap={12} style={{ marginTop: 8 }}>
        {proofCards(proof).map((c) => (
          <Card key={c.key} size="small" style={{ flex: "1 1 200px" }} data-testid={`proof-${c.key}`}>
            <Tooltip title={PROOF_HINTS[c.key]}>
              <Typography.Text strong>{c.sponsor}</Typography.Text>
            </Tooltip>
            <div style={{ fontSize: 32, fontWeight: 600, lineHeight: 1.2 }}>{c.big}</div>
            <Typography.Text type="secondary">{c.caption}</Typography.Text>
          </Card>
        ))}
      </Flex>
    </div>
  );
}

function Live({ state, onStop }: { state: RunState; onStop?: () => void }) {
  if (!state.running) return null;
  return (
    <Card
      size="small"
      title="Working"
      extra={
        onStop === undefined ? null : (
          <Tooltip title={!state.started && !state.stopping ? "Stop works once the first step appears." : undefined}>
            <Button danger size="small" loading={state.stopping} disabled={state.stopping || !state.started} onClick={onStop}>{state.stopping ? "Stopping" : "Stop"}</Button>
          </Tooltip>
        )
      }
    >
      <ProofRow proof={state.proof} />
      {state.started ? <StepsList steps={state.steps} /> : <Typography.Text type="secondary">Starting</Typography.Text>}
    </Card>
  );
}

function ReviewText({ text, citations, onOpen }: { text: string; citations: Citation[]; onOpen: (c: Citation) => void }) {
  return (
    <div>
      {text.split("\n").map((line, i) => {
        const bullet = /^\s*[-*]\s+/.test(line);
        const body = line.replace(/^\s*[-*]\s+/, "");
        const nodes = splitCitations(body, citations).map((part, j) =>
          part.kind === "text" ? (
            <span key={j}>{part.text}</span>
          ) : (
            <a key={j} role="button" tabIndex={0} onClick={() => onOpen(part.citation)} onKeyDown={(e) => { if (e.key === "Enter") onOpen(part.citation); }}>
              {`[${part.citation.query_id}]`}
            </a>
          ),
        );
        if (line.trim() === "") return <br key={i} />;
        return <p key={i} style={{ margin: "4px 0", paddingLeft: bullet ? 16 : 0 }}>{bullet ? "- " : ""}{nodes}</p>;
      })}
    </div>
  );
}

function CitationDrawer({ citation, onClose }: { citation: Citation | null; onClose: () => void }) {
  const rows = citation?.rows ?? [];
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columns: TableColumnsType<Record<string, unknown>> = keys.map((k) => ({
    title: k,
    dataIndex: k,
    render: (v: unknown) => (v !== null && typeof v === "object" ? JSON.stringify(v) : String(v ?? "")),
  }));
  return (
    <Drawer open={citation !== null} onClose={onClose} size="large" title={citation ? `Query ${citation.query_id}` : ""}>
      {citation ? (
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Query id">{citation.query_id}</Descriptions.Item>
            <Descriptions.Item label="Params"><code>{JSON.stringify(citation.params)}</code></Descriptions.Item>
            <Descriptions.Item label="Source">{citation.source}</Descriptions.Item>
            <Descriptions.Item label="Rows">{`${rows.length} shown of ${citation.row_count}`}</Descriptions.Item>
          </Descriptions>
          {citation.source === "zetaris" && citation.sql ? (
            <Card size="small" title="SQL that Zetaris ran" extra={<Button size="small" onClick={() => { void navigator.clipboard?.writeText(citation.sql ?? ""); }}>Copy</Button>}>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}><code>{citation.sql.slice(0, 600)}</code></pre>
            </Card>
          ) : null}
          <DataTable rowKey={(_, i) => String(i)} columns={columns} dataSource={rows} pagination={{ pageSize: 10 }} locale={{ emptyText: <EmptyState message="This query returned no rows." /> }} />
        </Space>
      ) : null}
    </Drawer>
  );
}

/** A failed run in plain words: what to do next, with the raw type and message folded under Details. */
function ErrorAlert({ error }: { error: RunResult["error"] }) {
  return (
    <Alert
      type="error"
      showIcon
      title={ERROR_TITLE}
      description={
        <>
          <div>{errorAdvice(error?.recoverable)}</div>
          <Collapse size="small" items={[{ key: "details", label: "Details", children: <code>{`${error?.type ?? "Error"}: ${error?.message ?? ""}`}</code> }]} />
        </>
      }
    />
  );
}

function CorrectBox({ runId }: { runId: string }) {
  const { state, start } = useRun();
  const [text, setText] = useState("");
  const added = state.result?.output?.memory_ids_added;
  return (
    <Card size="small" title="Correct this">
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Input.TextArea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should the next review do differently?" />
        <Tooltip title={text.trim() === "" ? "Type what the next review should do differently." : undefined}>
          <Button loading={state.running} disabled={text.trim() === ""} onClick={() => start((id) => sendCorrection(id, runId, text.trim()))}>
            Send correction
          </Button>
        </Tooltip>
        {state.result?.status === "error" ? <ErrorAlert error={state.result.error} /> : null}
        {added ? <Alert type="success" showIcon title={`Stored as ${added.join(", ")}`} description="Later reviews recall it by tag." /> : null}
      </Space>
    </Card>
  );
}

function sourceCounts(citations: Citation[]) {
  const n = (s: string) => citations.filter((c) => c.source === s).length;
  return { zetaris: n("zetaris"), local: n("local"), fallback: n("local-fallback") };
}

function Result({ state, extra }: { state: RunState; extra?: React.ReactNode }) {
  const [open, setOpen] = useState<Citation | null>(null);
  const result = state.result;
  if (result === null) return null;
  const out = result.output;
  const citations = out?.citations ?? [];
  const counts = sourceCounts(citations);
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Flex wrap gap={8} align="center">
        <Tooltip title={statusHint(result.status)}>
          <Tag color={result.status === "success" ? "green" : result.status === "needs_human" ? "orange" : "red"}>{result.status}</Tag>
        </Tooltip>
        {stoppedBadge(out) ? <Tag color="gold">{stoppedBadge(out)}</Tag> : null}
        {stoppedBadge(out) ? <Tag>{usageText(result.usage)}</Tag> : null}
        <Badge count={`${counts.zetaris} via Zetaris`} color="blue" />
        <Badge count={`${counts.local} local`} color="gray" />
        {fallbackText(counts.fallback) ? <Badge count={fallbackText(counts.fallback)} color="orange" /> : null}
        <Badge count={`${out?.memories_recalled.length ?? 0} memories recalled`} color="purple" />
        <Badge count={`${out?.applied_corrections.length ?? 0} corrections applied`} color="green" />
        {adviceBadge(out) ? <Tag color="green">{adviceBadge(out)}</Tag> : null}
        {movedBadge(state.steps) ? <Tag color="blue">{movedBadge(state.steps)}</Tag> : null}
        {outOfScopeBadge(out) ? <Tag color="gold">{outOfScopeBadge(out)}</Tag> : null}
        {correctionChip(out) ? <Tag color="purple">{correctionChip(out)}</Tag> : null}
        <a href={`/run/${result.run_id}`} target="_blank" rel="noreferrer">Trace (JSON)</a>
        <Link href={`/explain/runs/${result.run_id}`}>Open the steps</Link>
      </Flex>
      {selfCorrectionBanner(out, state.steps) ? <Alert type="info" showIcon title={selfCorrectionBanner(out, state.steps)} /> : null}
      <ProofRow proof={state.proof} />
      {result.status === "error" ? <ErrorAlert error={result.error} /> : null}
      {out?.escalation ? (
        <Alert
          type="warning"
          showIcon
          title="Nothing has been saved. This trade needs your decision."
          description={`${out.escalation.rule}: ${out.escalation.message}`}
        />
      ) : result.status === "needs_human" ? (
        <Alert type="warning" showIcon title="Needs your attention" description={stopReasonLabel(out) ?? "The run needs a person to decide."} />
      ) : null}
      {out ? (
        <>
          <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
            <Descriptions.Item label={result.status === "success" ? "Accepted" : "Stopped"}>{acceptedText(result.status, out)}</Descriptions.Item>
            <Descriptions.Item label="Scores">
              {scoresText(out, state.steps)}
            </Descriptions.Item>
            <Descriptions.Item label="Model">{modelText(out.model_source)}</Descriptions.Item>
            <Descriptions.Item label="Usage">
              {usageText(result.usage)}
            </Descriptions.Item>
          </Descriptions>
          {extra}
          <Card size="small" title="Summary">{out.summary}</Card>
          <Card size="small" title="Review">
            {citations.length > 0 ? <Typography.Paragraph type="secondary">{`${CITATION_HELP}.`}</Typography.Paragraph> : null}
            <ReviewText text={out.review_markdown} citations={citations} onOpen={setOpen} />
          </Card>
          {out.gaps.length > 0 ? (
            <Card size="small" title="What I could not cover">
              <ul>{out.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </Card>
          ) : null}
          <Card size="small" title="What I remembered">
            {out.memories_recalled.length === 0 && out.applied_corrections.length === 0 ? (
              <EmptyState message="Nothing from earlier reviews applied." />
            ) : (
              <ul>
                {out.memories_recalled.map((m) => <li key={m.id}>{`${m.id} (${m.tags.join(", ")})`}</li>)}
                {out.applied_corrections.map((c) => <li key={c.id}>{`Correction ${c.id}: ${c.content}`}</li>)}
              </ul>
            )}
          </Card>
        </>
      ) : null}
      <Collapse items={[{ key: "steps", label: `Steps (${state.steps.length})`, children: state.steps.length ? <StepsList steps={state.steps} /> : <EmptyState message="No steps were recorded." /> }]} />
      {out && result.status !== "error" ? <CorrectBox runId={result.run_id} /> : null}
      <CitationDrawer citation={open} onClose={() => setOpen(null)} />
    </Space>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The tabs.

function AsOf({ value, onChange, range }: { value: string; onChange: (v: string) => void; range: Range }) {
  return (
    <Form.Item label="As of" extra={asOfHelp(range)}>
      <DatePicker
        value={dayjs(value)}
        allowClear={false}
        format="D MMM YYYY"
        onChange={(d) => d && onChange(d.format("YYYY-MM-DD"))}
        disabledDate={(d) => d.format("YYYY-MM-DD") > range.last || d.format("YYYY-MM-DD") < range.first || d.day() === 5 || d.day() === 6}
      />
    </Form.Item>
  );
}

function WeekTab({ range }: { range: Range }) {
  const { state, start, stop } = useRun();
  const [asOf, setAsOf] = useState(range.last);
  const [question, setQuestion] = useState("");
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Form layout="vertical">
        <AsOf value={asOf} onChange={setAsOf} range={range} />
        <Form.Item label="Question">
          <Input.TextArea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about this week, or click a question below" />
          <Flex wrap gap={8} style={{ marginTop: 8 }}>
            {QUESTIONS.map((q) => <Tag key={q} style={{ cursor: "pointer" }} onClick={() => setQuestion(q)}>{q}</Tag>)}
          </Flex>
          <Flex wrap gap={8} align="center" style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">Try to break it (these should be refused or corrected)</Typography.Text>
            <Tag color="red" style={{ cursor: "pointer" }} onClick={() => setQuestion(BREAK_ADVICE)}>{BREAK_ADVICE}</Tag>
            <Tag color="red" style={{ cursor: "pointer" }} onClick={() => setQuestion(BREAK_POEM)}>{BREAK_POEM}</Tag>
            <Tooltip title="A Saturday: the guard moves it to the Thursday before.">
              <Tag color="red" style={{ cursor: "pointer" }} onClick={() => { setAsOf(BREAK_SATURDAY); setQuestion(QUESTIONS[0]); }}>{BREAK_SATURDAY_LABEL}</Tag>
            </Tooltip>
          </Flex>
        </Form.Item>
        <Tooltip title={question.trim() === "" ? "Type a question or pick one above." : undefined}>
          <Button type="primary" loading={state.running} disabled={question.trim() === ""} onClick={() => start((id) => runWeek(id, asOf, question.trim()))}>
            Explain my week
          </Button>
        </Tooltip>
      </Form>
      <Live state={state} onStop={stop} />
      <Result state={state} />
    </Space>
  );
}

const VERDICT_COLOR: Record<string, string> = { confirmed: "green", contradicted: "red", open: "gold" };

function ThesesTab({ range, theses }: { range: Range; theses: Record<string, string> }) {
  const { state, start, stop } = useRun();
  const [asOf, setAsOf] = useState(range.last);
  const out = state.result?.output;
  const rows = (out?.verdicts ?? []).map((v) => ({
    key: v.journal_id,
    journal_id: v.journal_id,
    symbol: v.symbol,
    thesis: theses[v.journal_id] ?? "",
    verdict: v.verdict,
    evidence: out?.findings.find((f) => f.kind === "thesis" && f.subject === v.journal_id)?.claim ?? "",
  }));
  const columns: TableColumnsType<(typeof rows)[number]> = [
    { title: "Journal entry", dataIndex: "journal_id" },
    { title: "Symbol", dataIndex: "symbol" },
    { title: "Thesis", dataIndex: "thesis" },
    { title: "Verdict", dataIndex: "verdict", render: (v: string) => <Tag color={VERDICT_COLOR[v] ?? "default"}>{v}</Tag> },
    { title: "Evidence", dataIndex: "evidence" },
  ];
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        Checks the reason you wrote for each trade in your Journal against the data up to this date: confirmed, contradicted or still open.
      </Typography.Paragraph>
      <Form layout="inline">
        <AsOf value={asOf} onChange={setAsOf} range={range} />
        <Button type="primary" loading={state.running} onClick={() => start((id) => runTheses(id, asOf))}>Check</Button>
      </Form>
      <Live state={state} onStop={stop} />
      <Result
        state={state}
        extra={<DataTable rowKey="key" columns={columns} dataSource={rows} pagination={false} locale={{ emptyText: <EmptyState message="No thesis verdicts." /> }} />}
      />
    </Space>
  );
}

function PreTradeTab({ range, plans }: { range: Range; plans: Plan[] }) {
  const { state, start, stop } = useRun();
  const [asOf, setAsOf] = useState(range.last);
  const [mode, setMode] = useState<"trade" | "plan">(plans.length ? "plan" : "trade");
  const [planId, setPlanId] = useState<string | undefined>(plans[0]?.id);
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState<number | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const choice = (): PreTradeChoice | null => {
    if (mode === "plan") return planId ? { plan_id: planId } : null;
    if (symbol.trim() === "" || quantity === null) return null;
    return { trade: { symbol: symbol.trim(), side, quantity, ...(price !== null ? { price } : {}) } };
  };
  const ready = choice() !== null;
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Alert type="info" showIcon title="This check never saves a trade. You decide." />
      <Form layout="vertical">
        <AsOf value={asOf} onChange={setAsOf} range={range} />
        <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} style={{ marginBottom: 12 }}>
          <Radio.Button value="trade">A new trade</Radio.Button>
          <Tooltip title={plans.length === 0 ? "There are no open trade plans. Add one on the Rules page." : undefined}>
            <Radio.Button value="plan" disabled={plans.length === 0}>A trade plan</Radio.Button>
          </Tooltip>
        </Radio.Group>
        {mode === "plan" ? (
          <Form.Item label="Trade plan (from Rules)"><Select value={planId} onChange={setPlanId} options={plans.map((p) => ({ value: p.id, label: p.label }))} /></Form.Item>
        ) : (
          <Flex wrap gap={12}>
            <Form.Item label="Symbol" extra="A symbol from the Instruments page, such as EBL. An unknown symbol stops the check with an error.">
              <Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="EBL" />
            </Form.Item>
            <Form.Item label="Side"><Select value={side} onChange={setSide} options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} style={{ width: 90 }} /></Form.Item>
            <Form.Item label="Quantity"><InputNumber min={1} precision={0} value={quantity} onChange={setQuantity} /></Form.Item>
            <Form.Item label="Price (optional)"><InputNumber min={0.1} value={price} onChange={setPrice} /></Form.Item>
          </Flex>
        )}
        <Tooltip title={ready ? undefined : "Enter a symbol and a quantity, or pick a plan."}>
          <Button type="primary" loading={state.running} disabled={!ready} onClick={() => { const c = choice(); if (c) start((id) => runPreTrade(id, asOf, c)); }}>
            Check this trade
          </Button>
        </Tooltip>
      </Form>
      <Live state={state} onStop={stop} />
      <Result state={state} />
    </Space>
  );
}

type Proposal = NonNullable<NonNullable<RunResult["output"]>["proposals"]>[number];
type Approval = { running: boolean; result: RunResult | null };

/** One proposal's action: Approve for a fix code can apply, a tag for a manual check, then what the approval did. */
function ApproveCell({ proposal, reviewRunId }: { proposal: Proposal; reviewRunId: string }) {
  const [state, setState] = useState<Approval>({ running: false, result: null });
  if (proposal.proposed_fix.startsWith("manual check")) return <Tag color="gold">Manual check: you decide</Tag>;
  const approve = async () => {
    setState({ running: true, result: null });
    const result = await approveFix(crypto.randomUUID(), reviewRunId, proposal.issue_id);
    setState({ running: false, result });
  };
  const result = state.result;
  if (result === null) {
    return <Button size="small" type="primary" loading={state.running} onClick={approve}>Approve</Button>;
  }
  if (result.status === "error") return <ErrorAlert error={result.error} />;
  const color = result.status === "success" ? "green" : "orange";
  return (
    <Space orientation="vertical" size={4}>
      <Tag color={color}>{result.status === "success" ? "Applied" : "Not applied"}</Tag>
      <Typography.Text type="secondary">{result.output?.summary}</Typography.Text>
    </Space>
  );
}

function ReconcileTab({ range }: { range: Range }) {
  const { state, start, stop } = useRun();
  const [asOf, setAsOf] = useState(range.last);
  const reviewRunId = state.result?.run_id ?? "";
  const rows = (state.result?.output?.proposals ?? []).map((p) => ({ key: p.issue_id, ...p }));
  const columns: TableColumnsType<(typeof rows)[number]> = [
    { title: "Issue", dataIndex: "issue_id" },
    { title: "Explanation", dataIndex: "explanation" },
    { title: "Proposed fix", dataIndex: "proposed_fix" },
    { title: "Status", dataIndex: "status", render: (v: string) => <Tag color="orange">{v.replace(/_/g, " ")}</Tag> },
    { title: "Your decision", key: "approve", render: (_: unknown, row) => <ApproveCell proposal={row} reviewRunId={reviewRunId} /> },
  ];
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Alert
        type="info"
        showIcon
        title="Nothing changes until you approve a proposal."
        description="The Reconciliation page lists the same differences. Here the agents explain each one, and code applies a fix only after you approve it."
      />
      <Form layout="inline">
        <AsOf value={asOf} onChange={setAsOf} range={range} />
        <Button type="primary" loading={state.running} onClick={() => start((id) => runReconcile(id, asOf))}>Explain the differences</Button>
      </Form>
      <Live state={state} onStop={stop} />
      <Result
        state={state}
        extra={<DataTable rowKey="key" columns={columns} dataSource={rows} pagination={false} locale={{ emptyText: <EmptyState message="No differences to approve." /> }} />}
      />
    </Space>
  );
}

export function ExplainView({ range, theses, plans, sampleMode }: { range: Range; theses: Record<string, string>; plans: Plan[]; sampleMode: boolean }) {
  return (
    <div className="stack">
      <PageHeader
        title="Explain"
        purpose="Pick a tab, choose a date and press its button. The agents explain and check; they never advise, and nothing is saved without your approval."
        extra={<Flex wrap gap={12}><Link href="/explain/queue">Review queue</Link><Link href="/explain/runs">Past runs</Link><Link href="/explain/metrics">Metrics</Link><Link href="/guide">Guide</Link></Flex>}
      />
      {sampleMode ? <Alert type="info" showIcon title="Sample mode: a built-in stand-in model answers, offline and with no keys." /> : null}
      <Tabs
        items={[
          { key: "week", label: "My week", children: <WeekTab range={range} /> },
          { key: "theses", label: "Theses", children: <ThesesTab range={range} theses={theses} /> },
          { key: "pretrade", label: "Pre-trade", children: <PreTradeTab range={range} plans={plans} /> },
          { key: "reconcile", label: "Reconcile", children: <ReconcileTab range={range} /> },
        ]}
      />
    </div>
  );
}
