"use client";

import { Button, Card, Col, Form, Input, InputNumber, Row, Select, Tag, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import { WrapText } from "@/components/ui/wrap-text";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { formatShares, money, plainPct, shortDate } from "@/components/format";
import { Findings } from "@/components/ui/findings";
import { PageHeader } from "@/components/ui/page-header";
import { ServerForm } from "@/components/ui/server-form";
import { Signed } from "@/components/ui/signed";
import { EmptyState } from "@/components/ui/states";
import { numeric } from "@/components/ui/table-helpers";
import type { Rules, TradePlan } from "@/lib/data-types";
import type { RuleFinding } from "@/lib/rules";
import { addTradePlan, removeTradePlan, saveLimits } from "./actions";

type SectorRow = { sector: string; target_percent: number; actual: number };

function RemoveButton({ id }: { id: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="small"
      type="link"
      loading={pending}
      onClick={() =>
        start(async () => {
          const fd = new FormData();
          fd.set("id", id);
          await removeTradePlan(fd);
          router.refresh();
        })
      }
    >
      Remove
    </Button>
  );
}

export function RulesView({
  asOf,
  range,
  findings,
  rules,
  sectors,
  prices,
}: {
  asOf: string;
  range: { first: string; last: string } | null;
  findings: RuleFinding[];
  rules: Rules;
  sectors: SectorRow[];
  prices: Record<string, number>;
}) {
  const sectorColumns: TableColumnsType<SectorRow> = [
    { title: "Sector", dataIndex: "sector" },
    { title: "Target", dataIndex: "target_percent", ...numeric, render: (n: number) => plainPct(n) },
    { title: "Actual", dataIndex: "actual", ...numeric, render: (n: number) => plainPct(n) },
    {
      title: "Difference",
      key: "delta",
      ...numeric,
      render: (_: unknown, r) => <Signed value={r.actual - r.target_percent} kind="pts" />,
    },
    {
      title: "Status",
      key: "status",
      render: (_: unknown, r) =>
        Math.abs(r.actual - r.target_percent) > rules.sector_tolerance_pct ? <Tag color="orange">rule broken</Tag> : <Tag color="green">within tolerance</Tag>,
    },
  ];
  const planColumns: TableColumnsType<TradePlan> = [
    { title: "Symbol", dataIndex: "symbol", render: (s: string) => <strong>{s}</strong> },
    { title: "Side", dataIndex: "side", render: (s: string) => <Tag color={s === "buy" ? "green" : "volcano"}>{s}</Tag> },
    { title: "Target", dataIndex: "target_price", ...numeric, render: (n: number) => money(n) },
    { title: "Last price", key: "ltp", ...numeric, render: (_: unknown, p) => money(prices[p.symbol] ?? null) },
    { title: "Shares", dataIndex: "quantity_shares", ...numeric, render: (n: number | null) => (n === null ? "—" : formatShares(n)) },
    {
      title: "Status",
      key: "status",
      render: (_: unknown, p) => {
        if (p.executed) return <Tag>executed</Tag>;
        const price = prices[p.symbol];
        if (price === undefined) return <Tag>no price</Tag>;
        const reached = p.side === "buy" ? price <= p.target_price : price >= p.target_price;
        return reached ? <Tag color="blue">reached</Tag> : <Tag color="default">waiting</Tag>;
      },
    },
    { title: "Note", dataIndex: "note", className: "cell-wrap", render: (n: string | null) => <WrapText width={200}>{n ?? ""}</WrapText> },
    { title: "Added", dataIndex: "created_at", render: (d: string) => shortDate(d) },
    { title: "", key: "remove", render: (_: unknown, p) => <RemoveButton id={p.id} /> },
  ];

  return (
    <div className="stack">
      <PageHeader
        title="Rules"
        purpose="The limits you set for yourself, sector targets against actual weights, and your trade plans, judged at the as-of prices."
        asOf={asOf}
        range={range ?? undefined}
      />
      <Card title="Findings">
        <Findings findings={findings} emptyText="Every rule holds on this date." />
      </Card>
      <Card title="Limits">
        <ServerForm
          action={saveLimits}
          submitLabel="Save limits"
          initialValues={{ max_position_weight_pct: rules.max_position_weight_pct, sector_tolerance_pct: rules.sector_tolerance_pct }}
        >
          <Row gutter={12}>
            <Col xs={12} md={6}>
              <Form.Item label="Max weight of one stock (%)" name="max_position_weight_pct" rules={[{ required: true }]}>
                <InputNumber min={1} max={100} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item label="Sector tolerance (points)" name="sector_tolerance_pct" rules={[{ required: true }]}>
                <InputNumber min={0} max={100} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
          </Row>
        </ServerForm>
      </Card>
      <Card title="Sector targets" extra={<span className="muted">Edit targets in data/rules.json. Actual is by market value.</span>}>
        <DataTable rowKey="sector" size="small" columns={sectorColumns} dataSource={sectors} pagination={false} locale={{ emptyText: <EmptyState message="No sector targets set." /> }} />
      </Card>
      <Card title="Trade plans" extra={<span className="muted">A buy plan is reached when the price falls to its target; a sell plan when it rises to it.</span>}>
        <DataTable rowKey="id" size="small" columns={planColumns} dataSource={rules.trade_plans} pagination={false} locale={{ emptyText: <EmptyState message="No plans yet." /> }} />
        <div style={{ marginTop: 16 }}>
          <ServerForm action={addTradePlan} submitLabel="Add plan" resetOnSuccess initialValues={{ side: "buy" }}>
            <Row gutter={12}>
              <Col xs={12} md={4}>
                <Form.Item label="Symbol" name="symbol" rules={[{ required: true, message: "Type a symbol." }]}>
                  <Input placeholder="GP" />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="Side" name="side">
                  <Select options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }]} />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="Target price" name="target_price" rules={[{ required: true, message: "Type a price." }]}>
                  <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col xs={12} md={4}>
                <Form.Item label="Shares" name="quantity_shares">
                  <InputNumber min={1} step={1} precision={0} style={{ width: "100%" }} />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="Note" name="note">
                  <Input placeholder="Why" />
                </Form.Item>
              </Col>
            </Row>
          </ServerForm>
        </div>
      </Card>
    </div>
  );
}
