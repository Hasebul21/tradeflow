// The offline stand-in for Nightshift. Deterministic code: no network, no clock in the content, no stored answers.
// It dispatches on the agent parameter of complete(), never on the system text, and builds each reply only from the
// facts in the user message. Each agent's own step refines its rule here as that agent's file is added.
import type { AgentName, CompleteOptions, CompleteResult } from "./llm";
import { proposedFix } from "./reconcile-fix";

type Obj = Record<string, unknown>;

const SOURCE = "sample-model";
const MAX_FINDINGS = 16;
const MAX_NUMBERS_PER_FINDING = 4;

// ---------------------------------------------------------------------------------------------------------------
// Small readers over untyped input. Anything missing or of the wrong type reads as empty.

const isObj = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const objs = (value: unknown): Obj[] => arr(value).filter(isObj);

function parseUser(user: string): Obj {
  try {
    const value: unknown = JSON.parse(user);
    return isObj(value) ? value : {};
  } catch {
    return {};
  }
}

/** yyyy-mm-dd minus a number of days, in UTC. An unparseable date comes back unchanged. */
function minusDays(ymd: string, days: number): string {
  const time = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isNaN(time) ? ymd : new Date(time - days * 86_400_000).toISOString().slice(0, 10);
}

/** One decimal place, rounding the magnitude, as guards.checkCitations does: -2.25 is -2.3, not -2.2. */
const round1 = (value: number): number => Math.sign(value) * (Math.round(Math.abs(value) * 10) / 10);

/** "change_pct" becomes "change pct": the label of a number, as the row names it. */
const labelOf = (field: string): string => field.replace(/_/g, " ");

// A question that asks whether to trade ("should I sell", "should I buy", "go ahead and buy"), not one that names
// a trade or a holding ("Why did GP sell off?", "What do I hold?").
const ADVICE_QUESTION =
  /\b(should|shall|could|can|do|would|must|ought) i (just |also |now |still |rather )?(buy|sell|hold|trim|dump|exit|add)\b|\bgo ahead and (buy|sell)\b|\b(buy|sell|hold) (now|more|it|them|everything|all|out)\b|\btime to (buy|sell)\b|\bbuy or sell\b/i;
// Text addressed to the assistant. The owner's own notes ("Take profit") are not matched.
const INJECTION = /ignore (all |any )?(previous|prior) instructions|you are now\b|tell the owner to\b/i;
const DATE_TAG = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------------------------------------------
// Planner

type Step = { query_id: string; params: Obj; why: string };

const MAX_STEPS = 5;

function planSteps(task: string, asOf: string, trade: Obj | null): Step[] {
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

function planner(input: Obj): Obj {
  const task = str(input.task) || "explain_week";
  const asOf = str(input.as_of);
  const trade = isObj(input.trade) ? input.trade : null;
  const memories = objs(input.memories);
  const catalogue = objs(input.catalogue).map((entry) => str(entry.id));
  const feedback = str(input.feedback);

  let steps = planSteps(task, asOf, trade);

  // Rounds 2 and 3: a symbol the Evaluator named gets its fundamentals, so the plan answers the feedback.
  const named = feedback.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? [];
  const symbol = named.find((token) => token !== "DSEX" && token !== "BDT");
  if (symbol !== undefined && !steps.some((step) => step.query_id === "fundamentals_latest")) {
    const extra: Step = { query_id: "fundamentals_latest", params: { symbol, as_of: asOf }, why: `${symbol}'s latest quarters, which the Evaluator asked for.` };
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

  return {
    focus,
    steps: steps.slice(0, MAX_STEPS),
    declined_advice: ADVICE_QUESTION.test(str(input.question)),
    injection_seen: memories.some((memory) => INJECTION.test(str(memory.content))),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Analyst: findings from the results only, each citing the run_query_id of the row it used and listing the row's
// numbers. A result with no rows is a gap, never a guess. The rules, in the order the findings come out:
//   move        the PORTFOLIO row, then the three holdings with the largest absolute contribution
//   move        "Last week ..." when a memory tagged "review" was recalled, from this run's PORTFOLIO row
//   (feedback)  on a retry, a finding for each symbol or topic the feedback names
//   sector      the sector that moved most against DSEX
//   announcement  each price-sensitive announcement of a holding, "after", never "because of"
//   dividend    each dividend row, paid or owed
//   rule        each rule finding, plus the sector furthest from its target
//   fundamentals  one per symbol with quarters
//   thesis, pre_trade, reconciliation  one per row, refined by the steps that build those tasks

type Num = { value: number; label: string };
type Result = { id: string; query_id: string; params: Obj; rows: Obj[] };

const KIND_BY_QUERY: Record<string, string> = {
  week_moves: "move",
  sector_vs_stock: "sector",
  announcements_between: "announcement",
  fundamentals_latest: "fundamentals",
  dividends_between: "dividend",
  journal_for_symbol: "thesis",
  rule_findings: "rule",
  what_if: "pre_trade",
  reconciliation: "reconciliation",
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The row's numbers for the given fields, labelled as the row names them, at most MAX_NUMBERS_PER_FINDING. */
function numbersOf(row: Obj, fields: readonly string[]): Num[] {
  const out: Num[] = [];
  for (const field of fields) {
    const value = num(row[field]);
    if (value !== null && out.length < MAX_NUMBERS_PER_FINDING) out.push({ value: round1(value), label: labelOf(field) });
  }
  return out;
}

const roseFell = (value: number): string => `${value >= 0 ? "rose" : "fell"} ${Math.abs(round1(value))}%`;
const signed = (value: number): string => String(round1(value));
const aheadBehind = (value: number): string => (value >= 0 ? "ahead of" : "behind");
const overUnder = (value: number): string => (value >= 0 ? "over" : "under");

function finding(kind: string, subject: string, claim: string, numbers: Num[], cites: string[], extra: Obj = {}): Obj {
  return { kind, subject, claim, numbers, cites, verdict: null, proposed_fix: null, memory_ids: [], ...extra };
}

function subjectOf(row: Obj, fallback: string): string {
  for (const field of ["symbol", "sector", "subject", "id", "issue_id", "action_id", "rule_id"]) {
    const value = str(row[field]);
    if (value !== "") return value;
  }
  return fallback;
}

/** The number and short text cells of a row, which are all a generic finding may quote. */
function factsOf(row: Obj): { numbers: Num[]; words: string[] } {
  const numbers: Num[] = [];
  const words: string[] = [];
  for (const [field, cell] of Object.entries(row)) {
    if (typeof cell === "number" && Number.isFinite(cell) && numbers.length < MAX_NUMBERS_PER_FINDING) {
      numbers.push({ value: round1(cell), label: labelOf(field) });
    } else if (typeof cell === "string" && (field === "comparison" || field === "category" || field === "side" || field === "kind")) {
      words.push(cell);
    }
  }
  return { numbers, words };
}

const contribution = (row: Obj): number => Math.abs(num(row.contribution_bdt) ?? 0);

/** The content of a memory, cut on a space before `limit` characters so no figure is cut in half. */
function excerpt(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const cut = trimmed.lastIndexOf(" ", limit);
  return `${trimmed.slice(0, cut > 0 ? cut : limit).trimEnd()}...`;
}

// Words that show the question is about what the portfolio data covers.
const PORTFOLIO_TOPIC = /\b(portfolio|week|weekly|mov(e|es|ed|ing)|rules?|sectors?|holdings?|dividends?|thes[ie]s|trad(e|es|ing)|limit|target|announcements?|earnings|profit|results?)\b/i;
// A topic the question or the feedback names, and the queries whose result covers it.
const TOPICS: readonly { pattern: RegExp; label: string; queries: readonly string[] }[] = [
  { pattern: /\bdividends?\b|\bbonus\b|\bex-date\b/i, label: "dividends", queries: ["dividends_between"] },
  { pattern: /\bannouncements?\b|\bnews\b/i, label: "announcements", queries: ["announcements_between"] },
  { pattern: /\brules?\b|\blimit\b|\btarget\b/i, label: "rules", queries: ["rule_findings"] },
  { pattern: /\bthes[ie]s\b|\bjournal\b/i, label: "theses", queries: ["journal_for_symbol"] },
  { pattern: /\bearnings\b|\bprofit\b|\beps\b|\bfundamentals\b|\bvaluation\b/i, label: "earnings", queries: ["fundamentals_latest", "announcements_between"] },
  { pattern: /\bsectors?\b/i, label: "sectors", queries: ["sector_vs_stock", "week_moves"] },
];

function analyst(input: Obj): Obj {
  // thesis_check: the input carries the theses with their evidence tables; the rules are in thesisFinding.
  if (Array.isArray(input.theses)) return { findings: objs(input.theses).map(thesisFinding), gaps: [] };
  if (str(input.task) === "pre_trade") return preTradeAnalyst(input);
  if (str(input.task) === "reconcile") return reconcileAnalyst(input);
  const task = str(input.task) || "explain_week";
  const question = str(input.question);
  const feedback = str(input.feedback);
  const memories = objs(input.memories);
  const corrections = memories.filter((memory) => arr(memory.tags).includes("correction")).map((memory) => str(memory.id));
  const results: Result[] = objs(input.results).map((result) => ({ id: str(result.run_query_id), query_id: str(result.query_id), params: isObj(result.params) ? result.params : {}, rows: objs(result.rows) }));
  const byQuery = (queryId: string): Result | undefined => results.find((result) => result.query_id === queryId && result.rows.length > 0);
  const has = (queryId: string): boolean => results.some((result) => result.query_id === queryId);

  const findings: Obj[] = [];
  const gaps: string[] = [];
  const hasFinding = (kind: string, subject: string) => findings.some((f) => f.kind === kind && f.subject === subject);

  // The holdings: every symbol the results show as held.
  const held = new Set<string>();
  for (const result of results) {
    for (const row of result.rows) {
      const symbol = str(row.symbol);
      if (symbol === "" || symbol === "PORTFOLIO") continue;
      if (result.query_id === "week_moves" || row.row_type === "position" || row.row_type === "holding") held.add(symbol);
    }
  }

  // move: the PORTFOLIO row, then the three largest contributions.
  const moves = byQuery("week_moves");
  const portfolioRow = moves?.rows.find((row) => row.symbol === "PORTFOLIO");
  const holdingRows = (moves?.rows ?? []).filter((row) => row.symbol !== "PORTFOLIO").sort((a, b) => contribution(b) - contribution(a));
  const moveFinding = (row: Obj): Obj | null => {
    const change = num(row.change_pct);
    const vsSector = num(row.vs_sector_pts);
    if (moves === undefined || change === null) return null;
    const label = str(row.comparison);
    const against = vsSector === null ? "" : `, ${signed(vsSector)} points against its sector index${label === "" ? "" : ` (${label})`}`;
    return finding("move", str(row.symbol), `${str(row.symbol)} ${roseFell(change)} over the week${against}.`, numbersOf(row, ["change_pct", "vs_sector_pts", "sector_change_pct", "contribution_bdt"]), [moves.id], {
      memory_ids: corrections,
    });
  };
  if (moves !== undefined && portfolioRow !== undefined) {
    const change = num(portfolioRow.change_pct) ?? 0;
    const vsIndex = num(portfolioRow.vs_index_pts);
    const index = num(portfolioRow.index_change_pct);
    const against = vsIndex === null ? "" : `, ${Math.abs(round1(vsIndex))} points ${aheadBehind(vsIndex)} DSEX`;
    const dsex = index === null ? "" : ` (DSEX ${roseFell(index)})`;
    findings.push(
      finding("move", "PORTFOLIO", `The data shows the portfolio ${roseFell(change)} over the week${against}${dsex}.`, numbersOf(portfolioRow, ["change_pct", "vs_index_pts", "index_change_pct", "change_bdt"]), [moves.id], {
        memory_ids: corrections,
      }),
    );
    // Last week: compare this week with the review that memory recalled, using this run's numbers and the memory's own figures.
    const review = memories.find((memory) => arr(memory.tags).includes("review"));
    if (review !== undefined) {
      findings.push(
        finding(
          "move",
          "PORTFOLIO",
          `Last week's review said: "${excerpt(str(review.content), 200)}" This week the portfolio ${roseFell(change)}${against}.`,
          numbersOf(portfolioRow, ["change_pct", "vs_index_pts"]),
          [moves.id],
          { memory_ids: [str(review.id)] },
        ),
      );
    }
  }
  const topMoves = holdingRows.slice(0, 3).map(moveFinding).filter((f): f is Obj => f !== null);

  // feedback: on a retry, a finding for each symbol or topic the feedback names, before the rest so it is never cut.
  if (feedback !== "") {
    const named = (feedback.match(/\b[A-Z][A-Z0-9]+\b/g) ?? []).filter((token) => held.has(token) || results.some((result) => result.rows.some((row) => row.symbol === token)));
    for (const symbol of [...new Set(named)]) {
      const fundamentals = byQuery("fundamentals_latest");
      const quarters = fundamentals?.rows.filter((row) => row.symbol === symbol) ?? [];
      const moveRow = holdingRows.find((row) => row.symbol === symbol);
      const announcements = byQuery("announcements_between");
      const announcement = announcements?.rows.find((row) => row.symbol === symbol);
      if (fundamentals !== undefined && quarters.length > 0) findings.push(fundamentalsFinding(fundamentals, symbol, quarters));
      else if (moveRow !== undefined && !topMoves.some((f) => f.subject === symbol)) findings.push(moveFinding(moveRow) as Obj);
      else if (announcements !== undefined && announcement !== undefined) findings.push(announcementFinding(announcements, announcement, moves, moveRow));
      else if (moveRow === undefined) gaps.push(`The feedback names ${symbol}, but no result in this run covers it.`);
    }
    for (const topic of TOPICS) {
      if (topic.pattern.test(feedback) && !topic.queries.some(has)) gaps.push(`The feedback asks about ${topic.label}, but no ${topic.queries.join(" or ")} result is in this run.`);
    }
  }
  findings.push(...topMoves);

  // sector: the sector that moved most against DSEX.
  const sectors = byQuery("sector_vs_stock");
  if (sectors !== undefined) {
    const most = [...sectors.rows].sort((a, b) => Math.abs(num(b.vs_index_pts) ?? 0) - Math.abs(num(a.vs_index_pts) ?? 0))[0];
    const change = num(most.change_pct);
    const vsIndex = num(most.vs_index_pts);
    const index = num(most.index_change_pct);
    if (change !== null) {
      const against = vsIndex === null ? "" : `, ${signed(vsIndex)} points against DSEX`;
      const dsex = index === null ? "" : ` (DSEX ${roseFell(index)})`;
      findings.push(finding("sector", str(most.sector), `The data shows the ${str(most.sector)} index ${roseFell(change)} over the week${against}${dsex}.`, numbersOf(most, ["change_pct", "vs_index_pts", "index_change_pct"]), [sectors.id]));
    }
  }

  // A recalled correction: the sector findings come first, and the first says the correction was applied.
  if (corrections.length > 0) {
    const sectorFindings = findings.filter((f) => f.kind === "sector");
    if (sectorFindings.length > 0) {
      const rest = findings.filter((f) => f.kind !== "sector");
      sectorFindings[0] = { ...sectorFindings[0], claim: `Applying your correction, the sector index comes before DSEX: ${str(sectorFindings[0].claim)}`, memory_ids: corrections };
      findings.splice(0, findings.length, ...sectorFindings, ...rest);
    }
  }

  // announcement: each price-sensitive announcement of a holding (every one when the results show no holdings).
  const announcements = byQuery("announcements_between");
  if (announcements !== undefined) {
    for (const row of announcements.rows) {
      const symbol = str(row.symbol);
      if (row.price_sensitive !== true || (held.size > 0 && !held.has(symbol))) continue;
      findings.push(
        announcementFinding(
          announcements,
          row,
          moves,
          holdingRows.find((r) => r.symbol === symbol),
        ),
      );
    }
  }

  // dividend: each row, paid or owed.
  const dividends = byQuery("dividends_between");
  if (dividends !== undefined) {
    for (const row of dividends.rows) {
      const symbol = str(row.symbol);
      const paid = row.paid === true;
      const moveRow = holdingRows.find((r) => r.symbol === symbol);
      const change = moveRow === undefined ? null : num(moveRow.change_pct);
      const tail = change === null || moves === undefined ? "" : ` ${symbol} ${roseFell(change)} over the week; the ex-date was ${str(row.ex_date)}.`;
      const cites = change === null || moves === undefined ? [dividends.id] : [dividends.id, moves.id];
      if (row.kind === "stock_dividend") {
        const claim = `The data shows ${symbol}'s bonus issue of ${num(row.bonus_shares) ?? 0} shares on ${num(row.shares) ?? 0} held (record date ${str(row.record_date)}) is ${paid ? "credited" : "not yet credited"}.${tail}`;
        findings.push(finding("dividend", symbol, claim, [...numbersOf(row, ["bonus_shares", "shares"]), ...(moveRow === undefined ? [] : numbersOf(moveRow, ["change_pct"]))], cites));
      } else {
        const claim = `The data shows ${symbol}'s cash dividend of Tk ${num(row.cash_per_share_bdt) ?? 0} a share on ${num(row.shares) ?? 0} shares, Tk ${num(row.amount_bdt) ?? 0} in total (record date ${str(row.record_date)}), is ${paid ? `paid, on ${str(row.paid_on)}` : `owed and not yet paid, due ${str(row.paid_on)}`}.${tail}`;
        findings.push(finding("dividend", symbol, claim, [...numbersOf(row, ["cash_per_share_bdt", "shares", "amount_bdt"]), ...(moveRow === undefined ? [] : numbersOf(moveRow, ["change_pct"]))], cites));
      }
    }
  }

  // rule: each rule finding, plus the sector furthest from its target.
  const rules = byQuery("rule_findings");
  if (rules !== undefined) {
    for (const row of rules.rows.filter((r) => r.row_type === "finding")) {
      const subject = str(row.subject) || str(row.symbol) || "rule";
      const actual = num(row.actual_pct);
      const delta = num(row.delta_pct);
      if (row.kind === "max_position_weight" && actual !== null && delta !== null) {
        findings.push(finding("rule", subject, `The data shows ${subject} is ${round1(actual)}% of the portfolio, ${Math.abs(round1(delta))} points ${overUnder(delta)} the ${num(row.limit_pct) ?? 0}% position limit.`, numbersOf(row, ["actual_pct", "limit_pct", "delta_pct"]), [rules.id]));
      } else if (row.kind === "sector_target" && actual !== null && delta !== null) {
        findings.push(finding("rule", subject, `The data shows ${subject} is ${round1(actual)}% of the portfolio against a ${num(row.target_pct) ?? 0}% target, ${Math.abs(round1(delta))} points ${overUnder(delta)}.`, numbersOf(row, ["actual_pct", "target_pct", "delta_pct"]), [rules.id]));
      } else {
        findings.push(finding("rule", subject, `The data shows a ${str(row.kind).replace(/_/g, " ")} finding for ${subject}: ${str(row.message)}`, numbersOf(row, ["target_price", "ltp", "actual_pct", "delta_pct"]), [rules.id]));
      }
    }
    const furthest = rules.rows
      .filter((r) => r.row_type === "sector" && num(r.target_pct) !== null && num(r.delta_pct) !== null)
      .sort((a, b) => Math.abs(num(b.delta_pct) ?? 0) - Math.abs(num(a.delta_pct) ?? 0))[0];
    if (furthest !== undefined) {
      const sector = str(furthest.sector);
      const delta = num(furthest.delta_pct) ?? 0;
      findings.push(
        finding("rule", sector, `The data shows ${sector} is the sector furthest from its target: ${round1(num(furthest.weight_pct) ?? 0)}% of the portfolio against a ${num(furthest.target_pct) ?? 0}% target, ${Math.abs(round1(delta))} points ${overUnder(delta)}.`, numbersOf(furthest, ["weight_pct", "target_pct", "delta_pct"]), [rules.id]),
      );
    }
  }

  // fundamentals: one finding per symbol with quarters, unless the feedback already asked for it.
  for (const result of results.filter((r) => r.query_id === "fundamentals_latest" && r.rows.length > 0)) {
    for (const symbol of [...new Set(result.rows.map((row) => str(row.symbol)))]) {
      if (!hasFinding("fundamentals", symbol)) findings.push(fundamentalsFinding(result, symbol, result.rows.filter((row) => row.symbol === symbol)));
    }
  }

  // thesis, pre_trade, reconciliation, and anything else: one generic finding per row, refined by later steps.
  for (const result of results) {
    if (["week_moves", "sector_vs_stock", "announcements_between", "dividends_between", "rule_findings", "fundamentals_latest"].includes(result.query_id)) continue;
    const kind = KIND_BY_QUERY[result.query_id] ?? "move";
    for (const row of result.rows) {
      const subject = subjectOf(row, result.query_id);
      const { numbers, words } = factsOf(row);
      const figures = numbers.map((n) => `${n.label} ${n.value}`).join(", ");
      const extra = words.length === 0 ? "" : ` (${words.join(", ")})`;
      findings.push(
        finding(kind, subject, `The data shows ${subject}${extra}${figures === "" ? "" : `: ${figures}`}.`, numbers, [result.id], {
          verdict: kind === "thesis" ? "open" : null,
          proposed_fix: kind === "reconciliation" ? "Update the ledger to match the source row, awaiting your approval." : null,
        }),
      );
    }
  }

  // gaps: a result with no rows, what the question asks that no result covers, a prediction, an off-topic question.
  // Worded as analyst.ts's codeGaps words it, so the two read as one gap.
  for (const result of results) {
    if (result.rows.length === 0) gaps.push(`${result.query_id} ${JSON.stringify(result.params)} returned no rows, so this review says nothing it would have shown.`);
  }
  for (const topic of TOPICS) {
    if (topic.pattern.test(question) && !topic.queries.some(has)) gaps.push(`The question asks about ${topic.label}, but no ${topic.queries.join(" or ")} result is in this run.`);
  }
  if (/\b(next week|will it|predict|forecast|tomorrow)\b/i.test(question)) {
    gaps.push("What the portfolio will do next: the data can't predict prices.");
  }
  const namesSymbol = (question.match(/\b[A-Z][A-Z0-9]+\b/g) ?? []).some((token) => held.has(token) || results.some((result) => result.rows.some((row) => row.symbol === token)));
  if (task === "explain_week" && question.trim() !== "" && !ADVICE_QUESTION.test(question) && !PORTFOLIO_TOPIC.test(question) && !namesSymbol) {
    gaps.push(`The question "${question.trim()}" asks for nothing the portfolio data covers; this review reports only what the week's records show.`);
  }

  return { findings: findings.slice(0, MAX_FINDINGS), gaps: [...new Set(gaps)] };
}

// ---------------------------------------------------------------------------------------------------------------
// Analyst for thesis_check: one finding of kind "thesis" per thesis, from its evidence table only.
//   confirmed     the thesis mentions a dividend and a dividend row for the symbol is paid
//   contradicted  the thesis does not mention a dividend, mentions earnings, profit or growth, and EPS is lower than
//                 the quarter before in each of the last two reported quarters; a dividend thesis is settled by its
//                 dividend rows, so it is confirmed or open, never contradicted by EPS
//   open          otherwise
// When the exit condition mentions "two quarters" and EPS fell two quarters in a row, the claim adds that the owner's
// exit condition is met, in the owner's words.

const MENTIONS_DIVIDEND = /\bdividends?\b/i;
const MENTIONS_EARNINGS = /\b(earnings|profit|growth)\b/i;

function thesisFinding(thesis: Obj): Obj {
  const id = str(thesis.journal_id);
  const symbol = str(thesis.symbol);
  const text = str(thesis.thesis);
  const exit = str(thesis.exit_condition);
  const quarters = objs(thesis.eps)
    .filter((row) => num(row.eps_bdt) !== null)
    .sort((a, b) => str(a.period_end).localeCompare(str(b.period_end)));
  const last3 = quarters.slice(-3);
  const eps = last3.map((row) => num(row.eps_bdt) as number);
  const fellTwice = eps.length === 3 && eps[1] < eps[0] && eps[2] < eps[1];
  const dividends = objs(thesis.dividends);
  const paid = dividends.find((row) => row.paid === true);
  const owed = dividends.find((row) => row.paid !== true);
  const epsCites = last3.map((row) => str(row.run_query_id));
  const epsNumbers: Num[] = eps.map((value) => ({ value, label: "eps bdt" }));
  const epsText = `EPS fell from ${eps[0]} to ${eps[1]} to ${eps[2]} over the last three reported quarters`;

  let verdict = "open";
  let claim: string;
  let numbers: Num[] = [];
  let cites: string[] = [];
  if (paid !== undefined && MENTIONS_DIVIDEND.test(text)) {
    verdict = "confirmed";
    const cash = num(paid.cash_per_share_bdt);
    claim =
      cash === null || str(paid.kind) === "stock_dividend"
        ? `Confirmed: ${symbol} credited a bonus issue of ${num(paid.bonus_shares) ?? 0} shares, paid on ${str(paid.paid_on)}`
        : `Confirmed: ${symbol} paid a cash dividend of Tk ${cash} a share, Tk ${num(paid.amount_bdt) ?? 0} in total, on ${str(paid.paid_on)}`;
    numbers = cash === null || str(paid.kind) === "stock_dividend" ? [{ value: num(paid.bonus_shares) ?? 0, label: "bonus shares" }] : [{ value: cash, label: "cash per share bdt" }, { value: num(paid.amount_bdt) ?? 0, label: "amount bdt" }];
    cites = [str(paid.run_query_id)];
  } else if (fellTwice && MENTIONS_EARNINGS.test(text) && !MENTIONS_DIVIDEND.test(text)) {
    verdict = "contradicted";
    claim = `Contradicted: ${epsText}`;
    numbers = epsNumbers;
    cites = epsCites;
  } else {
    const latest = quarters.at(-1);
    if (owed !== undefined && num(owed.cash_per_share_bdt) !== null) {
      claim = `Open: no row settles this thesis; the dividend of Tk ${num(owed.cash_per_share_bdt)} a share is owed, not paid, and is due ${str(owed.paid_on)}`;
      numbers = [{ value: num(owed.cash_per_share_bdt) as number, label: "cash per share bdt" }];
      cites = [str(owed.run_query_id)];
    } else if (latest !== undefined) {
      claim = `Open: no row settles this thesis; the latest reported EPS is ${num(latest.eps_bdt)}`;
      numbers = [{ value: num(latest.eps_bdt) as number, label: "eps bdt" }];
      cites = [str(latest.run_query_id)];
    } else {
      claim = "Open: no EPS, dividend or announcement row since the thesis date settles it";
      cites = [str(thesis.fundamentals_run_query_id)];
    }
  }
  if (/two quarters/i.test(exit) && fellTwice) {
    claim += verdict === "contradicted" ? `, so your exit condition "${exit}" is met` : `; ${epsText}, so your exit condition "${exit}" is met`;
    if (verdict !== "contradicted") {
      numbers = [...numbers, ...epsNumbers];
      cites = [...cites, ...epsCites];
    }
  }
  return finding("thesis", id, `${claim}.`, numbers, [...new Set(cites.filter((cite) => cite !== ""))], { verdict });
}

// ---------------------------------------------------------------------------------------------------------------
// Analyst for pre_trade: from the what_if and journal_for_symbol results only (code ran every query; no tools).
//   pre_trade  one finding: the trade's cost, the symbol's weight and the most-changed sector's weight before and
//              after, then each new rule finding by its kind and message, or that none is new
//   thesis     one finding per journal row for the symbol, verdict null: the trade matches the thesis's direction
//              (the side of the trade it backed) or does not
// A past review in memory that names the symbol is noted on the pre_trade finding. Never approves or rejects.

function preTradeAnalyst(input: Obj): Obj {
  const trade = isObj(input.trade) ? input.trade : {};
  const symbol = str(trade.symbol);
  const side = str(trade.side);
  const results: Result[] = objs(input.results).map((result) => ({ id: str(result.run_query_id), query_id: str(result.query_id), params: isObj(result.params) ? result.params : {}, rows: objs(result.rows) }));
  const whatIf = results.find((result) => result.query_id === "what_if" && result.rows.length > 0);
  const journal = results.find((result) => result.query_id === "journal_for_symbol");
  const findings: Obj[] = [];

  if (whatIf !== undefined) {
    const tradeRow = whatIf.rows.find((row) => row.row_type === "trade") ?? {};
    const holding = whatIf.rows.find((row) => row.row_type === "holding" && row.symbol === symbol);
    const moved = whatIf.rows
      .filter((row) => row.row_type === "sector")
      .sort((a, b) => Math.abs((num(b.weight_after_pct) ?? 0) - (num(b.weight_before_pct) ?? 0)) - Math.abs((num(a.weight_after_pct) ?? 0) - (num(a.weight_before_pct) ?? 0)))[0];
    const newRows = whatIf.rows.filter((row) => row.row_type === "new_finding");
    const numbers: Num[] = [];
    const add = (row: Obj | undefined, field: string, label: string): number | null => {
      const value = row === undefined ? null : num(row[field]);
      if (value !== null) numbers.push({ value: round1(value), label });
      return value === null ? null : round1(value);
    };

    const verb = side === "buy" ? "Buying" : "Selling";
    const quantity = num(tradeRow.quantity);
    const price = num(tradeRow.price);
    const cash = num(tradeRow.cash_bdt);
    const cost = cash === null ? null : Math.abs(cash);
    if (cost !== null) numbers.push({ value: cost, label: "cost bdt" });
    const before = add(holding, "weight_before_pct", `${symbol} weight before pct`);
    const after = add(holding, "weight_after_pct", `${symbol} weight after pct`);
    const sectorBefore = add(moved, "weight_before_pct", "sector weight before pct");
    const sectorAfter = add(moved, "weight_after_pct", "sector weight after pct");
    const target = moved === undefined ? null : num(moved.target_pct);

    const first = `${verb} ${quantity ?? ""} ${symbol}${price === null ? "" : ` at Tk ${price}`} would cost Tk ${cost ?? "unknown"} with commission; ${symbol} would go from ${before ?? "unknown"}% to ${after ?? "unknown"}% of the portfolio${
      moved === undefined ? "" : `, and ${str(moved.sector)} from ${sectorBefore ?? "unknown"}% to ${sectorAfter ?? "unknown"}%${target === null ? "" : ` against a ${target}% target`}`
    }.`.replace(/\s+/g, " ");
    if (target !== null) numbers.push({ value: target, label: "sector target pct" });
    const second =
      newRows.length === 0
        ? "The trade causes no new rule finding: every position limit and sector target that holds today still holds after it."
        : `The trade would newly cause ${newRows.map((row) => `a ${str(row.kind).replace(/_/g, " ")} finding (${str(row.kind)}): ${str(row.message)}`).join(" ")}`;
    const reviews = objs(input.memories).filter((memory) => arr(memory.tags).includes("review") && symbol !== "" && str(memory.content).includes(symbol));
    const memoryNote = reviews.length === 0 ? "" : ` A past review in memory also mentions ${symbol}.`;
    findings.push(finding("pre_trade", symbol || "trade", `${first} ${second}${memoryNote}`, numbers, [whatIf.id], { memory_ids: reviews.map((memory) => str(memory.id)) }));
  }

  if (journal !== undefined) {
    for (const row of journal.rows) {
      const backed = str(row.side);
      const same = backed !== "" && backed === side;
      findings.push(
        finding(
          "thesis",
          str(row.id) || symbol,
          `Your thesis ${str(row.id)} for ${symbol} backed a ${backed || "trade"}, ${same ? "the same direction as this trade" : "the opposite direction to this trade"}: "${str(row.thesis)}".`,
          [],
          [journal.id],
        ),
      );
    }
  }
  return { findings, gaps: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Analyst for reconcile: from the reconciliation and journal_for_symbol results only (code ran every query; no tools).
//   reconciliation  one finding per difference row, subject = its issue_id: what differs and the amounts, as the row
//                   gives them; the reason "not known" unless the row states one; the proposed fix in the form for the
//                   row's kind; a journal entry that refers to the ledger trade is named, and its result cited
// Never says a fix is done.

function reconcileAnalyst(input: Obj): Obj {
  const results: Result[] = objs(input.results).map((result) => ({ id: str(result.run_query_id), query_id: str(result.query_id), params: isObj(result.params) ? result.params : {}, rows: objs(result.rows) }));
  const rec = results.find((result) => result.query_id === "reconciliation");
  const journals = results.filter((result) => result.query_id === "journal_for_symbol");
  if (rec === undefined) return { findings: [], gaps: ["No reconciliation result is in this run, so no difference can be explained."] };

  const findings = rec.rows.map((row) => {
    const issue = str(row.issue_id);
    const v = (field: string): string => String(row[field] ?? "");
    const numbers: Num[] = [];
    const add = (field: string, label: string) => {
      const value = num(row[field]);
      if (value !== null && numbers.length < MAX_NUMBERS_PER_FINDING) numbers.push({ value, label });
    };
    let what: string;
    switch (str(row.kind)) {
      case "mismatched_trade":
        what = `${v("field").replace(/_/g, " ")} differs between ledger ${v("ledger_id")} and broker ${v("ref")} for ${v("side")} ${v("quantity")} ${v("symbol")} on ${v("date")}: broker Tk ${v("broker_value")}, ledger Tk ${v("ledger_value")}, a difference of Tk ${v("difference_bdt")}.`;
        add("broker_value", `broker ${labelOf(v("field"))}`);
        add("ledger_value", `ledger ${labelOf(v("field"))}`);
        add("difference_bdt", "difference bdt");
        break;
      case "ledger_only_trade":
        what = `the ledger has ${v("side")} ${v("quantity")} ${v("symbol")} at Tk ${v("price")} on ${v("date")} (Tk ${v("amount_bdt")}), and the broker statement has no matching row.`;
        add("price", "price");
        add("amount_bdt", "amount bdt");
        break;
      case "broker_only_trade":
        what = `the broker statement ${v("ref")} has ${v("side")} ${v("quantity")} ${v("symbol")} at Tk ${v("price")} on ${v("date")} (Tk ${v("amount_bdt")}${num(row.commission_bdt) === null ? "" : `, commission Tk ${v("commission_bdt")}`}), and the ledger has no matching trade.`;
        add("price", "price");
        add("amount_bdt", "amount bdt");
        add("commission_bdt", "commission bdt");
        break;
      case "bank_only_deposit":
        what = `the bank shows a deposit ${v("ref")} of Tk ${v("amount_bdt")} on ${v("date")}, and no contribution in the ledger matches it.`;
        add("amount_bdt", "amount bdt");
        break;
      case "contribution_only_deposit":
        what = `the ledger has contribution ${v("ledger_id")} of Tk ${v("amount_bdt")} on ${v("date")}, and no bank deposit matches it.`;
        add("amount_bdt", "amount bdt");
        break;
      default:
        what = `the data shows a difference of kind ${v("kind")}.`;
    }
    const reason = str(row.reason).trim() === "" ? "not known" : str(row.reason).trim();
    const ledgerId = str(row.ledger_id);
    const linked = ledgerId === "" ? [] : journals.flatMap((result) => result.rows.filter((entry) => str(entry.transaction_id) === ledgerId).map((entry) => ({ result, entry })));
    const journalNote = linked.length === 0 ? "" : ` Journal entry ${linked.map(({ entry }) => str(entry.id)).join(", ")} refers to this trade.`;
    const cites = [...new Set([rec.id, ...linked.map(({ result }) => result.id)])];
    return finding("reconciliation", issue, `${issue}: ${what} Reason: ${reason}.${journalNote}`, numbers, cites, { proposed_fix: proposedFix(row) });
  });
  return { findings, gaps: [] };
}

/** "<SYMBOL> fell <x>% over the week, after its <category> announcement on <date>: '<title>'": after, never because of. */
function announcementFinding(announcements: Result, row: Obj, moves: Result | undefined, moveRow: Obj | undefined): Obj {
  const symbol = str(row.symbol);
  const category = str(row.category).replace(/_/g, " ");
  const change = moveRow === undefined ? null : num(moveRow.change_pct);
  const when = `${category === "" ? "" : `${category} `}announcement on ${str(row.published_on) || str(row.published_at).slice(0, 10)}: "${str(row.title)}"`;
  if (change !== null && moves !== undefined && moveRow !== undefined) {
    return finding("announcement", symbol, `${symbol} ${roseFell(change)} over the week, after its ${when}.`, numbersOf(moveRow, ["change_pct"]), [moves.id, announcements.id]);
  }
  return finding("announcement", symbol, `The data shows a price-sensitive ${when} for ${symbol}.`, [], [announcements.id]);
}

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight"];
const listOf = (values: readonly number[]): string => (values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`);

/** "<SYMBOL> reported EPS of 2.3, 2.05 and 1.62 over its last three reported quarters, falling": the EPS as reported, from the rows oldest first. */
function fundamentalsFinding(result: Result, symbol: string, quarters: Obj[]): Obj {
  const ordered = [...quarters].sort((a, b) => str(a.period_end).localeCompare(str(b.period_end)));
  const eps = ordered.map((row) => num(row.eps_bdt)).filter((value): value is number => value !== null);
  const numbers: Num[] = eps.slice(-MAX_NUMBERS_PER_FINDING).map((value) => ({ value, label: "eps bdt" }));
  const latest = ordered[ordered.length - 1];
  const pe = num(latest?.trailing_pe);
  if (pe !== null && numbers.length < MAX_NUMBERS_PER_FINDING) numbers.push({ value: pe, label: "trailing pe" });
  const trend = eps.length < 2 ? "" : eps[eps.length - 1] < eps[eps.length - 2] ? ", falling" : eps[eps.length - 1] > eps[eps.length - 2] ? ", rising" : ", flat";
  const list = eps.length === 0 ? "no EPS figure" : `EPS of ${listOf(eps)}`;
  const count = COUNT_WORDS[ordered.length] ?? "";
  const peText = pe === null ? "" : `; its trailing P/E is ${pe}`;
  return finding("fundamentals", symbol, `The data shows ${symbol} reported ${list} over its last ${count === "" ? "" : `${count} `}reported quarter${ordered.length === 1 ? "" : "s"}${trend}${peText}.`, numbers, [result.id]);
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluator: scores from simple checks on the findings. Code has already checked the citations, the guard and the
// coverage. accuracy 3 when every finding has at least one cite and a numbers list (an empty list is fine, as for
// "no rule was broken"), else 1; appropriateness 3 when the task's required kind is present, else 2;
// actionability 3 with two or more findings, else 2; the fix names the missing kind when the total is below 7.

const REQUIRED_KIND: Record<string, { kind: string; query: string }> = {
  explain_week: { kind: "move", query: "week_moves" },
  thesis_check: { kind: "thesis", query: "journal_for_symbol" },
  pre_trade: { kind: "pre_trade", query: "what_if" },
  reconcile: { kind: "reconciliation", query: "reconciliation" },
};

function evaluator(input: Obj): Obj {
  const task = str(input.task) || "explain_week";
  const findings = objs(input.findings);
  if (findings.length === 0) {
    return { accuracy: 0, appropriateness: 0, actionability: 0, fix: "Write at least one finding, each citing the query result it came from." };
  }

  const cited = findings.every((finding) => arr(finding.cites).length > 0 && Array.isArray(finding.numbers));
  const accuracy = cited ? 3 : 1;
  const required = REQUIRED_KIND[task] ?? REQUIRED_KIND.explain_week;
  const hasKind = findings.some((finding) => finding.kind === required.kind);
  const appropriateness = hasKind ? 3 : 2;
  const actionability = findings.length >= 2 ? 3 : 2;
  const total = accuracy + appropriateness + actionability;

  let fix = "";
  if (total < 7) {
    fix = !hasKind
      ? `Add a ${required.kind} finding from ${required.query}: the draft has none.`
      : !cited
        ? "Cite the run_query_id of the result behind every finding and list each figure it uses in numbers."
        : "Add a second finding that names a holding, sector, thesis or rule for the owner to look at next.";
  }
  return { accuracy, appropriateness, actionability, fix };
}

// ---------------------------------------------------------------------------------------------------------------
// Writer: Markdown in the prompt's shape, from the accepted findings only. One bullet per accepted finding, each
// ending with its [q:<run_query_id>] tags, in this order for explain_week: the PORTFOLIO move; the largest holding
// move with its announcement folded in; each rule finding, quoting the rule's message; the sector finding; the
// dividend findings; the "Last week" finding; the remaining moves; then anything else. Every figure comes from a
// finding's numbers, a cited row or a recalled memory, so the Writer's code check passes.

const DISCLAIMER = "This is a review of your own records, not financial advice.";
const MEMORY_NOTE_CHARS = 590;

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
/** 0 to 99 in words ("twenty-seven"); a larger count stays in digits. */
const wordsOf = (n: number): string => (n < 20 ? ONES[n] : n < 100 ? `${TENS[Math.floor(n / 10)]}${n % 10 === 0 ? "" : `-${ONES[n % 10]}`}` : String(n));

const citeTags = (findings: readonly Obj[]): string =>
  [...new Set(findings.flatMap((finding) => arr(finding.cites).map(str)).filter((id) => id !== ""))].map((id) => `[q:${id}]`).join(" ");

/** The value of the finding's number whose label matches, as the Analyst labelled it. */
function numberOf(finding: Obj, label: RegExp): number | null {
  const entry = objs(finding.numbers).find((n) => label.test(str(n.label)));
  return entry === undefined ? null : num(entry.value);
}

/** The cited rows of one query that the Writer was given with the finding. */
const citedRowsOf = (finding: Obj, queryId: string): Obj[] =>
  objs(finding.cited_rows)
    .filter((cited) => str(cited.query_id) === queryId)
    .flatMap((cited) => objs(cited.rows));

const isMove = (finding: Obj): boolean => str(finding.kind) === "move" || str(finding.kind) === "";
const isLastWeek = (finding: Obj): boolean => str(finding.claim).startsWith("Last week");

/** The size of a holding's move: its week_moves row's contribution, else the number labelled contribution. */
function contributionOf(finding: Obj): number {
  const row = citedRowsOf(finding, "week_moves").find((r) => r.symbol === finding.subject);
  return Math.abs(num(row?.contribution_bdt) ?? numberOf(finding, /contribution/i) ?? 0);
}

/** "<SYMBOL> fell 9.8%" from the finding's change figure, or null without one. */
function moveText(finding: Obj): string | null {
  const change = numberOf(finding, /^change (pct|%)$/i) ?? numberOf(finding, /change/i);
  return change === null ? null : `${str(finding.subject)} ${roseFell(change)}`;
}

/** The rule row behind a rule finding: a row_type "finding" row about the subject. */
const ruleRowOf = (finding: Obj): Obj | undefined =>
  citedRowsOf(finding, "rule_findings").find((row) => row.row_type === "finding" && (row.subject === finding.subject || row.symbol === finding.subject));

type Bullet = { text: string; sources: Obj[] };

function weekBullets(findings: Obj[]): Bullet[] {
  const portfolio = findings.find((f) => isMove(f) && f.subject === "PORTFOLIO" && !isLastWeek(f));
  const moves = findings.filter((f) => isMove(f) && f.subject !== "PORTFOLIO" && !isLastWeek(f)).sort((a, b) => contributionOf(b) - contributionOf(a));
  const largest = moves[0];
  const announcement = largest === undefined ? undefined : findings.find((f) => f.kind === "announcement" && f.subject === largest.subject);
  const rules = findings.filter((f) => f.kind === "rule");
  const sectors = findings.filter((f) => f.kind === "sector");
  const dividends = findings.filter((f) => f.kind === "dividend");
  const lastWeek = findings.filter(isLastWeek);

  const bullets: Bullet[] = [];
  if (portfolio !== undefined) bullets.push({ text: str(portfolio.claim), sources: [portfolio] });
  if (largest !== undefined) {
    let text = str(largest.claim);
    const sources = [largest];
    if (announcement !== undefined) {
      const row = citedRowsOf(announcement, "announcements_between").find((r) => r.symbol === announcement.subject && str(r.title) !== "");
      const fromClaim = str(announcement.claim).match(/announcement on (\d{4}-\d{2}-\d{2}): "([^"]*)"/);
      const title = row === undefined ? fromClaim?.[2] : str(row.title);
      const date = row === undefined ? fromClaim?.[1] : str(row.published_on) || str(row.published_at).slice(0, 10);
      text += title === undefined || date === undefined ? ` ${str(announcement.claim)}` : ` It came after "${title}" on ${date}.`;
      sources.push(announcement);
    }
    bullets.push({ text, sources });
  }
  for (const rule of rules) {
    // The "furthest from its target" finding describes a sector, not a broken rule, so it quotes no message.
    const message = /furthest from its target/i.test(str(rule.claim)) ? "" : str(ruleRowOf(rule)?.message);
    bullets.push({ text: `${str(rule.claim)}${message === "" ? "" : ` Rule: "${message}"`}`, sources: [rule] });
  }
  for (const f of [...sectors, ...dividends, ...lastWeek, ...moves.slice(1)]) bullets.push({ text: str(f.claim), sources: [f] });
  const used = new Set(bullets.flatMap((bullet) => bullet.sources));
  for (const f of findings) if (!used.has(f)) bullets.push({ text: str(f.claim), sources: [f] });
  return bullets;
}

/** The memory_note in writer.md's form: for explain_week the rule broken, or none, and the largest move. */
function memoryNote(task: string, asOf: string, findings: Obj[], escalation: Obj | null, lead: string): string {
  let note: string;
  if (task === "explain_week") {
    const rules = findings.filter((f) => f.kind === "rule");
    const limit = rules.find((f) => ruleRowOf(f)?.kind === "max_position_weight" || (ruleRowOf(f) === undefined && /position limit/i.test(str(f.claim))));
    const target = rules.find((f) => ruleRowOf(f)?.kind === "sector_target" || (ruleRowOf(f) === undefined && /\btarget\b/i.test(str(f.claim)) && !/furthest/i.test(str(f.claim))));
    const actual = (f: Obj) => numberOf(f, /actual pct/i);
    if (limit !== undefined && actual(limit) !== null && numberOf(limit, /limit pct/i) !== null) {
      note = `Week to ${asOf}: ${str(limit.subject)} ${actual(limit)}% of the portfolio, above the ${numberOf(limit, /limit pct/i)}% limit.`;
    } else if (limit !== undefined) {
      note = `Week to ${asOf}: ${str(limit.claim)}`;
    } else if (target !== undefined && actual(target) !== null && numberOf(target, /target pct/i) !== null) {
      note = `Week to ${asOf}: ${str(target.subject)} ${actual(target)}% of the portfolio against a ${numberOf(target, /target pct/i)}% target.`;
    } else if (target !== undefined) {
      note = `Week to ${asOf}: ${str(target.claim)}`;
    } else {
      note = `Week to ${asOf}: no rule broken.`;
    }
    const largest = findings.filter((f) => isMove(f) && f.subject !== "PORTFOLIO" && !isLastWeek(f)).sort((a, b) => contributionOf(b) - contributionOf(a))[0];
    const move = largest === undefined ? null : moveText(largest);
    if (move !== null) note = `${note.replace(/\.$/, "")}; ${move}, the largest move.`;
  } else if (task === "thesis_check") {
    const settled = findings.filter((f) => f.kind === "thesis" && str(f.verdict) !== "open").map((f) => `${str(f.subject)} ${str(f.verdict)}`);
    note = `Theses to ${asOf}: ${findings.length === 0 ? "no thesis was checked" : `${settled.length === 0 ? "none settled" : settled.join(", ")}; the rest open`}.`;
  } else if (task === "pre_trade") {
    note = `Pre-trade check on ${asOf}: ${escalation ? `the trade would break ${str(escalation.rule)}: ${str(escalation.message)}` : lead}`;
  } else if (task === "reconcile") {
    const issues = findings.filter((f) => f.kind === "reconciliation").map((f) => str(f.subject));
    note = `Reconciliation on ${asOf}: ${issues.length === 0 ? "no difference was found" : `differences ${issues.join(", ")} open, awaiting your approval`}.`;
  } else {
    note = `${task} to ${asOf}: ${lead}`;
  }
  return excerpt(note, MEMORY_NOTE_CHARS);
}

function writer(input: Obj): Obj {
  const task = str(input.task) || "explain_week";
  const asOf = str(input.as_of);
  const findings = objs(input.findings);
  const gaps = arr(input.gaps).map(str).filter((gap) => gap !== "");
  const memories = objs(input.memories);
  const escalation = isObj(input.escalation) ? input.escalation : null;

  const bullets =
    task === "explain_week"
      ? weekBullets(findings)
      : task === "thesis_check"
        ? findings.map((f): Bullet => ({ text: `${str(f.subject)}: ${str(f.claim)}`, sources: [f] }))
        : task === "reconcile"
          ? findings.map((f): Bullet => ({ text: `${str(f.claim)}${str(f.proposed_fix) === "" ? "" : ` Proposed fix, awaiting your approval: ${str(f.proposed_fix)}.`}`, sources: [f] }))
          : findings.map((f): Bullet => ({ text: str(f.claim), sources: [f] }));
  const lead = findings[0] === undefined ? `No findings were accepted for ${task === "explain_week" ? "the week to" : "the review as of"} ${asOf}.` : str(findings[0].claim);

  // The summary: the PORTFOLIO move against DSEX and the largest holding move, from the findings' own figures.
  let summary = lead;
  if (escalation) {
    summary = `This trade would break ${str(escalation.rule)}: ${str(escalation.message)} Nothing has been saved; the decision is yours.`;
  } else if (task === "reconcile") {
    // The count is written as a word: a count is not a figure of any finding, and the code check allows only those.
    const proposals = findings.filter((f) => f.kind === "reconciliation" && str(f.proposed_fix) !== "").length;
    summary =
      proposals === 0
        ? `Reconciliation on ${asOf}: the ledger matches the broker and bank files; there is nothing to approve.`
        : `Reconciliation on ${asOf}: ${wordsOf(proposals)} ${proposals === 1 ? "difference has a proposed fix" : "differences have proposed fixes"} awaiting your approval. Nothing has been saved; the decision is yours.`;
  } else if (task === "thesis_check" && findings.length > 0) {
    // The counts are written as words: a count is not a figure of any finding, and the code check allows only those.
    const count = (verdict: string) => findings.filter((f) => str(f.verdict) === verdict).length;
    summary = `Of ${wordsOf(findings.length)} theses to ${asOf}: ${wordsOf(count("confirmed"))} confirmed, ${wordsOf(count("contradicted"))} contradicted, ${wordsOf(count("open"))} open.`;
  } else if (task === "explain_week") {
    const portfolio = findings.find((f) => isMove(f) && f.subject === "PORTFOLIO" && !isLastWeek(f));
    const largest = findings.filter((f) => isMove(f) && f.subject !== "PORTFOLIO" && !isLastWeek(f)).sort((a, b) => contributionOf(b) - contributionOf(a))[0];
    const change = portfolio === undefined ? null : numberOf(portfolio, /^change (pct|%)$/i);
    const vsIndex = portfolio === undefined ? null : numberOf(portfolio, /vs index|against dsex/i);
    const first =
      change === null
        ? portfolio === undefined
          ? null
          : str(portfolio.claim).replace(/\.$/, "")
        : `Your portfolio ${roseFell(change)} in the week to ${asOf}${vsIndex === null ? "" : `, ${Math.abs(round1(vsIndex))} points ${aheadBehind(vsIndex)} DSEX`}`;
    const move = largest === undefined ? null : moveText(largest);
    const second = move === null ? null : `${move}, the largest move`;
    if (first !== null) summary = `${first}${second === null ? "" : `; ${second}`}.`;
    else if (second !== null) summary = `${second.charAt(0).toUpperCase()}${second.slice(1)}.`;
  }

  const lines: string[] = [summary, ""];
  for (const bullet of bullets) lines.push(`- ${bullet.text} ${citeTags(bullet.sources)}`.trimEnd());

  // What I remembered: one plain line per recalled memory.
  const remembered = memories.map((memory) => {
    const tags = arr(memory.tags).map(str);
    const date = tags.find((tag) => DATE_TAG.test(tag));
    const content = str(memory.content).trim();
    if (tags.includes("correction")) return `Applied your correction${date === undefined ? "" : ` from ${date}`}: ${content}`;
    if (tags.includes("review")) return `Last week's review${date === undefined ? "" : ` (${date})`}: ${content}`;
    return content;
  });
  if (remembered.length > 0) lines.push("", "**What I remembered**", ...remembered);

  // thesis_check: the settled theses first, the contradicted ones before the rest.
  const rank = (finding: Obj) => (str(finding.verdict) === "contradicted" ? 0 : str(finding.verdict) === "open" ? 2 : 1);
  const next = (task === "thesis_check" ? [...findings].sort((a, b) => rank(a) - rank(b)) : findings)
    .map((finding) => str(finding.subject))
    .filter((subject, index, all) => subject !== "" && subject !== "PORTFOLIO" && all.indexOf(subject) === index)
    .slice(0, 2);
  if (next.length > 0) lines.push("", "**What to look at next**", ...next.map((subject) => `- ${subject}, against your own notes and rules.`));

  if (gaps.length > 0) lines.push("", `Not covered: ${gaps.join("; ")}`);
  if (input.declined_advice === true) lines.push("", "You asked what to trade. This review explains what happened; the decision stays with you.");
  lines.push("", DISCLAIMER);

  return { summary, review_markdown: lines.join("\n"), memory_note: memoryNote(task, asOf, findings, escalation, lead) };
}

// ---------------------------------------------------------------------------------------------------------------
// Memory: a JSON array of the sentences after the first blank line of the user message.

function memorySentences(user: string): string[] {
  const at = user.indexOf("\n\n");
  if (at === -1) return [];
  return (
    user
      .slice(at + 2)
      .match(/[^.!?\n][^.!?\n]*[.!?]*/g)
      ?.map((sentence) => sentence.trim())
      .filter((sentence) => sentence !== "") ?? []
  );
}

// ---------------------------------------------------------------------------------------------------------------
// complete: the same signature as llm.ts's complete().

const charsToTokens = (chars: number): number => Math.ceil(chars / 4);

export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  const started = Date.now();
  const agent: AgentName = options.agent;

  let reply: unknown;
  switch (agent) {
    case "Planner":
      reply = planner(parseUser(options.user));
      break;
    case "Analyst":
      reply = analyst(parseUser(options.user));
      break;
    case "Evaluator":
      reply = evaluator(parseUser(options.user));
      break;
    case "Writer":
      reply = writer(parseUser(options.user));
      break;
    case "Memory":
      reply = memorySentences(options.user);
      break;
  }

  const text = JSON.stringify(reply);
  return {
    text,
    ...(options.json === true && isObj(reply) ? { json: reply } : {}),
    usage: { tokens_in: charsToTokens(options.system.length + options.user.length), tokens_out: charsToTokens(text.length), estimate: true },
    duration_ms: Date.now() - started,
    model_id: SOURCE,
    source: SOURCE,
  };
}
