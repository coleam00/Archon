# Rounds

How many times a change may go back to its builder. The pack's bindings allow three
starts of the builder per way back (from the review, from the host, from the land
stage) on one item, and the count starts again when the item is planned again. The
engine refuses a start past the limit and writes no ask, so the stage that sends the
change back reads where the limit stands first.

Before you end with `return`, read the item's limits:

```
<argv...> workflow runs --item issue-<number> --json
```

where `<argv...>` is the JSON string array in `$ARCHON_CLI_COMMAND`. Your own run's
entry in `runs` names the item; `startLimits` lists each limit on it with `starts`,
`used` and `left`. The limit for your way back is the one whose `name` ends with the
binding your prompt names. When its `left` is `0`, and no start of `archon-build` is
already queued on the item, the builder will not start again: end with `ask` instead.
The ask says what is still wrong, whether it is the same kind of finding the earlier
rounds returned, and what you recommend. Its `send-back` option starts the builder for
one more round; every round past the limit is asked this way. When the item shows no such limit, the change was not
started by the pack's bindings: end with `return` as usual.
