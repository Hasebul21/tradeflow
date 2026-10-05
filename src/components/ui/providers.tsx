"use client";

import { App, ConfigProvider } from "antd";
import enGB from "antd/locale/en_GB";

/** The one theme for the whole app: a deep teal brand colour, 8px corners, Source Sans 3 for text. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={enGB}
      theme={{
        token: {
          colorPrimary: "#0f6b5c",
          colorSuccess: "#1b7f4b",
          colorError: "#b3261e",
          colorLink: "#0f6b5c",
          borderRadius: 8,
          fontFamily: "var(--font-sans), system-ui, -apple-system, 'Segoe UI', sans-serif",
          fontSize: 15,
          colorBgLayout: "#f5f6f4",
          colorTextSecondary: "#5b615e",
        },
        components: {
          Layout: { headerBg: "#ffffff", headerHeight: 60, headerPadding: "0 24px" },
          Table: { headerBg: "#f0f3f1", cellPaddingBlockSM: 6 },
          Card: { paddingLG: 20 },
          Statistic: { contentFontSize: 22 },
        },
      }}
    >
      <App>{children}</App>
    </ConfigProvider>
  );
}
