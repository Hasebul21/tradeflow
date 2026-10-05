/**
 * Text that wraps at spaces inside a table cell of a fixed width. A table
 * sized to its content otherwise takes the full line length as the column
 * width, so long notes would push it wider than the window.
 */
export function WrapText({ children, width = 300 }: { children: React.ReactNode; width?: number }) {
  return (
    <div className="wrap-text" style={{ width }}>
      {children}
    </div>
  );
}
