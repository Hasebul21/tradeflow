"use client";

import { Button, Empty, Result } from "antd";
import Link from "next/link";

/** A page that cannot be shown, in plain words, with a way back. */
export function ErrorState({ title, message }: { title: string; message: string }) {
  return (
    <Result
      status="warning"
      title={title}
      subTitle={message}
      extra={
        <Link href="?">
          <Button type="primary">Show the latest session</Button>
        </Link>
      }
    />
  );
}

export function EmptyState({ message }: { message: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={message} />;
}
