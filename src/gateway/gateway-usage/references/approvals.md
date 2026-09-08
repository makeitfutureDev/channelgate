# Approvals — get the user to sign off before you continue

When you need the user to approve a plan, confirm a proposed action, or give change-request
feedback before you go further, call the gateway tool **`request_approval`** instead of ending your
reply with a plain "shall I proceed?" question. It posts a Slack approval object (buttons) in this
thread, waits for a decision, and returns it to you — so you don't have to guess whether silence
meant yes.

## `request_approval`
- `details` (required) — what you're asking them to approve: the plan, the action, the diff summary.
- `title` (optional) — a short heading for the approval card (e.g. "Deploy to production?").
- `approve_label` / `deny_label` (optional) — custom button text (default "Approve" / "Deny").

The user sees **Approve**, **Deny**, and **Comment** (request-changes) buttons. Anyone allowed to
run the bot in this channel — the original author or an admin — can decide. A gateway admin can
also decide the same card from the admin web UI without opening this conversation; you receive that
exactly like a click, with `decided_by` reading `admin UI`.

A decision can also arrive by **link**. Alongside the buttons, the gateway sends the person who
raised the request a private message containing one signed, single-use URL per action. They open it,
read a confirmation page, and press Confirm. This is how a surface without buttons (Microsoft Teams,
Google Chat) answers at all, and it is the same decision by a different route — you receive it
exactly like a click, with `decided_by` reading `link`. Nothing about your side of the protocol
changes, and you never see or handle the links yourself.

**Returns** JSON: `{ approved, feedback, decided_by }`.
- `approved` — `true` if they clicked Approve, `false` on Deny, Comment, or timeout.
- `feedback` — the comment text when they requested changes (or the deny/timeout reason).
- `decided_by` — the Slack user id who decided, `admin UI` when a gateway admin decided it from the
  admin web UI, or `link` when they confirmed it from an approval link (empty on timeout).

## Protocol
This call **blocks until the user decides** (or it times out after a few minutes) and hands you the
result inline — unlike `run_in_background`, you do NOT end your turn. Then:
- **Approved** → proceed with the approved work.
- **Denied or feedback present** → address the feedback before continuing; don't just repeat the ask.
- **Timed out** (`approved:false`, empty `decided_by`, and a `feedback` that says nobody clicked) →
  post a brief note and stop rather than proceeding unilaterally.

Use it for consequential steps (destructive changes, sends to other channels, spending, irreversible
actions) — not for routine replies.

## Saved instruction updates

`update_channel_instructions` saves the exact proposed rule and returns **pending** immediately.
Its approval has **no deadline** and survives gateway and engine restarts. End the turn with a
brief pending notice; the daemon applies the saved change when the user clicks Approve. Do not
retry it in a loop or report the instructions as changed before approval. Deny or Comment cancels
the request. Identical requests in the same thread reuse the pending card.

The entire rule must fit on the card (at most 2400 characters, no triple-backtick fences). Split
larger rules into separately reviewed requests. A changed working folder, changed instruction
file, or revoked permissions prevents application and requires a fresh request. Replacing the
instructions requires both an admin requester and admin approval.

Slack buttons and the admin approvals page remain available indefinitely for these requests.
Supplemental bearer links retain their separate 30-minute expiry. Ordinary `request_approval`
and native permission prompts still require a live tool call and retain their existing timeout.
