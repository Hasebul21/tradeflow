import { NextResponse } from "next/server";
import { health } from "@/lib/health";

export const dynamic = "force-dynamic";

/** Liveness and a row count per data file. Used by the Docker HEALTHCHECK. */
export async function GET() {
  return NextResponse.json(await health());
}
