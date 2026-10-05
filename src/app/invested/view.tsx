"use client";

import { Card, Col, DatePicker, Form, Input, InputNumber, Row, type TableColumnsType } from "antd";
import { DataTable } from "@/components/ui/data-table";
import dayjs from "dayjs";
import { money, shortDate } from "@/components/format";
import { PageHeader } from "@/components/ui/page-header";
import { ServerForm } from "@/components/ui/server-form";
import { Signed } from "@/components/ui/signed";
import { StatCard } from "@/components/ui/stat-card";
import { EmptyState } from "@/components/ui/states";
import { numeric, pageIf } from "@/components/ui/table-helpers";
import type { Contribution } from "@/lib/data-types";
import { addContribution } from "./actions";

export function InvestedView(props: {
  asOf: string | null;
  rows: Contribution[];
  deposited: number;
  inPositions: number;
  marketValue: number;
  gain: number;
  today: string;
}) {
  const columns: TableColumnsType<Contribution> = [
    { title: "Date", dataIndex: "created_at", render: (d: string) => shortDate(d) },
    { title: "Note", dataIndex: "note", render: (n: string | null) => n ?? "" },
    { title: "Amount", dataIndex: "amount_bdt", ...numeric, render: (n: number) => money(n) },
  ];
  return (
    <div className="stack">
      <PageHeader title="Invested" purpose="Money put into the account, against what is in open positions and what it is worth." asOf={props.asOf} />
      <Row gutter={[12, 12]}>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Deposited" value={money(props.deposited)} hint="Money put into the account" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="In open positions" value={money(props.inPositions)} hint="At cost, fees included" />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Market value" value={money(props.marketValue)} />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <StatCard title="Gain on cost" value={<Signed value={props.gain} />} hint="Market value plus realised, less cost" />
        </Col>
      </Row>
      <Card title="Add a deposit">
        <ServerForm action={addContribution} submitLabel="Add" resetOnSuccess initialValues={{ date: dayjs(props.today), note: "Monthly deposit" }}>
          <Row gutter={12}>
            <Col xs={12} md={6}>
              <Form.Item label="Amount (BDT)" name="amount_bdt" rules={[{ required: true, message: "Type the amount." }]}>
                <InputNumber min={1} step={1000} style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={12} md={6}>
              <Form.Item label="Date" name="date">
                <DatePicker format="D MMM YYYY" style={{ width: "100%" }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="Note" name="note">
                <Input />
              </Form.Item>
            </Col>
          </Row>
        </ServerForm>
      </Card>
      <Card title={`Deposits (${props.rows.length})`}>
        <DataTable rowKey="id" size="small" columns={columns} dataSource={props.rows} pagination={pageIf(props.rows.length)} locale={{ emptyText: <EmptyState message="No deposits yet." /> }} />
      </Card>
    </div>
  );
}
