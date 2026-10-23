// Prompt guard (run before each prompt by guard-adapter.mjs): stops a chat message that contains a key, so it never reaches the model provider.
// Reads {"prompt", ...} on stdin; prints {"continue": true | false, "user_message"}.
import { readFileSync } from "node:fs";

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let prompt = "";
  try {
    prompt = JSON.parse(input).prompt ?? "";
  } catch {
    // Unreadable input: nothing to match against, so let it through.
  }
  const key = /nvapi-[A-Za-z0-9_-]{20,}|(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|postgres(ql)?:\/\/[^:\/ ]+:[^@ <>]+@|BEGIN (RSA|OPENSSH) PRIVATE KEY/;
  // Meterless and Zetaris keys and the passwords have no published prefix, so also look for their values from .env.
  let env = "";
  try {
    env = readFileSync(".env", "utf8");
  } catch {
    // No .env: there are no values to compare.
  }
  const names = ["METERLESS_API_KEY", "METERLESS_RUNTIME_TOKEN", "NVIDIA_API_KEY", "MODEL_API_KEY", "ZETARIS_API_KEY", "ZETARIS_PASSWORD", "ZETARIS_DB_PASSWORD", "PGPASS"];
  // A value shorter than 12 characters would match ordinary text, so it is skipped, with a warning that names the variable.
  const values = [];
  for (const name of names) {
    const value = env.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1] ?? "";
    if (value === "") continue;
    if (value.length < 12) {
      process.stderr.write(`guard-prompt: ${name} in .env is shorter than 12 characters, so its value is not checked.\n`);
      continue;
    }
    values.push(value);
  }
  const leaked = key.test(prompt) || values.some((value) => prompt.includes(value));
  const out = leaked
    ? { continue: false, user_message: "This message contains what looks like a key or a password. Put it in .env instead and send the message without it." }
    : { continue: true };
  process.stdout.write(JSON.stringify(out));
});
