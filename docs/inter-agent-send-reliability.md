# Inter-agent send reliability (verify + retry)

## The problem
Agents send inter-agent messages with `POST /api/messages`. A common shorthand is a `curl` whose output
is discarded and success inferred from the shell `&&`:

    curl -s ... -d @- <<HEREDOC >/dev/null && echo sent
    ...
    HEREDOC

This is **dangerous**: `curl` exits `0` on a completed HTTP request even when the server **rejected** it
(401 unauthorized, 400 bad body, 5xx), because `>/dev/null` discards the response and `&&` only checks
curl's exit code. The agent sees its own `echo sent` and believes the message went out. Result: a **silent
send failure** — the recipient never gets the message, and two agents can wait on each other indefinitely.

Observed in the field (2026-07): a sub-agent's completion callbacks were silently lost this way, costing
~30–60 minutes of an idle main+sub deadlock. The `/api/messages` router was healthy the whole time
(HTTP 200 + a message `id`); the defect was purely sender-side (never checking the result).

## The rule
**A message counts as sent only when the response returned an `id`** (`{"id":<n>,"status":"pending",...}`
with HTTP 200). Verify the HTTP status **and** the returned id, and resend if missing.

## The fix
- `cat <<'MSG' | scripts/agent-msg.sh <from> <to> -` — builds the JSON body with `json.dumps`, checks
  HTTP status + `id`, retries up to 3×, logs failures to `store/agent-msg-failures.log`. Base dir is
  auto-detected, port from `MARVEEN_WEB_PORT` (default 3420), so it runs from any CWD / any install.
- **The content must come from STDIN; an argument is refused.** Verifying the send is not enough if the
  text was already corrupted before the send. Two ways an argument breaks, both invisible downstream:
  a double quote inside a double-quoted argument closes the string, the remainder splits into further
  arguments, only `$3` survives — the message is delivered **truncated**, with an `OK id=<n>` that
  truthfully reports what the script *received*. And `$(...)`/backticks **execute in the sender's shell**
  and splice their output in (a failing command leaves an empty string and no trace) — so quoting a shell
  snippet to a teammate runs it. The second class cannot be detected inside the script at all:
  substitution happens before the call, so `"$(id -u)"` and `"0"` are indistinguishable there. Refusing
  the argument form is the only check that acts before the shell rewrites the text; a quoted heredoc
  (`<<'MSG'`) passes every byte verbatim.
- The generated agent `CLAUDE.md` (from `templates/CLAUDE.md.template`) now documents this rule and points
  at the helper, so every agent in every fleet verifies its sends by default.

## Belt-and-suspenders
For delegated tasks, pairing the callback with a **DONE-marker file** (written as the final step) lets the
orchestrator detect completion by file signal even if a callback is ever lost. But the primary fix is that
the sender must not treat an unchecked `curl` as success.
