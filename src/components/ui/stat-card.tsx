"use client";

import { Card, Statistic, Typography } from "antd";

/** One headline number, with a short hint under it. */
export function StatCard({ title, value, hint }: { title: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card size="small" style={{ height: "100%" }}>
      <Statistic title={title} valueRender={() => <span className="num stat-value">{value}</span>} />
      {hint ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      ) : null}
    </Card>
  );
}
