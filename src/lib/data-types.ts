/**
 * The records the app stores. Field names are snake_case on purpose: they
 * mirror the columns of the original Postgres tables, so the same names work
 * unchanged if the JSON files are ever loaded into a SQL engine.
 */
export type { TransactionRow, HoldingRow } from "@/lib/portfolio";

export type AccountType = "long_term" | "trade";

/** One trading session for one symbol. Dates are `YYYY-MM-DD`. */
export type DailyBar = {
  symbol: string;
  bar_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Instrument = {
  symbol: string;
  name: string;
  sector: string;
};

/** Money the owner put into the brokerage account. */
export type Contribution = {
  id: string;
  created_at: string;
  amount_bdt: number;
  note: string | null;
};

export type SectorTarget = {
  sector: string;
  target_percent: number;
};

/** A price the owner has decided to act at. */
export type TradePlan = {
  id: string;
  created_at: string;
  symbol: string;
  side: "buy" | "sell";
  target_price: number;
  quantity_shares: number | null;
  note: string | null;
  executed: boolean;
};

/** The owner's own rules, checked against the live portfolio. */
export type Rules = {
  /** No single stock above this share of the portfolio's market value. */
  max_position_weight_pct: number;
  /** Flag a sector when it drifts further than this from its target. */
  sector_tolerance_pct: number;
  sector_targets: SectorTarget[];
  trade_plans: TradePlan[];
};

export type AnnouncementCategory =
  | "earnings"
  | "dividend_declaration"
  | "bonus_declaration"
  | "agm"
  | "price_sensitive"
  | "other";

/** A company announcement as the exchange publishes it. All of them are synthetic. */
export type Announcement = {
  id: string;
  symbol: string;
  /** ISO instant; the seed uses 11:00 or 15:00 Dhaka. */
  published_at: string;
  category: AnnouncementCategory;
  title: string;
  body: string;
  price_sensitive: boolean;
};

/** A cash dividend or a bonus (stock) dividend. Entitlement is fixed on `record_date`. */
export type CorporateAction = {
  id: string;
  symbol: string;
  kind: "cash_dividend" | "stock_dividend";
  record_date: string;
  /** When the cash is paid or the bonus shares are credited. */
  paid_on: string;
  cash_per_share_bdt: number | null;
  /** Bonus shares per share held: 0.1 is 10 for every 100. */
  bonus_ratio: number | null;
  announcement_id: string | null;
};

/** One daily close of a market index. */
export type IndexBar = {
  index: string;
  bar_date: string;
  close: number;
};

export type JournalHorizon = "weeks" | "months" | "years";

/** Why the owner made one trade, written on the day of the trade. */
export type JournalEntry = {
  id: string;
  /** The `id` of the ledger transaction this note belongs to. */
  transaction_id: string;
  created_at: string;
  thesis: string;
  horizon: JournalHorizon;
  exit_condition: string | null;
  tags: string[];
};

export type RiskTolerance = "low" | "medium" | "high";

/** The owner's preferences. One document; the seed writes synthetic defaults. */
export type Profile = {
  display_name: string;
  base_currency: string;
  risk_tolerance: RiskTolerance;
  /** The weekday the owner reviews the portfolio. */
  review_day: string;
  investment_goal: string;
  /** Sectors the owner does not want to own. */
  excluded_sectors: string[];
  notes: string | null;
};

/** One reported quarter for one company. Synthetic. */
export type Fundamental = {
  symbol: string;
  period_end: string;
  /** When the quarter was made public; a view as of an earlier date must not see it. */
  reported_on: string;
  eps_bdt: number;
  nav_per_share_bdt: number;
  revenue_mn_bdt: number;
  net_profit_mn_bdt: number;
};

/** One daily close of a sector index. Synthetic. */
export type SectorIndexBar = {
  sector: string;
  bar_date: string;
  close: number;
};
