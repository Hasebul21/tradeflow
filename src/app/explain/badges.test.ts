import { describe, expect, it } from "vitest";
import { modelUnavailableLabel, scoresText, scoreUnavailable, selfCorrectionBanner } from "./badges";

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
