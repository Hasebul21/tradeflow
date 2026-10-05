"use client";

import { DatePicker } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type AsOfRange = { first: string; last: string };

/**
 * Picks the session a page is shown for and puts it in `?as_of=`. Fridays,
 * Saturdays and dates outside the data cannot be picked.
 */
export function AsOfPicker({ value, range }: { value: string; range: AsOfRange }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const go = (d: Dayjs | null) => {
    const next = new URLSearchParams(params?.toString());
    const ymd = d?.format("YYYY-MM-DD");
    if (!ymd || ymd === range.last) next.delete("as_of");
    else next.set("as_of", ymd);
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <label className="as-of-label">
      <span className="sr-only">Show the page as of</span>
      <DatePicker
        aria-label="Show the page as of"
        value={dayjs(value)}
        format="D MMM YYYY"
        allowClear={false}
        onChange={go}
        disabledDate={(d) => {
          const ymd = d.format("YYYY-MM-DD");
          return ymd < range.first || ymd > range.last || d.day() === 5 || d.day() === 6;
        }}
      />
    </label>
  );
}
