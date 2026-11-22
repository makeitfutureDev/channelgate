# Split a discussion into forks (Google Chat)

When the user asks to fork several topics into their own conversations, call
`propose_thread_forks` with a `forks` array of `{title, prompt}`. Each prompt is the exact opening
request for its child, not instructions to implement unrelated work.

Forks exist only in a **named Google Chat space that uses threads**. Each fork becomes a new
top-level message in the same space — a new thread — titled with the fork's title. Direct messages,
group chats and spaces without threads have nowhere to put one: the tool refuses there with the
reason, and you should tell the user to ask in a threaded space instead of trying another way.
The source thread also needs a completed answer from you (a container session); sudo threads cannot
be forked.

Propose 1–10 forks. Keep each title to one line, at most 100 characters, each opening prompt to
2000 characters, and the full preview under 2400 characters. Every executed title and prompt must
fit on the card. Split large proposals into separately reviewed batches.

The tool returns **pending**. End the turn and tell the user the proposal awaits the card; never
claim children already exist. The requester or a gateway admin must click **Create N forks** on
the card in this thread even in Auto mode. Cancel or Request changes creates nothing. Identical
pending proposals reuse the same card.

After approval, the daemon waits for this thread's current turn to finish, forks the same session
into each child, and posts each child's opening request in its new thread as a turn by the
requester, subject to normal admission and concurrency limits. Messages sent to this thread
meanwhile wait until every child has its copy. The index of new threads (links) is posted here.
Each child has its own session and Activity entry. `/stop` in this thread before the copy is taken
cancels the batch.

A person can fork one thread themselves with `/fork <new message>`; it waits for this thread's
current work, then starts one new thread the same way. Model shortcuts (`/fork :name …`) are not
available in Google Chat; the new thread's runtime can be changed there with `/model`.

Partial failures retain created links and identify failed items. Do not retry uncertain creates
blindly. A restart after approval never re-creates threads; a child whose first answer was
interrupted says so in its thread. Pending unapproved cards survive restart.
