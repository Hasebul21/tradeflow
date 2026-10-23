"use client";

import { Card, Descriptions, Typography } from "antd";
import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { ABOUT, DATES, FIRST_RUN, NEVER, PAGES, PURPOSE, RESULT, RUN_PAGES, RUN_PAGES_NOTE, WORDS, type PageLine, type Term } from "./content";

function PageList({ pages }: { pages: PageLine[] }) {
  return (
    <Descriptions size="small" column={1} bordered>
      {pages.map((p) => (
        <Descriptions.Item key={p.href} label={<Link href={p.href}>{p.name}</Link>}>
          {p.text}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

function TermList({ terms }: { terms: Term[] }) {
  return (
    <Descriptions size="small" column={1} bordered>
      {terms.map((t) => (
        <Descriptions.Item key={t.term} label={t.term}>
          {t.text}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

export function GuideView() {
  return (
    <div className="stack">
      <PageHeader title="Guide" purpose={PURPOSE} />
      <Card size="small" title="What Tradeflow is for">
        <Typography.Paragraph style={{ margin: 0 }}>{ABOUT}</Typography.Paragraph>
      </Card>
      <Card size="small" title="Your first run">
        <Typography>
          <ol style={{ margin: 0 }}>
            {FIRST_RUN.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </Typography>
      </Card>
      <Card size="small" title="How dates work">
        <Typography.Paragraph style={{ margin: 0 }}>{DATES}</Typography.Paragraph>
      </Card>
      <Card size="small" title="What each page is for">
        <PageList pages={PAGES} />
        <Typography.Paragraph type="secondary" style={{ margin: "12px 0 8px" }}>{RUN_PAGES_NOTE}</Typography.Paragraph>
        <PageList pages={RUN_PAGES} />
      </Card>
      <Card size="small" title="What a result shows">
        <TermList terms={RESULT} />
      </Card>
      <Card size="small" title="Words the app uses">
        <TermList terms={WORDS} />
      </Card>
      <Card size="small" title="What it never does">
        <Typography.Paragraph style={{ margin: 0 }}>{NEVER}</Typography.Paragraph>
      </Card>
    </div>
  );
}
