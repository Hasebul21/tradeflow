"use client";

import { Flex, Typography } from "antd";
import { AsOfPicker, type AsOfRange } from "@/components/ui/as-of-picker";
import { shortDate } from "@/components/format";

/** Title, one line on what the page is for, and the as-of date where the page is time-based. */
export function PageHeader({
  title,
  purpose,
  asOf,
  range,
  extra,
}: {
  title: string;
  purpose: string;
  /** The session the page shows. */
  asOf?: string | null;
  /** Pass to let the reader pick another date. */
  range?: AsOfRange;
  extra?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <Flex wrap justify="space-between" align="flex-end" gap={12}>
        <div>
          <Typography.Title level={1} className="page-title">
            {title}
          </Typography.Title>
          <Typography.Paragraph type="secondary" className="page-purpose">
            {purpose}
          </Typography.Paragraph>
        </div>
        <Flex wrap align="center" gap={12}>
          {asOf ? (
            <Typography.Text type="secondary">
              As of <strong>{shortDate(asOf)}</strong>
            </Typography.Text>
          ) : null}
          {range && asOf ? <AsOfPicker value={asOf} range={range} /> : null}
          {extra}
        </Flex>
      </Flex>
    </header>
  );
}
