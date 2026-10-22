// Pure helper for the Explain page: splits review text into plain text and [q:<run_query_id>] citations.
import type { Citation } from "@/agent/orchestrator";

export type ReviewPart = { kind: "text"; text: string } | { kind: "cite"; id: string; citation: Citation };

const CITE = /\[q:([A-Za-z0-9_-]+)\]/g;

/** A marker whose id is not among `citations` stays as text, so nothing links to a result that is not there. */
export function splitCitations(text: string, citations: readonly Citation[]): ReviewPart[] {
  const parts: ReviewPart[] = [];
  let last = 0;
  const push = (value: string) => {
    if (value === "") return;
    const tail = parts[parts.length - 1];
    if (tail?.kind === "text") tail.text += value;
    else parts.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(CITE)) {
    const index = match.index ?? 0;
    push(text.slice(last, index));
    const citation = citations.find((c) => c.run_query_id === match[1]);
    if (citation === undefined) push(match[0]);
    else parts.push({ kind: "cite", id: match[1], citation });
    last = index + match[0].length;
  }
  push(text.slice(last));
  return parts;
}
