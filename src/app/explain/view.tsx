"use client";

import { Alert, Badge, Button, Card, Collapse, DatePicker, Descriptions, Drawer, Flex, Form, Input, InputNumber, Radio, Select, Space, Steps, Tabs, Tag, Typography, type TableColumnsType } from "antd";
import dayjs from "dayjs";
import { useEffect, useRef, useState } from "react";
import type { Citation, RunResult } from "@/agent/orchestrator";
import type { Proof } from "@/agent/proof";
import type { TraceLine } from "@/agent/trace";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/states";
import { adviceBadge, correctionChip, movedBadge, outOfScopeBadge, selfCorrectionBanner } from "./badges";
import { runPreTrade, runTheses, runWeek, sendCorrection, type PreTradeChoice } from "./actions";
import { splitCitations } from "./citations";

type Range = { first: string; last: string };
type Plan = { id: string; label: string };
const POLL_MS = 1500;

const BREAK_ADVICE = "Should I sell BXPHARMA now?";
const BREAK_POEM = "Write me a poem about Dhaka.";
const BREAK_SATURDAY = "2026-09-26";

const QUESTIONS = ["Why did my portfolio move this week?", "Which of my rules are broken this week?", "How does this week compare with last week?"];

// ---------------------------------------------------------------------------------------------------------------
// One run: a client-made run id, a poll of GET /run/<run_id> while the action is awaited, then the result.

type RunState = { running: boolean; runId: string | null; steps: TraceLine[]; started: boolean; result: RunResult | null; proof: Proof | null };

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
  const [state, setState] = useState<RunState>({ running: false, runId: null, steps: [], started: false, result: null, proof: null });
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  const start = async (action: (runId: string) => Promise<RunResult>) => {
    const runId = crypto.randomUUID();
    setState({ running: true, runId, steps: [], started: false, result: null, proof: null });
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
    setState({ running: false, runId, steps: lines, started: lines.length > 0, result, proof });
  };
  return { state, start };
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces of a result.

function StepsList({ steps }: { steps: TraceLine[] }) {
  return (
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
  );
}

const PROOF_CARDS = [
  { key: "zetaris", sponsor: "Zetaris", color: "#1677ff" },
  { key: "meterless", sponsor: "Meterless", color: "#722ed1" },
  { key: "nemotron", sponsor: "Nemotron", color: "#52a41a" },
  { key: "guards", sponsor: "Guards", color: "#fa8c16" },
] as const;

/** The numbers of the Proof cards, each read from the proof counts and nothing else. */
export function proofCards(p: Proof): { key: string; sponsor: string; color: string; big: number; caption: string }[] {
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

function ProofRow({ proof }: { proof: Proof | null }) {
  if (proof === null) return null;
  return (
    <div>
      <Typography.Text strong>Proof</Typography.Text>
      <Flex wrap gap={12} style={{ marginTop: 8 }}>
        {proofCards(proof).map((c) => (
          <Card key={c.key} size="small" style={{ flex: "1 1 200px", borderTop: `4px solid ${c.color}` }} data-testid={`proof-${c.key}`}>
            <Typography.Text style={{ color: c.color }} strong>{c.sponsor}</Typography.Text>
            <div style={{ fontSize: 32, fontWeight: 600, lineHeight: 1.2 }}>{c.big}</div>
            <Typography.Text type="secondary">{c.caption}</Typography.Text>
          </Card>
        ))}
      </Flex>
    </div>
  );
}

function Live({ state }: { state: RunState }) {
  if (!state.running) return null;
  return (
    <Card size="small" title="Working">
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
            <Descriptions.Item label="Run query id">{citation.run_query_id}</Descriptions.Item>
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

function CorrectBox({ runId }: { runId: string }) {
  const { state, start } = useRun();
  const [text, setText] = useState("");
  const added = state.result?.output?.memory_ids_added;
  return (
    <Card size="small" title="Correct this">
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Input.TextArea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should the next review do differently?" />
        <Button loading={state.running} disabled={text.trim() === ""} onClick={() => start((id) => sendCorrection(id, runId, text.trim()))}>
          Send correction
        </Button>
        {state.result?.status === "error" ? <Alert type="error" showIcon title={state.result.error?.type} description={state.result.error?.message} /> : null}
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
        <Tag color={result.status === "success" ? "green" : result.status === "needs_human" ? "orange" : "red"}>{result.status}</Tag>
        <Badge count={`${counts.zetaris} via Zetaris`} color="blue" />
        <Badge count={`${counts.local} local`} color="gray" />
        <Badge count={`${counts.fallback} local-fallback`} color="orange" />
        <Badge count={`${out?.memories_recalled.length ?? 0} memories recalled`} color="purple" />
        <Badge count={`${out?.applied_corrections.length ?? 0} corrections applied`} color="green" />
        {adviceBadge(out) ? <Tag color="green">{adviceBadge(out)}</Tag> : null}
        {movedBadge(state.steps) ? <Tag color="blue">{movedBadge(state.steps)}</Tag> : null}
        {outOfScopeBadge(out) ? <Tag color="gold">{outOfScopeBadge(out)}</Tag> : null}
        {correctionChip(out) ? <Tag color="purple">{correctionChip(out)}</Tag> : null}
        <a href={`/run/${result.run_id}`} target="_blank" rel="noreferrer">Trace (JSON)</a>
      </Flex>
      {selfCorrectionBanner(out, state.steps) ? <Alert type="info" showIcon title={selfCorrectionBanner(out, state.steps)} /> : null}
      <ProofRow proof={state.proof} />
      {result.status === "error" ? (
        <Alert type="error" showIcon title={result.error?.type ?? "Error"} description={result.error?.message} />
      ) : null}
      {out?.escalation ? (
        <Alert
          type="warning"
          showIcon
          title="Nothing has been saved. This trade needs your decision."
          description={`${out.escalation.rule}: ${out.escalation.message}`}
        />
      ) : result.status === "needs_human" ? (
        <Alert type="warning" showIcon title="Needs your attention" description={out?.stop_reason ?? "The run needs a person to decide."} />
      ) : null}
      {out ? (
        <>
          <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
            <Descriptions.Item label="Accepted">{`accepted in round ${out.rounds}`}</Descriptions.Item>
            <Descriptions.Item label="Scores">
              {out.scores ? `accuracy ${out.scores.accuracy}, appropriateness ${out.scores.appropriateness}, actionability ${out.scores.actionability}, total ${out.scores.total} of 9` : "not scored"}
            </Descriptions.Item>
            <Descriptions.Item label="Model">{out.model_source}</Descriptions.Item>
            <Descriptions.Item label="Usage">
              {`${result.usage.model_calls} model calls, ${result.usage.query_calls} query calls, ${result.usage.tokens_in + result.usage.tokens_out} tokens, ${(result.usage.duration_ms / 1000).toFixed(1)} s`}
            </Descriptions.Item>
          </Descriptions>
          {extra}
          <Card size="small" title="Summary">{out.summary}</Card>
          <Card size="small" title="Review">
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
    <Form.Item label="As of">
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
  const { state, start } = useRun();
  const [asOf, setAsOf] = useState(range.last);
  const [question, setQuestion] = useState("");
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Form layout="vertical">
        <AsOf value={asOf} onChange={setAsOf} range={range} />
        <Form.Item label="Question">
          <Input.TextArea rows={2} value={question} onChange={(e) => setQuestion(e.target.value)} />
          <Flex wrap gap={8} style={{ marginTop: 8 }}>
            {QUESTIONS.map((q) => <Tag key={q} style={{ cursor: "pointer" }} onClick={() => setQuestion(q)}>{q}</Tag>)}
          </Flex>
          <Flex wrap gap={8} align="center" style={{ marginTop: 8 }}>
            <Typography.Text type="secondary">Try to break it</Typography.Text>
            <Tag color="red" style={{ cursor: "pointer" }} onClick={() => setQuestion(BREAK_ADVICE)}>{BREAK_ADVICE}</Tag>
            <Tag color="red" style={{ cursor: "pointer" }} onClick={() => setQuestion(BREAK_POEM)}>{BREAK_POEM}</Tag>
            <Tag color="red" style={{ cursor: "pointer" }} onClick={() => { setAsOf(BREAK_SATURDAY); setQuestion(QUESTIONS[0]); }}>{BREAK_SATURDAY}</Tag>
          </Flex>
        </Form.Item>
        <Button type="primary" loading={state.running} disabled={question.trim() === ""} onClick={() => start((id) => runWeek(id, asOf, question.trim()))}>
          Explain my week
        </Button>
      </Form>
      <Live state={state} />
      <Result state={state} />
    </Space>
  );
}

const VERDICT_COLOR: Record<string, string> = { confirmed: "green", contradicted: "red", open: "gold" };

function ThesesTab({ range, theses }: { range: Range; theses: Record<string, string> }) {
  const { state, start } = useRun();
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
    { title: "Journal id", dataIndex: "journal_id" },
    { title: "Symbol", dataIndex: "symbol" },
    { title: "Thesis", dataIndex: "thesis" },
    { title: "Verdict", dataIndex: "verdict", render: (v: string) => <Tag color={VERDICT_COLOR[v] ?? "default"}>{v}</Tag> },
    { title: "Evidence", dataIndex: "evidence" },
  ];
  return (
    <Space orientation="vertical" style={{ width: "100%" }} size="middle">
      <Form layout="inline">
        <AsOf value={asOf} onChange={setAsOf} range={range} />
        <Button type="primary" loading={state.running} onClick={() => start((id) => runTheses(id, asOf))}>Check</Button>
      </Form>
      <Live state={state} />
      <Result
        state={state}
        extra={<DataTable rowKey="key" columns={columns} dataSource={rows} pagination={false} locale={{ emptyText: <EmptyState message="No thesis verdicts." /> }} />}
      />
    </Space>
  );
}

function PreTradeTab({ range, plans }: { range: Range; plans: Plan[] }) {
  const { state, start } = useRun();
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
          <Radio.Button value="trade">Trade</Radio.Button>
          <Radio.Button value="plan" disabled={plans.length === 0}>Open plan</Radio.Button>
        </Radio.Group>
        {mode === "plan" ? (
          <Form.Item label="Open plan"><Select value={planId} onChange={setPlanId} options={plans.map((p) => ({ value: p.id, label: p.label }))} /></Form.Item>
        ) : (
          <Flex wrap gap={12}>
            <Form.Item label="Symbol"><Input value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="EBL" /></Form.Item>
            <Form.Item label="Side"><Select value={side} onChange={setSide} options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} style={{ width: 90 }} /></Form.Item>
            <Form.Item label="Quantity"><InputNumber min={1} precision={0} value={quantity} onChange={setQuantity} /></Form.Item>
            <Form.Item label="Price (optional)"><InputNumber min={0.1} value={price} onChange={setPrice} /></Form.Item>
          </Flex>
        )}
        <Button type="primary" loading={state.running} disabled={!ready} onClick={() => { const c = choice(); if (c) start((id) => runPreTrade(id, asOf, c)); }}>
          Check this trade
        </Button>
      </Form>
      <Live state={state} />
      <Result state={state} />
    </Space>
  );
}

export function ExplainView({ range, theses, plans }: { range: Range; theses: Record<string, string>; plans: Plan[] }) {
  return (
    <div className="stack">
      <PageHeader title="Explain" purpose="Ask the agents to explain your week, check your theses or review a trade before you save it. They never advise and never save anything." asOf={range.last} />
      <Tabs
        items={[
          { key: "week", label: "My week", children: <WeekTab range={range} /> },
          { key: "theses", label: "Theses", children: <ThesesTab range={range} theses={theses} /> },
          { key: "pretrade", label: "Pre-trade", children: <PreTradeTab range={range} plans={plans} /> },
        ]}
      />
    </div>
  );
}
