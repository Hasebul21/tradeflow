// Cursor beforeReadFile hook: keeps secret files out of the agent's context.
// Reads {"file_path", ...} on stdin; prints {"permission": "allow" | "deny", "user_message"}.
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let filePath = "";
  try {
    filePath = JSON.parse(input).file_path ?? "";
  } catch {
    // Unreadable input: nothing to match against, so allow.
  }
  // Lower-case and trim: macOS file names are case-insensitive, so .ENV is the same file as .env.
  const path = String(filePath).trim().toLowerCase();
  const name = path.split(/[\\/]/).pop() ?? "";
  const secret =
    (/^\.env(\..+)?$/.test(name) && name !== ".env.example") ||
    /\.(pem|key)$/.test(name) ||
    /(^|[\\/])secrets[\\/]/.test(path);
  const out = secret
    ? { permission: "deny", user_message: `Blocked reading ${name}: it holds secrets. Scripts load .env themselves; use .env.example for the names.` }
    : { permission: "allow" };
  process.stdout.write(JSON.stringify(out));
});
