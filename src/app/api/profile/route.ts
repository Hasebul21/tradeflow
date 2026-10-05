import { NextResponse } from "next/server";
import { loadProfile } from "@/lib/profile";

export const dynamic = "force-dynamic";

/** The owner's preferences. */
export async function GET() {
  return NextResponse.json(await loadProfile());
}
