import { describe, expect, it } from "vitest";
import { errorAdvice, fallbackText, modelText, shortRunId, statusHint, taskName } from "./names";

describe("plain names for the agent pages", () => {
  it("names each task by its Explain tab and keeps an unknown code", () => {
    expect(taskName("explain_week")).toBe("My week");
    expect(taskName("thesis_check")).toBe("Strategy & Hypotheses");
    expect(taskName("pre_trade")).toBe("Pre-trade");
    expect(taskName("reconcile")).toBe("Audit & Discrepancies");
    expect(taskName("something_new")).toBe("something_new");
    expect(taskName(null)).toBe("-");
  });

  it("says which model answered", () => {
    expect(modelText("sample-model")).toBe("Sample model (offline)");
    expect(modelText("none: code applies an approved fix")).toBe("No model: code only");
    expect(modelText("none")).toBe("No model: code only");
    expect(modelText("nvidia/nemotron-x")).toBe("nvidia/nemotron-x (real model)");
  });

  it("shortens a run id to 8 characters", () => {
    expect(shortRunId("0a80d597-2879-431e-b1a7-64140b6b5431")).toBe("0a80d597");
    expect(shortRunId("example_1")).toBe("example_");
    expect(shortRunId("short")).toBe("short");
  });

  it("explains each status", () => {
    expect(statusHint("success")).toBe("The review passed its checks.");
    expect(statusHint("needs_human")).toBe("The run stopped and waits for your decision.");
    expect(statusHint("error")).toBe("The run could not finish.");
  });

  it("shows the fallback sentence only when a citation fell back", () => {
    expect(fallbackText(0)).toBeNull();
    expect(fallbackText(1)).toBe("1 citation fell back to local data");
    expect(fallbackText(3)).toBe("3 citations fell back to local data");
  });

  it("tells the owner what to do after an error", () => {
    expect(errorAdvice(true)).toBe("Press the button again to retry. If it fails again, open Details.");
    expect(errorAdvice(false)).toBe("Change the inputs above and try again.");
  });

  });
