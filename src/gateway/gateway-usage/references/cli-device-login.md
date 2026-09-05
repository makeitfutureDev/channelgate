# Provider CLI device-code login

Use this for ordinary provider CLIs such as GitHub when the CLI offers a headless/device flow.
Claude and Codex engine authentication follows the separate host-side rules in
`references/administration.md`.

## Complete the login in one assistant turn

1. Check that the CLI already exists. If not, follow the applicable installation procedure before
   attempting authentication.
2. Inspect credential *sources and precedence* without displaying values. A provider token in the
   run environment can override the CLI's saved login. When the user wants a fresh device login,
   omit only the conflicting provider-token variables from the login subprocess and subsequent
   verification commands; do not unset them globally, delete `/secrets`, print them, or modify
   unrelated credentials.
3. Start the documented device/web login command in a real TTY and yield early so the command
   returns a live session identifier plus its verification URL and one-time code. If the CLI asks
   to open a browser, answer that prompt so it advances into its authorization wait; browser-open
   failure inside the container is expected and is not login failure.
4. Send the URL and code to the requester as a **commentary update**, never as the final response.
   Say that the process is waiting and that the code is short-lived. Do not store the code in
   memory.
5. Keep this SAME assistant turn alive. Poll the SAME process/session at intervals of at most 60
   seconds, posting a short alive update when the wait continues. A user message such as “done” is
   an addition to the active task, not a reason to abandon or recreate a healthy session.
6. If the process/session is unknown, exited before confirmation, or reports expiry, the exchange
   did not complete. Start a new login, send the NEW code as commentary, and keep that new session
   alive. Never reuse the old code or infer success from the browser alone.
7. After the CLI itself reports success, run its non-secret identity/status command under the same
   environment precedence used for login. When the user's goal includes a repository/account,
   verify the required access without printing credentials.
8. Only now send the final response: authenticated identity, verified capability, or an exact
   failure/remedy. Never include credential material.

Do not hand a device-code wait to a daemon background job: the requester needs the code in the
current conversation and the foreground turn must retain the interactive process session.
