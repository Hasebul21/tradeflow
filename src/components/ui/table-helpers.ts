import type { TablePaginationConfig } from "antd";

/** Numeric column props: right-aligned, tabular figures. */
export const numeric = { align: "right" as const, className: "num" };

/** Paginate only long tables. */
export function pageIf(rows: number, size = 25): false | TablePaginationConfig {
  return rows > size ? { pageSize: size, showSizeChanger: false, hideOnSinglePage: true } : false;
}
