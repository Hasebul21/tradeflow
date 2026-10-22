import { describe, expect, it } from "vitest";
import { STOP_REASONS, STOP_REASON_LABELS } from "@/agent/labels";
import { acceptedText, modelUnavailableLabel, scoresText, scoreUnavailable, selfCorrectionBanner, stopReasonLabel } from "./badges";

const unavailable = [{ agent_name: "Evaluator", action: "score_unavailable", why: "the model returned no answer; the code checks passed" }];

describe("the Explain page's score text", () => {
  it("shows the three scores and the total when the Evaluator scored the draft", () => {
    const output = { scores: { accuracy: 3, appropriateness: 2, actionability: 2, total: 7 } };
    expect(scoresText(output, [])).toBe("accuracy 3, appropriateness 2, actionability 2, total 7 of 9");
  });

  it("reads a null score after score_unavailable as 'score unavailable', never as 0", () => {
    expect(scoreUnavailable(unavailable)).toBe(true);
    expect(scoresText({ scores: null }, unavailable)).toBe("score unavailable: the model returned no answer; the code checks passed");
    expect(scoresText({ scores: null }, [])).toBe("not scored");
    const banner = selfCorrectionBanner({ rounds: 2, scores: null }, [{ agent_name: "Evaluator", action: "reject", why: "cite a row" }, ...unavailable]);
    expect(banner).toBe("Draft 1 rejected: cite a row. Draft 2 accepted, score unavailable.");
  });
});

describe("the Explain page's model_unavailable label", () => {
  it("labels a draft the code built after the model failed, and gives nothing for any other stop", () => {
    expect(modelUnavailableLabel({ stop_reason: "model_unavailable" })).toBe("Draft built by code: the model was unavailable after the queries ran");
    expect(modelUnavailableLabel({ stop_reason: "rounds" })).toBeNull();
    expect(modelUnavailableLabel({ stop_reason: null })).toBeNull();
    expect(modelUnavailableLabel(null)).toBeNull();
  });
});

describe("stop reason labels", () => {
  it("has one plain sentence for every stop code, and none for a code that does not exist", () => {
    expect(Object.keys(STOP_REASON_LABELS).sort()).toEqual([...STOP_REASONS].sort());
    for (const code of STOP_REASONS) {
      const label = STOP_REASON_LABELS[code];
      expect(label.length).toBeGreaterThan(20);
      expect(label).not.toBe(code);
      expect(label).not.toMatch(/^[a-z_]+$/);
    }
  });

  it("labels a stopped run and gives an escalation no stop label", () => {
    expect(stopReasonLabel({ stop_reason: "rounds" })).toBe(STOP_REASON_LABELS.rounds);
    expect(stopReasonLabel({ stop_reason: null })).toBeNull();
    expect(stopReasonLabel(null)).toBeNull();
  });
});

describe("the Explain page's accepted text", () => {
  it("says 'accepted in round N' for success", () => {
    expect(acceptedText("success", { rounds: 2, stop_reason: null })).toBe("accepted in round 2");
  });

  it("gives the stop sentence and never 'accepted' for needs_human", () => {
    const text = acceptedText("needs_human", { rounds: 3, stop_reason: "rounds" });
    expect(text).toBe(STOP_REASON_LABELS.rounds);
    expect(text).not.toMatch(/accepted in round/);
  });

  it("does not say 'accepted in round' for an escalation with no stop code", () => {
    expect(acceptedText("needs_human", { rounds: 1, stop_reason: null })).not.toMatch(/accepted in round/);
  });
});
