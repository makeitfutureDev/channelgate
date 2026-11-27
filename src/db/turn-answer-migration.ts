// A completed foreground answer can be delivered independently of its paid engine turn.
export const turnAnswerMigration = `
  CREATE TABLE IF NOT EXISTS turn_answers (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, due_ms INTEGER NOT NULL,
    created_ms INTEGER NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS turn_answers_due ON turn_answers(state, due_ms);
  CREATE INDEX IF NOT EXISTS turn_answers_retention ON turn_answers(created_ms);
`;
