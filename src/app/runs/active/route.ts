import { NextResponse } from "next/server";
import { active } from "@/agent/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The runs running in this process: [{ run_id, task, parent_run_id, started_at, elapsed_ms }], oldest first; [] when none. */
export async function GET() {
  return NextResponse.json(active());
}
