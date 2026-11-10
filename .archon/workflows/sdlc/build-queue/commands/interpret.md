# Resolve What to Build

A person started this build-queue run and said in words what to build, instead of naming an issue number. Work out which work items they mean. The next nodes act on what you declare: they claim the item you name, ask the person to choose between the items you list, write a work order for several items, or file new work and hand it to intake. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The message:

```text
$ARGUMENTS
```

The repository: `$INPUTS.repo`. Every item you declare is an issue in it.

## Resolve the message

Read the message whole and judge what it asks for. It can name an issue by number or URL, describe issues to find, point at a file in the checkout, or paste a brief. Look items up through the Archon CLI, whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`, as `<argv...> forge <op> --json --data '<request>'`, with `<repo>` = `{"host":…,"path":…}`, `$INPUTS.repo` split at its first `/`, and read what you find before you declare it: `workitem.view` takes `{"ref":{"repo":<repo>,"number":<n>}}`, and `workitem.search` takes `{"repo":<repo>,"text":"<terms>"}` for open issues and pull requests (`"state":"any"` adds closed ones, `"kind":"issue"` leaves pull requests out), matched by the forge's own search, so try more than one wording. A failed read is the answer, never an item that does not exist: report it, and never repeat it through another tool. A file path is read from the checkout.

The build queue builds work intake already triaged. It never builds new work in this run: new work is filed and goes to intake, which triages it and routes it, including splitting it when it is too large.

## Declare

- `build`: the message names, or clearly means, one existing open issue in the repository. Set `number`. The next node claims it, and refuses with the reason when it cannot, for example because intake has not triaged it or another run holds it.
- `choose`: the message could mean several existing issues and you cannot tell which. Set `options`, at least two, one per candidate: `id` as `issue-<number>`, `label` as the number and title, `does` as one line saying what building it means, and `value` as `{ "number": <number> }`. The person picks one and the run claims it. Set `reason` to the question, in a sentence the person can answer without opening the run.
- `order`: the message names two or more existing open issues to build, and does not ask for them to be built together. Set `order`: `id`, a short lowercase slug naming the order (such as `pi-login-fixes`), `members`, the issue numbers in the order the message gives them, and `unresolved`, each part of the message you could not resolve to an open issue, as `named` (what the message said) and `why`. The run writes a work order approved by the person who started it and builds nothing now; the scheduled build queue builds each member once intake has triaged it. A member intake has not seen is sent to intake first.
- `intake`: the message describes work no issue covers, such as a pasted brief or a file that describes a change. Set `issue` to the issue to file: a `title` and a `body` that carries the message's content faithfully, with its source (the file path, or that a person gave it to the build queue). Do not widen it or decide its route. Search for an issue that already covers it first; one that does makes this `build` or `choose` instead.
- `intake`, combined: the message explicitly asks for two or more existing open issues to be built together, in one run or one pull request. Group only on that explicit ask, never because the issues look related. Set `issue` to one combined issue: a `title` naming the combined change, and a `body` that carries each original's contract faithfully (its problem, outcome, invariants and acceptance, quoted or linked to the original) and ends with a `## Delivered together` section listing each original as `- #<number>: <title>`, saying the pull request that delivers this issue closes them too. Intake triages it and the queue builds it as one item. When any issue the person asked to group does not resolve to an open issue, declare `none` instead and say which: a combined issue missing one of them is not what was asked.
- `none`: the message resolves to nothing the queue can build: an issue that does not exist, is closed or lives in another repository, or a message that names no work. The run refuses with your `reason`, so say what you found and what the person can do instead, such as naming one item.

Declare only the fields your decision uses: `number` is null except on `build`, `options` is empty except on `choose`, `order` is null except on `order`, and `issue` is null except on `intake`. Always set `reason`: one line a person can check.
