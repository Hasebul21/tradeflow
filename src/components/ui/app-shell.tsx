"use client";

import { Layout, Menu, type MenuProps } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = [href: string, label: string];

const MAIN: Item[] = [
  ["/", "Portfolio"],
  ["/transactions", "Transactions"],
  ["/journal", "Journal"],
  ["/explain", "Analysis & Verification"],
  ["/history", "History"],
];
const MARKET: Item[] = [
  ["/announcements", "Announcements"],
  ["/instruments", "Instruments"],
  ["/sector-indices", "Sector indices"],
];
const GUIDE: Item = ["/guide", "Guide"];
const RECORDS: Item[] = [
  ["/sources", "Sources"],
  ["/reconciliation", "Reconciliation"],
  ["/invested", "Invested"],
  ["/rules", "Rules"],
  ["/settings", "Settings"],
];

const link = ([href, label]: Item) => ({ key: href, label: <Link href={href}>{label}</Link> });

const ITEMS: MenuProps["items"] = [
  ...MAIN.map(link),
  { key: "market", label: "Market", children: MARKET.map(link) },
  { key: "records", label: "Records", children: RECORDS.map(link) },
  link(GUIDE),
];

/** The item whose path is the longest prefix of the current one. */
function activeKey(pathname: string): string {
  const all = [...MAIN, ...MARKET, ...RECORDS, GUIDE].map(([href]) => href);
  if (pathname === "/") return "/";
  return all.filter((h) => h !== "/" && pathname.startsWith(h)).sort((a, b) => b.length - a.length)[0] ?? "";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const key = activeKey(pathname);
  const group = MARKET.some(([h]) => h === key) ? "market" : RECORDS.some(([h]) => h === key) ? "records" : null;

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Layout.Header className="app-header">
        <Link href="/" className="brand" aria-label="Tradeflow, portfolio">
          Tradeflow
        </Link>
        <nav aria-label="Main" className="app-nav">
          <Menu
            mode="horizontal"
            items={ITEMS}
            selectedKeys={[key, ...(group ? [group] : [])]}
            style={{ borderBottom: "none", flex: 1, minWidth: 0 }}
          />
        </nav>
      </Layout.Header>
      <Layout.Content className="app-content">{children}</Layout.Content>
      <Layout.Footer className="app-footer">
        Synthetic data: every price, trade, deposit, announcement and figure is made up. This is a ledger, not financial
        advice.
      </Layout.Footer>
    </Layout>
  );
}
