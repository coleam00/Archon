---
description: Split a run's trigger message into the operator's request plus any GitHub issue reference it carries
argument-hint: <the raw user message>
---

# Parse User Request

**Input**: $ARGUMENTS

---

Return four fields describing the message above. Nothing else.

## `user_request` — required, verbatim

The message exactly as given, character for character.

- **Never** summarise, clean up, expand, translate, or otherwise rewrite it.
- **Never** leave it empty when the input is non-empty. If the whole message is
  just `123`, then `user_request` is `123`.
- If you find yourself improving the wording, stop — downstream steps resolve
  conflicts by preferring the operator's own words, and a paraphrase silently
  substitutes your reading for theirs.

## `issue_number` — best effort

The GitHub issue number the message refers to, as a bare number in a string.

Recognised forms: `123`, `#123`, `issue 123`, `owner/repo#123`, and the number
at the end of a GitHub issue URL.

Set it to `""` when the message names no issue. A message can legitimately be a
bug report, a pasted stack trace, a file path, or a plain instruction — `""` is
a correct answer, not a failure. Do not search for or invent a number.

## `repo` — best effort, verbatim

The `owner/repo` **copied character for character out of the input**, when the
message names a repository in shorthand form (`owner/repo#123`).

- **Never construct or infer one.** Not from a URL, not from context, not from
  the checkout you are running in.
- `""` when the message used no shorthand — including when it used a full URL,
  which belongs in `repo_url` instead.

A number alone is ambiguous across repositories, and `owner/repo#123` states the
repository explicitly. Dropping it would send that number to whatever checkout
the run happens to be in.

## `repo_url` — best effort, verbatim

The GitHub URL **copied character for character out of the input**, when the
message contains one.

- **Never construct, complete, or infer a URL.** If the message says
  `owner/repo#123` or just `123`, `repo_url` is `""` — not a URL you assembled.
- `""` means "the repository this run is executing in", which is the common case.
- Only a URL that literally appears in the input belongs here.

This field exists because an issue number alone is ambiguous across repositories:
`gh issue view 456` resolves against whatever checkout it runs in, so a number
lifted out of another repository's URL silently fetches the wrong issue. Copying
the URL whole keeps the number and its repository together.

## Output

Reply with **only** the declared fields.

No preamble, no explanation, no commentary after, no markdown fences, no
reasoning about how you decided. The first character of your reply is the start
of the structured output and the last character is its end.

## Examples

| input | user_request | issue_number | repo | repo_url |
| --- | --- | --- | --- | --- |
| `123` | `123` | `123` | `""` | `""` |
| `fix #2412 but only the bash node` | `fix #2412 but only the bash node` | `2412` | `""` | `""` |
| `https://github.com/o/r/issues/456` | `https://github.com/o/r/issues/456` | `456` | `""` | `https://github.com/o/r/issues/456` |
| `owner/repo#88` | `owner/repo#88` | `88` | `owner/repo` | `""` |
| `the SQLite timestamps tie, see log` | `the SQLite timestamps tie, see log` | `""` | `""` | `""` |
