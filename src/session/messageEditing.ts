import type { ChatMessage } from '../contracts/index.ts';
import { LEGACY_CONVERSATION_ID } from './appStore.ts';

// Keep the old conversation intact while the active conversation resumes before
// the edited prompt. Archived message ids must stay distinct for reply updates.
export function prepareMessageEdit(messages: ChatMessage[], conversationId: string, messageId: string, text: string) {
  const current = messages.filter(message => (message.conversationId ?? LEGACY_CONVERSATION_ID) === conversationId);
  const index = current.findIndex(message => message.id === messageId);
  const original = current[index];
  if (!original || original.role !== 'user') throw new Error('只能编辑当前对话中的用户消息');
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 8000) throw new Error('消息需要包含 1–8000 个字符');
  if (trimmed === original.text) throw new Error('请先修改消息内容');
  const archiveId = crypto.randomUUID();
  const ids = new Map(current.map(message => [message.id, crypto.randomUUID()]));
  const archived = current.map((message, at) => ({ ...message,
    id: ids.get(message.id)!, conversationId: archiveId,
    ...(message.replyTo ? { replyTo: ids.get(message.replyTo) ?? message.replyTo } : {}),
    ...(at === 0 ? { editArchive: true as const } : {}),
  }));
  return { archiveId, archived, prefix: current.slice(0, index).map(message => ({ ...message, editArchive: undefined })),
    message: { ...original, editArchive: undefined, text: trimmed, editedAt: Date.now() },
  };
}
