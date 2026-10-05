"use client";

import { Button, Result } from "antd";

/** Anything a page throws ends here, in plain words rather than a stack trace. */
export default function PageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Result
      status="error"
      title="This page could not be shown"
      subTitle="Something went wrong while reading the data files. Check that data/ exists and run npm run seed if it is empty."
      extra={
        <Button type="primary" onClick={reset}>
          Try again
        </Button>
      }
    />
  );
}
