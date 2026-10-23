import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { active, register, release } from "@/agent/registry";
import { POST } from "./[run_id]/cancel/route";

afterEach(() => {
  for (const { run_id } of active()) release(run_id);
});

const cancelRun = (runId: string) => POST(new NextRequest("http://localhost/run/x/cancel", { method: "POST" }), { params: Promise.resolve({ run_id: runId }) });

describe("POST /run/<run_id>/cancel", () => {
  it("answers 400 for a run id that fails the GET /run/<run_id> check", async () => {
    const res = await cancelRun("../etc");
    expect(res.status).toBe(400);
    expect((await res.json()).error.type).toBe("InvalidInput");
    expect((await cancelRun("a b")).status).toBe(400);
  });

  it("answers 404 NotRunning for an id that is not running", async () => {
    const res = await cancelRun("not-running");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.error.type).toBe("NotRunning");
  });

  it("answers 200 cancelled true for a registered run and aborts that run's signal", async () => {
    const signal = register({ run_id: "route-cancel", task: "explain_week" });
    const other = register({ run_id: "route-cancel-other", task: "explain_week" });
    const res = await cancelRun("route-cancel");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ run_id: "route-cancel", cancelled: true });
    expect(signal.aborted).toBe(true);
    expect(other.aborted).toBe(false);
  });
});
