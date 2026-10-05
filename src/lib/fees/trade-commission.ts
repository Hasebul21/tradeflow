/**
 * Auto broker commission (BDT) on gross trade value (qty × price).
 * Default 0.4% is the same as **৳0.40 per ৳100** turnover (often said as 40 poisha per 100 taka).
 * Example: Comm 8.20 on Amount 2,050.50.
 *
 * Override: set NEXT_PUBLIC_TRADE_COMMISSION_RATE in .env.local (decimal, e.g. 0.004 for 0.4%).
 */

export const DEFAULT_COMMISSION_RATE = 0.004;

export function marketValueBdt(quantity: number, pricePerShare: number): number {
  return quantity * pricePerShare;
}

export function roundBdt(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Commission rate as a decimal (e.g. 0.004 = 0.4%). */
export function getTradeCommissionRate(): number {
  const raw = process.env.NEXT_PUBLIC_TRADE_COMMISSION_RATE?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      return n;
    }
  }
  return DEFAULT_COMMISSION_RATE;
}

/** Commission in BDT for this trade (same rule for buy and sell). */
export function computeTradeCommissionBdt(
  quantity: number,
  pricePerShare: number,
  rate: number = getTradeCommissionRate(),
): number {
  const mv = marketValueBdt(quantity, pricePerShare);
  return roundBdt(mv * rate);
}
