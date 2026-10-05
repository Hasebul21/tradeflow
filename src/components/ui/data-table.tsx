"use client";

import { Table, type TableProps } from "antd";

/** Height of the sticky top bar (60px plus its 1px border), so a sticky table header stops under it instead of sliding over it. */
export const HEADER_HEIGHT = 61;

/**
 * Every table in the app: small, scrolls sideways inside its card when it is
 * wider than the window (columns are never squeezed), and with `sticky` the
 * header sticks just below the top bar.
 */
export function DataTable<T extends object>({ sticky, scroll, size, ...rest }: TableProps<T>) {
  return (
    <Table<T>
      size={size ?? "small"}
      scroll={{ x: "max-content", ...scroll }}
      sticky={sticky ? { offsetHeader: HEADER_HEIGHT } : undefined}
      {...rest}
    />
  );
}
