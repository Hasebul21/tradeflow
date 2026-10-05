/**
 * A hand-written OpenAPI 3.1 description of every JSON endpoint. Served at
 * /api/openapi.json. `openapi.test.ts` fails when a route under src/app/api
 * has no entry here.
 */

type Schema = { [key: string]: unknown };
type Parameter = { name: string; in: "query"; required?: boolean; description: string; schema: Schema };
type Operation = {
  summary: string;
  parameters?: Parameter[];
  requestBody?: { required: boolean; content: { "application/json": { schema: Schema } } };
  responses: Record<string, { description: string; content?: { "application/json": { schema: Schema } } }>;
};
export type OpenApiDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  paths: Record<string, Partial<Record<"get" | "post", Operation>>>;
  components: { schemas: Record<string, Schema> };
};

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (description: string, schema: Schema) => ({ description, content: { "application/json": { schema } } });
const badRequest = json("The request is not valid, for example a date outside the data", ref("Error"));

const asOf: Parameter = {
  name: "as_of",
  in: "query",
  description: "A date as YYYY-MM-DD. Friday and Saturday fall back to Thursday. Default: the last session in the data.",
  schema: { type: "string", format: "date" },
};
const sessions = (fallback: number): Parameter => ({
  name: "sessions",
  in: "query",
  description: `Number of sessions in the window, 1 to 120. Default ${fallback}.`,
  schema: { type: "integer", minimum: 1, maximum: 120, default: fallback },
});
const symbol = (description: string): Parameter => ({ name: "symbol", in: "query", description, schema: { type: "string" } });

const num = { type: "number" };
const nullableNum = { type: ["number", "null"] };
const str = { type: "string" };
const date = { type: "string", format: "date" };

export const openApiDocument: OpenApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Tradeflow",
    version: "0.1.0",
    description: "A DSE portfolio ledger on synthetic data. Every endpoint reads the JSON and CSV files in data/; only /api/what-if takes a body, and it saves nothing.",
  },
  paths: {
    "/api/portfolio": {
      get: {
        summary: "The portfolio view: holdings, P/L, week move, DSEX, dividends and rule findings",
        parameters: [asOf],
        responses: { "200": json("The portfolio as of the date", ref("PortfolioView")), "400": badRequest },
      },
    },
    "/api/transactions": {
      get: {
        summary: "The ledger, oldest first",
        parameters: [asOf],
        responses: { "200": json("Ledger rows", { type: "array", items: ref("Transaction") }), "400": badRequest },
      },
    },
    "/api/announcements": {
      get: {
        summary: "Company announcements, newest first (synthetic)",
        parameters: [
          symbol("One trading code"),
          { name: "from", in: "query", description: "First Dhaka day, YYYY-MM-DD", schema: date },
          { name: "to", in: "query", description: "Last Dhaka day, YYYY-MM-DD", schema: date },
          { ...asOf, description: "Same as `to`" },
        ],
        responses: { "200": json("Announcements", { type: "array", items: ref("Announcement") }), "400": badRequest },
      },
    },
    "/api/attribution": {
      get: {
        summary: "Each holding's and sector's share of the portfolio move, against its sector index and DSEX",
        parameters: [asOf, sessions(5)],
        responses: { "200": json("Attribution", ref("Attribution")), "400": badRequest },
      },
    },
    "/api/sector-indices": {
      get: {
        summary: "Each sector index's move, and DSEX's, over the window",
        parameters: [asOf, sessions(5)],
        responses: {
          "200": json("Sector moves", {
            type: "object",
            properties: { asOf: date, sessions: { type: "integer" }, sectors: { type: "array", items: ref("SectorMove") }, dsex: ref("SectorMove") },
          }),
          "400": badRequest,
        },
      },
    },
    "/api/fundamentals": {
      get: {
        summary: "Reported quarters, quarter-on-quarter change and trailing P/E (synthetic)",
        parameters: [asOf, symbol("One trading code; default every company")],
        responses: {
          "200": json("Fundamentals", { type: "object", properties: { asOf: date, companies: { type: "array", items: ref("FundamentalsSummary") } } }),
          "400": badRequest,
          "404": json("Unknown symbol", ref("Error")),
        },
      },
    },
    "/api/what-if": {
      post: {
        summary: "Preview a trade: holdings, weights and rule findings before and after. Saves nothing",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["symbol", "side", "quantity"],
                properties: {
                  symbol: str,
                  side: { enum: ["buy", "sell"] },
                  quantity: { type: "integer", minimum: 1 },
                  price: { ...nullableNum, description: "Default: the last close" },
                  as_of: date,
                },
              },
            },
          },
        },
        responses: { "200": json("Before and after", ref("WhatIf")), "400": badRequest },
      },
    },
    "/api/reconciliation": {
      get: {
        summary: "Broker statement against the ledger, bank deposits against contributions. Read-only",
        responses: { "200": json("Matches and differences", ref("Reconciliation")) },
      },
    },
    "/api/journal": {
      get: {
        summary: "Trade journal entries, newest first",
        parameters: [symbol("Keep entries for this symbol's trades")],
        responses: { "200": json("Entries", { type: "array", items: ref("JournalEntry") }) },
      },
    },
    "/api/profile": {
      get: { summary: "The owner's preferences", responses: { "200": json("Profile", ref("Profile")) } },
    },
    "/api/health": {
      get: {
        summary: "Liveness and a row count per data file",
        responses: {
          "200": json("Health", {
            type: "object",
            properties: {
              status: { const: "ok" },
              data_dir_readable: { type: "boolean" },
              files: { type: "object", additionalProperties: { type: ["integer", "null"] } },
            },
          }),
        },
      },
    },
    "/api/openapi.json": {
      get: { summary: "This document", responses: { "200": json("OpenAPI 3.1", { type: "object" }) } },
    },
  },
  components: {
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: str } },
      Transaction: {
        type: "object",
        properties: {
          id: str,
          created_at: { type: "string", format: "date-time" },
          symbol: str,
          side: { enum: ["buy", "sell"] },
          quantity: num,
          price_per_share: num,
          category: { type: ["string", "null"] },
          fees_bdt: num,
          account_type: { enum: ["long_term", "trade"] },
        },
      },
      Holding: {
        type: "object",
        properties: {
          symbol: str,
          shares: num,
          avgPrice: num,
          breakEvenPrice: num,
          totalCost: num,
          ltp: nullableNum,
          marketValue: nullableNum,
          unrealizedPl: nullableNum,
          dayChangePct: nullableNum,
          weekChangePct: nullableNum,
          weightPct: nullableNum,
          sector: { type: ["string", "null"] },
        },
      },
      Finding: {
        type: "object",
        properties: { kind: { enum: ["max_position_weight", "sector_target", "trade_plan_reached"] }, message: str },
      },
      PortfolioView: {
        type: "object",
        properties: {
          asOf: { type: ["string", "null"], format: "date" },
          holdings: { type: "array", items: ref("Holding") },
          summary: { type: "object" },
          totalMarketValue: num,
          weekChangeBdt: num,
          weekChangePct: nullableNum,
          totalContributions: num,
          findings: { type: "array", items: ref("Finding") },
          rules: { type: "object" },
          dividendIncomeBdt: num,
          dividends: { type: "array", items: { type: "object" } },
          bonusShares: { type: "array", items: { type: "object" } },
          market: { type: ["object", "null"], properties: { index: str, asOf: date, close: num, weekChangePct: num } },
        },
      },
      Announcement: {
        type: "object",
        properties: {
          id: str,
          symbol: str,
          published_at: { type: "string", format: "date-time" },
          category: { enum: ["earnings", "dividend_declaration", "bonus_declaration", "agm", "price_sensitive", "other"] },
          title: str,
          body: str,
          price_sensitive: { type: "boolean" },
        },
      },
      Attribution: {
        type: "object",
        properties: {
          asOf: date,
          sessions: { type: "integer" },
          fromDate: date,
          toDate: date,
          startValueBdt: num,
          changeBdt: num,
          changePct: nullableNum,
          indexChangePct: nullableNum,
          differencePts: nullableNum,
          holdings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                symbol: str,
                sector: str,
                contributionBdt: num,
                contributionPts: num,
                changePct: num,
                sectorChangePct: nullableNum,
                indexChangePct: nullableNum,
                versusSectorPts: nullableNum,
                comparison: { enum: ["stock-specific", "in line with sector", null] },
              },
            },
          },
          sectors: { type: "array", items: { type: "object", properties: { sector: str, contributionBdt: num, contributionPts: num } } },
        },
      },
      SectorMove: { type: ["object", "null"], properties: { sector: str, close: num, fromDate: date, toDate: date, changePct: num } },
      FundamentalsSummary: {
        type: "object",
        properties: {
          symbol: str,
          quarters: { type: "array", items: { type: "object" } },
          epsChangePct: nullableNum,
          trailingPe: nullableNum,
          peBasis: { enum: ["trailing_4_quarters", "annualised", null] },
        },
      },
      WhatIf: {
        type: "object",
        properties: {
          ok: { const: true },
          asOf: date,
          trade: { type: "object" },
          cashBdt: num,
          before: { type: "object" },
          after: { type: "object" },
          newFindings: { type: "array", items: ref("Finding") },
        },
      },
      Reconciliation: {
        type: "object",
        properties: { trades: { type: "object" }, deposits: { type: "object" }, issueCount: { type: "integer" } },
      },
      JournalEntry: {
        type: "object",
        properties: {
          id: str,
          transaction_id: str,
          created_at: { type: "string", format: "date-time" },
          thesis: str,
          horizon: { enum: ["weeks", "months", "years"] },
          exit_condition: { type: ["string", "null"] },
          tags: { type: "array", items: str },
        },
      },
      Profile: {
        type: "object",
        properties: {
          display_name: str,
          base_currency: str,
          risk_tolerance: { enum: ["low", "medium", "high"] },
          review_day: str,
          investment_goal: str,
          excluded_sectors: { type: "array", items: str },
          notes: { type: ["string", "null"] },
        },
      },
    },
  },
};
