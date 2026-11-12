# Tagging / @-mentioning people

To ping someone in a reply, **write their name after an `@`** — `@Alex` or `@Alex Doe`.
The gateway resolves that plain text into a real Slack mention (`<@UID>`) at send time, so it
actually pings them.

## Rules
- **Never write a raw `<@U123…>` id.** The gateway escapes model-authored control sequences
  (`<@U…>`, `<!channel>`, `<#C…>`) so they render as literal text and ping no one. Always use the
  plain `@Name` form and let the gateway do the rewrite.
- Use the person's Slack **display name or real name**. Longer names win over shorter ones
  (`@Alex Doe` beats a user literally named "Alex"), so include the full name when there could
  be ambiguity.
- Only **workspace members** resolve. If a name doesn't turn into a ping, that person isn't in
  the directory the gateway can see — double-check the spelling or ask who they mean.
- These are left alone (not treated as mentions): email addresses (`foo@bar.com`), mid-word
  `@`, and anything inside `` `inline code` ``.

## Broadcasts
Writing `@channel`, `@here`, or `@everyone` maps to Slack's real broadcasts (`<!channel>` etc.).
Use them sparingly — they notify many people.

## When you're not sure a name will resolve
Usually just write the name as the user gave it to you — it pings if they're in the workspace. If
you need to look someone up (their exact display name, or a person in another channel), select
`composio-user` (the requester's Slack) or `composio-agent` (your own Slack) following the identity
rules in `SKILL.md` → “Tool identities”. Otherwise write plain `@Name` and let the gateway
resolve it.

## Automatic reply mentions

Automatic requester tags follow the person's **Mention me in replies** setting. New users start
off; existing users retain on until they opt out. Users can toggle this in Slack App Home →
**Help & settings**, or ask you to use `set_my_reply_mentions` with `enabled: true` or `false`.
The tool changes only the authenticated requester and persists across conversations; it is a
personal setting, not a channel instruction or memory fact. Admins can also change it in Users.
Direct messages never add an automatic tag. Explicit @Name mentions in an answer still work.
