// Approval presentation only. Authority and one-shot decisions remain in the shared backend.
import { platformOfConversation } from "./ids.js";
import { platformOr } from "./registry.js";
import { liveConnector } from "./live.js";
import { postPrivately } from "./notify.js";
import { approvalCard, messageCard } from "./msteams/cards.js";
import { adaptiveSettingsToChat } from './googlechat/cards.js';

export function approvalDeliveryFor(conversationId) {
  const adapter = platformOr(platformOfConversation(conversationId));
  if (adapter.capabilities.richCards === "block-kit") return null;
  const connector = liveConnector(adapter.id);
  if (!connector || connector.ready?.() === false) return null;
  const nativeCards = ['adaptive-cards', 'cards-v2'].includes(adapter.capabilities.richCards);
  const render = card => adapter.capabilities.richCards === 'cards-v2' ? adaptiveSettingsToChat(card) : card;
  const delivery = {
    requiresLinks: false,
    supportsPrivateLinks: adapter.id !== "msteams" && !(nativeCards && connector.postCard),
    capabilities: adapter.capabilities,
    async post({ threadKey, id, title, target, scopes, authorId, approvalType }) {
      const text = `Approval requested: ${title}`;
      if (nativeCards && connector.postCard) {
        try {
          return await connector.postCard({ conversationId, threadKey,
            card: render(approvalCard({ id, title, details: target, scopes, authorId, approvalType })), text });
        } catch { /* Teams stays in the source thread; other surfaces can use private links. */ }
      }
      if (nativeCards && connector.postCard) {
        const reason = `Approval controls could not be displayed in this thread. No action was approved. Retry the original request here; if it keeps failing, ask an administrator to check ${adapter.label} card delivery.`;
        await connector.post({ conversationId, threadKey, text: reason });
        throw new Error(reason);
      }
      delivery.requiresLinks = true;
      // Sensitive decision links are delivered privately, never embedded in this room notice.
      return connector.post({ conversationId, threadKey, text: `${text}. Check your private chat for decision links.` });
    },
    async update({ messageId, title, text }) {
      if (nativeCards && connector.updateCard) {
        return connector.updateCard({ conversationId, messageId, card: render(messageCard({ title, text })), text });
      }
      return connector.edit({ conversationId, messageId, text });
    },
    privately({ threadKey, userId, text }) {
      if (!delivery.supportsPrivateLinks) return Promise.resolve(null);
      return postPrivately(connector, { conversationId, threadKey, userId, text });
    },
  };
  return delivery;
}
