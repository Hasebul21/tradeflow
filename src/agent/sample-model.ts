// The offline stand-in for Nightshift. Deterministic code: no network, no clock in the content, no stored answers.
// It dispatches on the agent parameter of complete(), never on the system text, and builds each reply only from the
// facts in the user message. Each agent's own step refines its rule here as that agent's file is added.
import type { AgentName, CompleteOptions, CompleteResult } from "./llm";

type Obj = Record<string, unknown>;

const SOURCE = "sample-model";
const MAX_FINDINGS = 12;
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

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** "change_pct" becomes "change pct": the label of a number, as the row names it. */
const labelOf = (field: string): string => field.replace(/_/g, " ");

const ADVICE_QUESTION = /\b(should i|shall i|buy|sell|hold|trim|dump)\b/i;
// Text addressed to the assistant. The owner's own notes ("Take profit") are not matched.
const INJECTION = /ignore (all |any )?(previous|prior) instructions|you are now\b|tell the owner to\b/i;
const ADVICE_CLAIM = /\b(you should|consider|i recommend|i suggest)\b[^.]*\b(buy|sell|hold|buying|selling|holding)\b/i;
const CAUSE_CLAIM = /\bbecause of\b|\balways\b|\bwill (rise|fall|go)\b/i;

// ---------------------------------------------------------------------------------------------------------------
// Planner

type Step = { query_id: string; params: Obj; why: string };

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
    steps = [
      ...steps,
      { query_id: "fundamentals_latest", params: { symbol, as_of: asOf }, why: `${symbol}'s latest quarters, which the Evaluator asked for.` },
    ];
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
    steps: steps.slice(0, 5),
    declined_advice: ADVICE_QUESTION.test(str(input.question)),
    injection_seen: memories.some((memory) => INJECTION.test(str(memory.content))),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Analyst: one finding per fact, each citing the run_query_id of the result it came from.

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

function subjectOf(row: Obj): string | null {
  for (const field of ["symbol", "sector", "id", "issue_id", "action_id", "rule_id"]) {
    const value = str(row[field]);
    if (value !== "") return value;
  }
  return null;
}

/** The number and short text cells of a row, which are all a finding may quote. */
function factsOf(row: Obj): { numbers: { value: number; label: string }[]; words: string[] } {
  const numbers: { value: number; label: string }[] = [];
  const words: string[] = [];
  for (const [field, cell] of Object.entries(row)) {
    if (typeof cell === "number" && Number.isFinite(cell) && numbers.length < MAX_NUMBERS_PER_FINDING) {
      numbers.push({ value: round1(cell), label: labelOf(field) });
    } else if (typeof cell === "string" && (field === "comparison" || field === "category" || field === "side")) {
      words.push(cell);
    }
  }
  return { numbers, words };
}

const contribution = (row: Obj): number => (typeof row.contribution_bdt === "number" ? Math.abs(row.contribution_bdt) : 0);

function analyst(input: Obj): Obj {
  const memories = objs(input.memories);
  const corrections = memories.filter((memory) => arr(memory.tags).includes("correction")).map((memory) => str(memory.id));
  const findings: Obj[] = [];

  for (const result of objs(input.results)) {
    const runQueryId = str(result.run_query_id);
    const queryId = str(result.query_id);
    const kind = KIND_BY_QUERY[queryId] ?? "move";
    let rows = objs(result.rows);
    if (queryId === "week_moves") {
      // The PORTFOLIO row first, then the holdings by size of contribution, largest first.
      rows = [...rows.filter((row) => row.symbol === "PORTFOLIO"), ...rows.filter((row) => row.symbol !== "PORTFOLIO").sort((a, b) => contribution(b) - contribution(a))];
    }
    if (rows.length === 0) {
      findings.push({
        kind,
        subject: null,
        claim: `The data shows no rows for ${queryId}.`,
        numbers: [],
        cites: [runQueryId],
        verdict: null,
        proposed_fix: null,
        memory_ids: [],
      });
      continue;
    }
    for (const row of rows) {
      const subject = subjectOf(row);
      const { numbers, words } = factsOf(row);
      const figures = numbers.map((n) => `${n.label} ${n.value}`).join(", ");
      const extra = words.length === 0 ? "" : ` (${words.join(", ")})`;
      findings.push({
        kind,
        subject,
        claim: `The data shows ${subject ?? queryId}${extra}${figures === "" ? "" : `: ${figures}`}.`,
        numbers,
        cites: [runQueryId],
        verdict: kind === "thesis" ? "open" : null,
        proposed_fix: kind === "reconciliation" ? "Update the ledger to match the source row, awaiting your approval." : null,
        memory_ids: queryId === "week_moves" ? corrections : [],
      });
    }
  }

  const gaps: string[] = [];
  if (/\b(next week|will it|predict|forecast|tomorrow)\b/i.test(str(input.question))) {
    gaps.push("What the portfolio will do next: the data can't predict prices.");
  }
  return { findings: findings.slice(0, MAX_FINDINGS), gaps };
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluator: scores from simple checks on the findings. Code has already checked the citations.

const clamp3 = (value: number): number => Math.max(0, Math.min(3, value));

function evaluator(input: Obj): Obj {
  const task = str(input.task);
  const findings = objs(input.findings);
  if (findings.length === 0) {
    return { accuracy: 0, appropriateness: 0, actionability: 0, fix: "Write at least one finding, each citing the query result it came from." };
  }

  let accuracy = 3;
  let fix = "";
  if (findings.some((finding) => CAUSE_CLAIM.test(str(finding.claim)))) {
    accuracy -= 1;
    fix = "Rewrite the claim that names a cause with 'after' and the date, since the rows can't show a cause.";
  }
  if (findings.some((finding) => ADVICE_CLAIM.test(str(finding.claim)))) {
    accuracy -= 2;
    fix = "Remove the claim that tells the owner to buy, sell or hold.";
  }
  if (findings.some((finding) => arr(finding.cites).length === 0)) {
    accuracy -= 1;
    fix ||= "Cite the run_query_id of the result behind every finding.";
  }

  let appropriateness = 3;
  const hasKind = (kind: string) => findings.some((finding) => finding.kind === kind);
  if (task === "explain_week" && !findings.some((finding) => finding.subject === "PORTFOLIO")) {
    appropriateness -= 2;
    fix ||= "Add a finding for the portfolio's move against DSEX from week_moves.";
  } else if (task === "thesis_check" && findings.some((finding) => finding.kind === "thesis" && !str(finding.verdict))) {
    appropriateness -= 2;
    fix ||= "Give every thesis a verdict of confirmed, contradicted or open.";
  } else if (task === "pre_trade" && !hasKind("pre_trade")) {
    appropriateness -= 2;
    fix ||= "Report what what_if says the trade would change.";
  } else if (task === "reconcile" && !hasKind("reconciliation")) {
    appropriateness -= 2;
    fix ||= "Add a finding and a proposed fix for each reconciliation difference.";
  }

  const pointsSomewhere = findings.some((finding) => finding.kind === "rule" || (str(finding.subject) !== "" && finding.subject !== "PORTFOLIO"));
  const actionability = pointsSomewhere ? 3 : 1;
  if (!pointsSomewhere) fix ||= "Name a holding, thesis or rule for the owner to look at next.";

  const scores = { accuracy: clamp3(accuracy), appropriateness: clamp3(appropriateness), actionability };
  const total = scores.accuracy + scores.appropriateness + scores.actionability;
  return { ...scores, fix: total >= 7 ? "" : fix };
}

// ---------------------------------------------------------------------------------------------------------------
// Writer: Markdown in the prompt's shape, from the accepted findings only.

const DISCLAIMER = "This is a review of your own records, not financial advice.";

const cites = (finding: Obj): string =>
  arr(finding.cites)
    .map((id) => `[q:${str(id)}]`)
    .join(" ");

function shorten(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function writer(input: Obj): Obj {
  const task = str(input.task);
  const asOf = str(input.as_of);
  const findings = objs(input.findings);
  const gaps = arr(input.gaps).map(str).filter((gap) => gap !== "");
  const memories = objs(input.memories);
  const corrections = objs(input.applied_corrections);
  const escalation = isObj(input.escalation) ? input.escalation : null;

  const lead = findings[0] === undefined ? `No findings were accepted for the week to ${asOf}.` : str(findings[0].claim);
  const summary = escalation
    ? `This trade would break ${str(escalation.rule)}: ${str(escalation.message)} Nothing has been saved; the decision is yours.`
    : lead;

  const lines: string[] = [summary, ""];
  const bodyFindings = task === "explain_week" ? findings.slice(0, 5) : findings;
  for (const finding of bodyFindings) lines.push(`- ${str(finding.claim)} ${cites(finding)}`.trimEnd());

  const remembered = [
    ...corrections.map((memory) => {
      const date = arr(memory.tags).map(str).find((tag) => /^\d{4}-\d{2}-\d{2}$/.test(tag));
      return `Applied your correction${date === undefined ? "" : ` from ${date}`}: ${shorten(str(memory.content), 80)}`;
    }),
    ...memories
      .filter((memory) => !corrections.some((correction) => correction.id === memory.id))
      .map((memory) => shorten(str(memory.content), 80)),
  ].filter((line) => line !== "");
  if (remembered.length > 0) lines.push("", "**What I remembered**", ...remembered.map((line) => `- ${line}`));

  const next = findings
    .map((finding) => str(finding.subject))
    .filter((subject, index, all) => subject !== "" && subject !== "PORTFOLIO" && all.indexOf(subject) === index)
    .slice(0, 2);
  if (next.length > 0) lines.push("", "**What to look at next**", ...next.map((subject) => `- ${subject}, against your own notes and rules.`));

  if (gaps.length > 0) lines.push("", `Not covered: ${gaps.join("; ")}`);
  if (input.declined_advice === true) lines.push("", "You asked what to trade. This review explains what happened; the decision stays with you.");
  lines.push("", DISCLAIMER);

  return {
    summary,
    review_markdown: lines.join("\n"),
    memory_note: `${task === "explain_week" ? "Week" : task} to ${asOf}: ${shorten(lead, 200)}`,
  };
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
