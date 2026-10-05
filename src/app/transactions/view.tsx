"use client";

import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Row, Select, Tag, Typography, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import dayjs from "dayjs";
import { useState } from "react";
import { formatShares, money, plainPct, shortDate } from "@/components/format";
import { Findings } from "@/components/ui/findings";
import { PageHeader } from "@/components/ui/page-header";
import { ServerForm } from "@/components/ui/server-form";
import { Signed } from "@/components/ui/signed";
import { EmptyState } from "@/components/ui/states";
import { numeric, pageIf } from "@/components/ui/table-helpers";
import type { Instrument } from "@/lib/data-types";
import { DEFAULT_COMMISSION_RATE } from "@/lib/fees/trade-commission";
import type { TransactionRow } from "@/lib/portfolio";
import type { WhatIf } from "@/lib/what-if";
import { recordTransaction } from "./actions";

type Preview = Extract<WhatIf, { ok: true }>;
type CompareRow = { symbol: string; sharesBefore: number; sharesAfter: number; weightBefore: number | null; weightAfter: number | null };

function compareRows(p: Preview): CompareRow[] {
  const before = new Map(p.before.holdings.map((h) => [h.symbol, h]));
  const after = new Map(p.after.holdings.map((h) => [h.symbol, h]));
  const symbols = [...new Set([...before.keys(), ...after.keys()])];
  return symbols
    .map((symbol) => ({
      symbol,
      sharesBefore: before.get(symbol)?.shares ?? 0,
      sharesAfter: after.get(symbol)?.shares ?? 0,
      weightBefore: before.get(symbol)?.weightPct ?? null,
      weightAfter: after.get(symbol)?.weightPct ?? null,
    }))
    .sort((a, b) => (a.symbol === p.trade.symbol ? -1 : b.symbol === p.trade.symbol ? 1 : (b.weightAfter ?? 0) - (a.weightAfter ?? 0)))
    .slice(0, 6);
}

function PreviewBox({ p }: { p: Preview }) {
  const fresh = new Set(p.newFindings.map((f) => f.message));
  const sectorBefore = new Map(p.before.sectors.map((s) => [s.sector, s.weightPct]));
  const columns: TableColumnsType<CompareRow> = [
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => (s === p.trade.symbol ? <strong>{s}</strong> : s) },
    { title: "Shares before", dataIndex: "sharesBefore", ...numeric, render: (n: number) => formatShares(n) },
    { title: "Shares after", dataIndex: "sharesAfter", ...numeric, render: (n: number) => formatShares(n) },
    { title: "Weight before", dataIndex: "weightBefore", ...numeric, render: (n: number | null) => plainPct(n) },
    { title: "Weight after", dataIndex: "weightAfter", ...numeric, render: (n: number | null) => plainPct(n) },
    {
      title: "Change",
      key: "change",
      ...numeric,
      render: (_: unknown, r) => <Signed value={(r.weightAfter ?? 0) - (r.weightBefore ?? 0)} kind="pts" />,
    },
  ];
  return (
    <section aria-label="Trade preview" className="preview-box">
      <Typography.Title level={3} style={{ fontSize: 16, marginTop: 0 }}>
        Preview: {p.trade.side} {formatShares(p.trade.quantity)} {p.trade.symbol} at {money(p.trade.price)}, at the close of {shortDate(p.asOf)}
      </Typography.Title>
      <Typography.Paragraph>
        {p.trade.side === "buy" ? "Cash needed" : "Cash received"}: <strong className="num">{money(Math.abs(p.cashBdt))}</strong>, including
        commission of <span className="num">{money(p.trade.commissionBdt)}</span>. Nothing is saved until you press Record.
      </Typography.Paragraph>
      <DataTable rowKey="symbol" size="small" columns={columns} dataSource={compareRows(p)} pagination={false} />
      {p.newFindings.length > 0 ? (
        <Alert
          style={{ marginTop: 12 }}
          type="error"
          showIcon
          title={`This trade would break ${p.newFindings.length === 1 ? "a rule" : `${p.newFindings.length} rules`} that holds today.`}
        />
      ) : (
        <Alert style={{ marginTop: 12 }} type="success" showIcon title="This trade breaks no rule that holds today." />
      )}
      <div style={{ marginTop: 12 }}>
        <Typography.Text strong>Rules after the trade</Typography.Text>
        <div style={{ marginTop: 8 }}>
          <Findings
            findings={p.after.findings.filter((f) => f.kind !== "trade_plan_reached")}
            fresh={fresh}
            emptyText="Every rule would hold."
          />
        </div>
        {p.after.sectors.length ? (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Sectors after:{" "}
            {p.after.sectors
              .sort((a, b) => b.weightPct - a.weightPct)
              .map((s) => `${s.sector} ${plainPct(s.weightPct)} (was ${plainPct(sectorBefore.get(s.sector) ?? 0)})`)
              .join("; ")}
          </Typography.Paragraph>
        ) : null}
      </div>
    </section>
  );
}

/** The preview's as-of date: the trade date, but no later than the last session with prices. */
function previewDate(tradeDate: string | null, lastSession: string | null): string | null {
  if (!tradeDate || !lastSession) return tradeDate;
  return tradeDate > lastSession ? lastSession : tradeDate;
}

function Ledger({ rows }: { rows: TransactionRow[] }) {
  const columns: TableColumnsType<TransactionRow> = [
    { title: "Date", dataIndex: "created_at", render: (d: string) => shortDate(d) },
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <strong>{s}</strong> },
    { title: "Side", dataIndex: "side", render: (s: string) => <Tag color={s === "buy" ? "green" : "volcano"}>{s}</Tag> },
    { title: "Account", dataIndex: "account_type", render: (a?: string) => (a === "trade" ? "Trade" : "Long-term") },
    { title: "Shares", dataIndex: "quantity", ...numeric, render: (q: number) => formatShares(Number(q)) },
    { title: "Price", dataIndex: "price_per_share", ...numeric, render: (p: number) => money(Number(p)) },
    { title: "Fees", dataIndex: "fees_bdt", ...numeric, render: (f: number) => money(Number(f ?? 0)) },
    { title: "Gross", key: "gross", ...numeric, render: (_: unknown, t) => money(Number(t.quantity) * Number(t.price_per_share)) },
    {
      title: "Net cash",
      key: "net",
      ...numeric,
      render: (_: unknown, t) => {
        const gross = Number(t.quantity) * Number(t.price_per_share);
        const fees = Number(t.fees_bdt ?? 0);
        return <Signed value={t.side === "buy" ? -(gross + fees) : gross - fees} />;
      },
    },
  ];
  return (
    <Card title={`Ledger (${rows.length} trades)`}>
      <DataTable
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        pagination={pageIf(rows.length)}
        sticky
        locale={{ emptyText: <EmptyState message="No trades yet. Record one above." /> }}
      />
    </Card>
  );
}

export function TransactionsView({
  rows,
  instruments,
  today,
  lastSession,
}: {
  rows: TransactionRow[];
  instruments: Instrument[];
  today: string;
  /** The last session with prices; a preview for a later date uses it. */
  lastSession: string | null;
}) {
  const [form] = Form.useForm();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runPreview = async () => {
    const v = form.getFieldsValue();
    setLoading(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/what-if", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: v.symbol,
          side: v.side,
          quantity: v.quantity,
          price: v.price_per_share ?? null,
          as_of: previewDate(v.trade_date?.format("YYYY-MM-DD") ?? null, lastSession),
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        setPreview(null);
        setPreviewError(body.error ?? "The preview could not be made.");
      } else {
        setPreview(body as Preview);
      }
    } catch {
      setPreviewError("The preview could not be made. Is the server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stack">
      <PageHeader title="Transactions" purpose="Record a buy or a sell, preview what it does to your rules first, and see the full ledger." />

      <Card title="Record a trade">
        <ServerForm
          action={recordTransaction}
          submitLabel="Record"
          form={form}
          resetOnSuccess
          initialValues={{ side: "buy", trade_date: dayjs(today), horizon: undefined }}
          extraButtons={
            <Button onClick={runPreview} loading={loading}>
              Preview
            </Button>
          }
        >
          <Row gutter={12}>
            <Col xs={24} sm={12} lg={6}>
              <Form.Item label="Symbol" name="symbol" rules={[{ required: true, message: "Pick a symbol." }]}>
                <Select
                  showSearch
                  placeholder="GP"
                  options={instruments.map((i) => ({ value: i.symbol, label: `${i.symbol} · ${i.name}` }))}
                />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6} lg={3}>
              <Form.Item label="Side" name="side" rules={[{ required: true }]}>
                <Select options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={6} lg={3}>
              <Form.Item label="Shares" name="quantity" rules={[{ required: true, message: "How many shares?" }]}>
                <InputNumber min={1} step={1} precision={0} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8} lg={4}>
              <Form.Item label="Price per share" name="price_per_share" extra="Blank: Preview uses the last close.">
                <InputNumber min={0} step={0.1} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={12} sm={8} lg={4}>
              <Form.Item label="Fees" name="fees_bdt" extra={`Blank: ${DEFAULT_COMMISSION_RATE * 100}% of the value.`}>
                <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} sm={8} lg={4}>
              <Form.Item label="Date" name="trade_date">
                <DatePicker format="D MMM YYYY" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col xs={24} md={10}>
              <Form.Item label="Why (saved to the journal)" name="thesis">
                <Input placeholder="Buying for the dividend" />
              </Form.Item>
            </Col>
            <Col xs={12} md={4}>
              <Form.Item label="Horizon" name="horizon">
                <Select
                  allowClear
                  placeholder="Pick one"
                  options={[
                    { value: "weeks", label: "Weeks" },
                    { value: "months", label: "Months" },
                    { value: "years", label: "Years" },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={12} md={10}>
              <Form.Item label="Exit condition" name="exit_condition">
                <Input placeholder="Sell if the dividend is cut" />
              </Form.Item>
            </Col>
            <Col xs={24} md={10}>
              <Form.Item label="Tags (comma separated)" name="tags">
                <Input placeholder="dividend, defensive" />
              </Form.Item>
            </Col>
          </Row>
        </ServerForm>
        {previewError ? <Alert style={{ marginTop: 16 }} type="error" showIcon title={previewError} /> : null}
        {preview ? <PreviewBox p={preview} /> : null}
      </Card>

      <Ledger rows={rows} />
    </div>
  );
}
