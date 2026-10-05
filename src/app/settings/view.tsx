"use client";

import { Card, Col, Form, Input, Row, Select } from "antd";
import { PageHeader } from "@/components/ui/page-header";
import { ServerForm } from "@/components/ui/server-form";
import type { Profile } from "@/lib/data-types";
import { saveSettings } from "./actions";

const RISK = ["low", "medium", "high"].map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d) => ({ value: d, label: d }));

export function SettingsView({ profile }: { profile: Profile }) {
  return (
    <div className="stack">
      <PageHeader title="Settings" purpose="Your preferences, saved to data/profile.json. The seeded values are made up." />
      <Card>
        <ServerForm
          action={saveSettings}
          submitLabel="Save settings"
          initialValues={{ ...profile, excluded_sectors: profile.excluded_sectors.join(", "), notes: profile.notes ?? "" }}
        >
          <Row gutter={12}>
            <Col xs={24} md={8}>
              <Form.Item label="Display name" name="display_name" rules={[{ required: true, message: "Type a name." }]}>
                <Input maxLength={60} />
              </Form.Item>
            </Col>
            <Col xs={8} md={4}>
              <Form.Item label="Base currency" name="base_currency" rules={[{ required: true }]}>
                <Input maxLength={3} />
              </Form.Item>
            </Col>
            <Col xs={8} md={6}>
              <Form.Item label="Risk tolerance" name="risk_tolerance">
                <Select options={RISK} />
              </Form.Item>
            </Col>
            <Col xs={8} md={6}>
              <Form.Item label="Review day" name="review_day">
                <Select options={DAYS} />
              </Form.Item>
            </Col>
            <Col xs={24}>
              <Form.Item label="Investment goal" name="investment_goal">
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="Sectors to avoid (comma separated)" name="excluded_sectors">
                <Input placeholder="Tobacco" />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item label="Notes" name="notes">
                <Input />
              </Form.Item>
            </Col>
          </Row>
        </ServerForm>
      </Card>
    </div>
  );
}
