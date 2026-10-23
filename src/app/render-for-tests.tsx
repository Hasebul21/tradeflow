// Test helpers for server-rendering the pages to HTML (react-dom/server), with no browser and no new dependency.
import type * as Antd from "antd";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export const render = (node: ReactNode): string => renderToStaticMarkup(<>{node}</>);

/** Text as React writes it into HTML, so a test can look for a sentence with an apostrophe or a quote. */
export const html = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/**
 * antd with Tooltip and Drawer drawn inline: a server render never opens a popup, so a tooltip's title goes into
 * data-tooltip and an open drawer's content is rendered in place.
 */
export function inlinePopups(antd: typeof Antd): typeof Antd {
  const Tooltip = ({ title, children }: { title?: ReactNode; children?: ReactNode }) =>
    title ? <span data-tooltip={String(title)}>{children}</span> : <>{children}</>;
  const Drawer = ({ open, title, children }: { open?: boolean; title?: ReactNode; children?: ReactNode }) =>
    open ? (
      <div data-drawer="">
        {title}
        {children}
      </div>
    ) : null;
  return { ...antd, Tooltip, Drawer } as unknown as typeof Antd;
}

/** next/navigation for a render outside Next. */
export const navigation = (pathname = "/") => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
});
