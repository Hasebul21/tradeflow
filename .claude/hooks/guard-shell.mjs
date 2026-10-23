// Cursor beforeShellExecution hook: stops agent commands that would print secrets,
// publish without the owner, or rewrite history. Reads {"command", "cwd"} on stdin.
let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = JSON.parse(input).command ?? "";
  } catch {
    // Unreadable input: fall through to allow; nothing to match against.
  }
  const rules = [
    [/(^|[\s;&|])(cat|less|more|head|tail|bat|grep|rg|sed|awk|base64|xxd|strings|od)\b[^\n]*\.env(?!\.example)\b/i, "deny", "Reading .env would put secrets in the chat. Use .env.example."],
    // A copy or a link of .env under another name would get past the read guard, which matches names.
    [/(^|[\s;&|])(ln|cp|mv|rsync|tar|zip|scp|curl)\b[^\n]*\.env(?!\.example)\b/i, "deny", "Copying or linking .env would move secrets past the guards. Scripts load .env themselves."],
    [/(^|[\s;&|])(printenv|env)(\s|$)|echo\s+[^\n]*\$\{?[A-Z_]*(KEY|TOKEN|SECRET|PASSWORD|PGPASS|DATABASE_URL)/, "deny", "Printing environment variables would expose keys."],
    [/git\s+push\b[^\n]*(--force|-f\b|--delete|\s:)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+tag\s+(-f|-d|--delete)|git\s+rebase\b|git\s+commit\b[^\n]*--amend|git\s+(checkout\s+--|restore)\s+\.(\s|$)/, "deny", "History-rewriting or work-discarding git commands are off limits; the pre-hackathon tag and the commit history are evidence."],
    [/git\s+push\b/, "ask", "Pushing publishes the work. Confirm this push."],
    [/git\s+add\s+(-A|--all|\.)(\s|$)/, "ask", "Stage files by name so .env and logs stay out."],
    [/rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\.?)(\s|$)/, "deny", "Refusing a recursive delete of a top-level folder."],
  ];
  for (const [pattern, permission, message] of rules) {
    if (pattern.test(command)) {
      process.stdout.write(JSON.stringify({ permission, user_message: message, agent_message: message }));
      return;
    }
  }
  process.stdout.write(JSON.stringify({ permission: "allow" }));
});
