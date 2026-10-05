"use client";

import { Alert, Flex, Tag } from "antd";
import type { RuleFinding } from "@/lib/rules";

const LABEL: Record<RuleFinding["kind"], string> = {
  max_position_weight: "Position limit",
  sector_target: "Sector target",
  trade_plan_reached: "Plan reached",
};

/** Broken rules as warnings and reached plans as notes. `fresh` marks findings that are new. */
export function Findings({
  findings,
  fresh,
  emptyText = "Every rule holds.",
}: {
  findings: RuleFinding[];
  fresh?: ReadonlySet<string>;
  emptyText?: string;
}) {
  if (findings.length === 0) return <Alert type="success" showIcon title={emptyText} />;
  return (
    <Flex vertical gap={8} role="list">
      {findings.map((f) => (
        <div role="listitem" key={f.message}>
          <Alert
            type={f.kind === "trade_plan_reached" ? "info" : "warning"}
            showIcon
            title={
              <span>
                <Tag color={f.kind === "trade_plan_reached" ? "blue" : "orange"}>{LABEL[f.kind]}</Tag>
                {fresh?.has(f.message) ? <Tag color="red">New with this trade</Tag> : null}
                {f.message}
              </span>
            }
          />
        </div>
      ))}
    </Flex>
  );
}
