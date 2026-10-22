// The offline stand-in for Nightshift. Stub for now: a later step rewrites it as the real deterministic model.
import type { CompleteOptions, CompleteResult } from "./llm";

export async function complete(options: CompleteOptions): Promise<CompleteResult> {
  void options;
  throw new Error("sample model not built yet");
}
