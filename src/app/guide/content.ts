// The Guide page's words, kept as data so a test can check them against what the app does.

export const PURPOSE = "Start here: what Tradeflow does, your first run in five steps, and the words the agents use.";

export const ABOUT =
  "Tradeflow is a portfolio ledger for the Dhaka Stock Exchange on made-up data. A small team of agents explains your week, checks your trade theses, reviews a trade before you save it and explains reconciliation differences, and cites the query behind every number.";

export const FIRST_RUN: string[] = [
  "Open Analysis & Verification from the menu.",
  "Pick the My week tab.",
  "Set the date to 1 Oct 2026.",
  'Type the question "Why did my portfolio move this week?", or click it under the box.',
  'Press "Explain my week" and watch the steps appear under "Working".',
];

export type PageLine = { name: string; href: string; text: string };

export const PAGES: PageLine[] = [
  { name: "Portfolio", href: "/", text: "Holdings, this week's move against DSEX and the rules the portfolio breaks." },
  { name: "Transactions", href: "/transactions", text: "Record a buy or a sell, and preview what it does before you save it." },
  { name: "Journal", href: "/journal", text: "Why you made each trade, written on the day." },
  { name: "Analysis & Verification", href: "/explain", text: "Ask the agents about your week, your theses, a trade or the reconciliation." },
  { name: "History", href: "/history", text: "Every sell with its realised profit or loss, and every dividend and bonus issue." },
  { name: "Guide", href: "/guide", text: "This page." },
  { name: "Market: Announcements", href: "/announcements", text: "Company news." },
  { name: "Market: Instruments", href: "/instruments", text: "Each symbol's price, your holding and its reported earnings." },
  { name: "Market: Sector indices", href: "/sector-indices", text: "Each sector index's move against DSEX." },
  { name: "Records: Sources", href: "/sources", text: "The broker statement and the bank file, as they are." },
  { name: "Records: Reconciliation", href: "/reconciliation", text: "Those files against the ledger." },
  { name: "Records: Invested", href: "/invested", text: "Money put in against the cost and value of open positions." },
  { name: "Records: Rules", href: "/rules", text: "Your limits, sector targets and trade plans." },
  { name: "Records: Settings", href: "/settings", text: "Your preferences." },
];

/** Pages that are not in the menu: linked from the top of the Explain page and from here. */
export const RUN_PAGES: PageLine[] = [
  { name: "Pending Approvals", href: "/explain/queue", text: "Runs that wait for your decision." },
  { name: "Past runs", href: "/explain/runs", text: "Every run, newest first; open one to see its steps." },
  { name: "Metrics", href: "/explain/metrics", text: "Counts across runs, from the trace files." },
];

export const RUN_PAGES_NOTE = "These pages are not in the menu. They are linked from the top of the Analysis & Verification page and from here.";

export type Term = { term: string; text: string };

export const RESULT: Term[] = [
  { term: "Summary", text: "The answer in a few lines." },
  { term: "Review", text: "The full text. Each [name] in it is a citation: click it to see the query and the rows behind a number." },
  { term: "Proof cards", text: "What the run used: data queries (Zetaris or local), memories recalled, model calls (Nemotron) and safety checks (Guards)." },
  { term: "Steps", text: "Each agent action in order. Open the steps shows them on their own page." },
  { term: "Trace (JSON)", text: "The raw record of the run, one line per step." },
];

export const WORDS: Term[] = [
  { term: "Round", text: "One draft and its check. A run makes at most 3." },
  { term: "Citation", text: "A link from a number to the query and rows it came from." },
  { term: "needs_human", text: "The run stopped and waits for your decision, for example after a limit or a trade that breaks a rule. The Pending Approvals page lists these runs." },
  { term: "Sample mode", text: "A built-in stand-in model answers offline, with no keys. The Analysis & Verification page says when it is on." },
  { term: "Real model", text: "The Nemotron model answers through Nightshift." },
];

export const NEVER = "It never tells you to buy, sell or hold. It never saves a trade or changes your records without your approval.";

/** Each page's short name (without its menu group) and its address, for linking page names in the Guide's text. */
export function pageLinks(): Record<string, string> {
  return Object.fromEntries([...PAGES, ...RUN_PAGES].map((p) => [p.name.replace(/^(Market|Records): /, ""), p.href]));
}

export type TextPart = { text: string; href: string | null };

/** Splits text at each page name, longest name first. "Explain my week" is the button's name, so it stays plain text. */
export function splitPageNames(text: string, links: Record<string, string>): TextPart[] {
  const names = Object.keys(links).sort((a, b) => b.length - a.length);
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\b(${escaped.join("|")})\\b(?! my week)`, "g");
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), href: null });
    parts.push({ text: match[0], href: links[match[0]] });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), href: null });
  return parts;
}
