import { describe, expect, it, vi } from "vitest";

vi.mock("antd", async (importOriginal) => (await import("../../../render-for-tests")).inlinePopups(await importOriginal()));

import { summarise } from "@/agent/trace-read";
import { render } from "../../../render-for-tests";
import { line, PROOF } from "../../fixtures-for-tests";
import { STEPS_HELP } from "../../names";
import { RunView } from "./view";

describe("one run's steps", () => {
  it("2 and 11: titled Run steps, with the run id in a row, a link back to Explain and what each agent does", () => {
    const lines = [line()];
    const page = render(<RunView runId="run-1" lines={lines} proof={PROOF} done={false} summary={summarise("run-1", lines)} />);
    expect(page).toContain(">Run steps<");
    expect(page).not.toContain(">Run run-1<");
    expect(page).toContain(">Run id<");
    expect(page).toContain(">run-1<");
    expect(page).toContain('href="/explain"');
    expect(page).toContain(STEPS_HELP);
  });
});
