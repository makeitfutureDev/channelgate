# Split a discussion into forks

When the user asks to fork several topics into their own conversations, call
`propose_thread_forks` with a `forks` array of `{title, prompt}`. Each prompt is the exact opening
request for its child, not instructions to implement unrelated work. The tool is available only
in foreground Slack threads with a supported container session. Code channels and sudo threads
cannot create this batch.

Propose 1–10 forks. Keep each title to one line, at most 100 characters, each opening prompt to
2000 characters, and the full preview under 2400 characters. Every executed title and prompt must
fit on the card. Split large proposals into separately reviewed batches.

The tool returns **pending**. End the turn and tell the user the proposal awaits the card; never
claim children already exist. The requester or a gateway admin must click **Create N forks** even
in Auto mode. Cancel or Comment creates nothing. Identical pending proposals reuse the same card.

After approval, the daemon waits for the source turn to finish, forks the same source context into
each child, starts their opening responses subject to normal admission/concurrency limits, and
posts an index in the source thread. Each child has its own session and Activity entry. Ordinary
`/fork` remains available for one manually requested fork.

Partial failures retain created links and identify failed items. Do not retry uncertain creates
blindly. A restart during execution consumes the interrupted action without automatic replay;
persisted child IDs remain available for diagnosis. Pending unapproved cards survive restart.
