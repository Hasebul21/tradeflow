import { NextResponse } from "next/server";
import { openApiDocument } from "@/lib/openapi";

/** The OpenAPI 3.1 description of every endpoint. */
export function GET() {
  return NextResponse.json(openApiDocument);
}
