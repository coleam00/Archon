# Land it

The land gate decides whether a ready change merges. It reads the change after the host round finds it ready, ends `land` when this repository's land policy (`docs/factory-console/policy/land.md`) lets the change land by itself, and asks an operator otherwise.

In this repository it asks for every change to a page a person sees, unless the operator has already looked at it in a browser on a copy of the live database. It also asks when a CI check is not green, when the change no longer merges cleanly with `main`, or when it touches the database schema or the engine's workflow behaviour. Before you answer, look at the change in a browser on a copy of the live database (`docs/factory-console/ENGINEERING.md` says how to serve one). Answer on the live factory, never on the copy.

The ask offers three answers: land, send-back and hold. The land stage offers the same three when it stops with an ask.

`land`: the land stage merges the change into its landing branch as one squashed commit, if it still merges cleanly and its checks are green. Otherwise the change goes back to its builder.

`send-back`: the builder continues on the change, in the checkout the asking run left, with what you write in your answer. Then the checks and the host round run again, then the land gate again. What it costs: one more build, check and host round.

`hold`: nothing starts until an operator says more.
