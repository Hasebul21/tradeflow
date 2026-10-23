// Each open task's default plan, built in code from the input facts only: the standard named queries the task needs
// and, on rounds 2 and 3, the latest quarters of a symbol the Evaluator's fix names. Two callers share it, so the plan
// is written once: the sample model's Planner (sample mode) and the orchestrator's Planner fallback, used when the real
// Planner's call fails after llm.ts gives up (BadJson, a 5xx, a timeout, a 429 or a network error). No network, no
// clock, no stored answer.

type Obj = Record<string, unknown>;

export type DefaultStep = { query_id: string; params: Obj; why: string };
export type DefaultPlan = { focus: string; steps: DefaultStep[] };
export type DefaultPlanInput = {
  task: string;
  as_of: string;
  /** pre_trade only: the trade under review. */
  trade?: Obj | null;
  /** Rounds 2 and 3: the Evaluator's fix. */
  feedback?: string | null;
  /** The query ids the task's catalogue offers; when given, every other step is left out. */
  catalogue?: readonly string[];
  /**
   * The instrument symbols in the data, the list the queries check a symbol against. A word in the feedback is taken
   * as a symbol only when it is in this list, so PORTFOLIO, EPS or any other all-caps word never is. Without it, none is.
   */
  symbols?: ReadonlySet<string>;
};

/** At most this many steps, as the Planner's prompt asks; callers still cut to MAX_PLAN_STEPS. */
const MAX_STEPS = 5;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** yyyy-mm-dd minus a number of days, in UTC. An unparseable date comes back unchanged. */
export function minusDays(ymd: string, days: number): string {
  const time = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(time) ? ymd : new Date(time - days * 86_400_000).toISOString().slice(0, 10);
}

function stepsFor(task: string, asOf: string, trade: Obj | null): DefaultStep[] {
  const weekStart = minusDays(asOf, 7);
  switch (task) {
    case "thesis_check":
      return [
        { query_id: "journal_for_symbol", params: { as_of: asOf }, why: "Every journal thesis with its exit condition." },
        { query_id: "week_moves", params: { as_of: asOf }, why: "The week's moves per holding, with the portfolio total." },
      ];
    case "pre_trade":
      return [
        {
          query_id: "what_if",
          params: { as_of: asOf, symbol: trade?.symbol ?? null, side: trade?.side ?? null, quantity: trade?.quantity ?? null, price: trade?.price ?? null },
          why: "What the trade would do to the weights and the rules.",
        },
        { query_id: "journal_for_symbol", params: { as_of: asOf, symbol: trade?.symbol ?? null }, why: "The owner's thesis for the symbol." },
        { query_id: "rule_findings", params: { as_of: asOf }, why: "The owner's rules as they stand today." },
      ];
    case "reconcile":
      return [{ query_id: "reconciliation", params: {}, why: "Every difference between the broker and bank files and the ledger." }];
    default:
      return [
        { query_id: "week_moves", params: { as_of: asOf }, why: "The week's moves per holding, with the portfolio total." },
        { query_id: "sector_vs_stock", params: { as_of: asOf }, why: "Each sector index against DSEX, to tell sector moves from stock moves." },
        { query_id: "announcements_between", params: { from: weekStart, to: asOf }, why: "Announcements behind any stock-specific move." },
        { query_id: "dividends_between", params: { from: weekStart, to: asOf }, why: "Dividends and bonus shares in the week, behind any fall around a record date." },
        { query_id: "rule_findings", params: { as_of: asOf }, why: "Which of the owner's rules the week broke." },
      ];
  }
}

/** The task's default plan: its standard steps, a feedback instrument symbol's fundamentals, only catalogue ids, at most five. */
export function defaultPlan(input: DefaultPlanInput): DefaultPlan {
  const task = input.task || "explain_week";
  const asOf = input.as_of;
  const feedback = str(input.feedback);
  const catalogue = input.catalogue ?? [];

  let steps = stepsFor(task, asOf, input.trade ?? null);

  // Rounds 2 and 3: a symbol the Evaluator named gets its fundamentals, so the plan answers the feedback. The feedback
  // may be model text, so only a real instrument symbol counts.
  const named = feedback.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? [];
  const symbol = named.find((token) => input.symbols?.has(token) === true);
  if (symbol !== undefined && !steps.some((step) => step.query_id === "fundamentals_latest")) {
    const extra: DefaultStep = { query_id: "fundamentals_latest", params: { symbol, as_of: asOf }, why: `${symbol}'s latest quarters, which the Evaluator asked for.` };
    const rules = steps.findIndex((step) => step.query_id === "rule_findings");
    steps = rules === -1 ? [...steps, extra] : [...steps.slice(0, rules), extra, ...steps.slice(rules)];
    // Five at most: the dividends step gives way, rule_findings stays.
    if (steps.length > MAX_STEPS) steps = steps.filter((step) => step.query_id !== "dividends_between");
  }

  // Only ids the catalogue offers, when the input has one.
  if (catalogue.length > 0) steps = steps.filter((step) => catalogue.includes(step.query_id));

  const focus =
    task === "thesis_check"
      ? `Whether the evidence to ${asOf} settles each of the owner's theses.`
      : task === "pre_trade"
        ? `What the proposed trade would change, as of ${asOf}.`
        : task === "reconcile"
          ? "Where the broker and bank files differ from the ledger."
          : `Why the portfolio moved in the week to ${asOf}, each holding against its sector index.${symbol === undefined ? "" : ` Cover ${symbol}.`}`;

  return { focus, steps: steps.slice(0, MAX_STEPS) };
}
