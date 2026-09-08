// Subscription credentials are private operational data, never part of settings/listing output.
import { getDb, fromJson, toJson } from "../../db/index.js";

export function createTeamsEventStore({ appId, db = getDb() } = {}) {
  if (!appId) throw new Error("Teams event store requires an app identity");
  return {
    list() {
      return db.prepare("SELECT data FROM teams_graph_subscriptions WHERE app_id = ?")
        .all(appId).map(row => fromJson(row.data, {}));
    },
    put(row) {
      if (!row?.conversationId) throw new Error("Teams subscription requires a conversation id");
      db.prepare("INSERT INTO teams_graph_subscriptions(app_id, conversation_id, data) VALUES (?, ?, ?) ON CONFLICT(app_id, conversation_id) DO UPDATE SET data = excluded.data")
        .run(appId, row.conversationId, toJson(row));
    },
    remove(conversationId) {
      db.prepare("DELETE FROM teams_graph_subscriptions WHERE app_id = ? AND conversation_id = ?").run(appId, conversationId);
    },
  };
}
