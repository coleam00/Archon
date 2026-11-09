# Resolve What to Build

A person started this build-queue run and said in words what to build, instead of naming an issue number. Work out which work item they mean. The next nodes act on what you declare: they claim the item you name, ask the person to choose between the items you list, or file new work and hand it to intake. You write nothing to the tracker, the repository or the state store yourself, and the checkout must be exactly as you found it when you finish.

The message:

```text
$ARGUMENTS
```

The repository: `$INPUTS.repo`. Every item you declare is an issue in it.

## Resolve the message

Read the message whole and judge what it asks for. It can name an issue by number or URL, describe issues to find, point at a file in the checkout, or paste a brief. Look items up with the tracker's CLI and read what you find before you declare it; a file path is read from the checkout.

The build queue builds work intake already triaged. It never builds new work in this run: new work is filed and goes to intake, which triages it and routes it, including splitting it when it is too large.

## Declare

- `build`: the message names, or clearly means, one existing open issue in the repository. Set `number`. The next node claims it, and refuses with the reason when it cannot, for example because intake has not triaged it or another run holds it.
- `choose`: the message could mean several existing issues and you cannot tell which. Set `options`, at least two, one per candidate: `id` as `issue-<number>`, `label` as the number and title, `does` as one line saying what building it means, and `value` as `{ "number": <number> }`. The person picks one and the run claims it. Set `reason` to the question, in a sentence the person can answer without opening the run.
- `intake`: the message describes work no issue covers, such as a pasted brief or a file that describes a change. Set `issue` to the issue to file: a `title` and a `body` that carries the message's content faithfully, with its source (the file path, or that a person gave it to the build queue). Do not widen it or decide its route. Search for an issue that already covers it first; one that does makes this `build` or `choose` instead.
- `none`: the message resolves to nothing the queue can build: an issue that does not exist, is closed or lives in another repository, several items to build at once, or a message that names no work. The run refuses with your `reason`, so say what you found and what the person can do instead, such as naming one item.

Declare only the fields your decision uses: `number` is null except on `build`, `options` is empty except on `choose`, and `issue` is null except on `intake`. Always set `reason`: one line a person can check.
