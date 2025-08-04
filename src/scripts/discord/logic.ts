// チャット管理ロジック（DB・Discord依存を分離して純粋ロジック化）
// ここは vitest で単体テスト可能な純関数のみを置く

import type { ConversationMessage } from './types.js';
import { DEFAULT_SYSTEM_PROMPT } from './types.js';

// OpenAI Chat Completions へ渡す messages を構築する純関数
export function buildChatCompletionMessages(
  system: string | null | undefined,
  history: ConversationMessage[]
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const sys = system && system.trim().length > 0 ? system : DEFAULT_SYSTEM_PROMPT;
  const converted = history.map((m) => ({
    role: m.role,
    content: m.content
  })) as Array<{ role: 'user' | 'assistant'; content: string }>;
  return [{ role: 'system', content: sys }, ...converted];
}

// 先頭が "/" のメッセージ時の状態遷移（idleへ戻すかなど）の判定
export function decideNextStateOnSlashOrLeadingSlash(currentMode: 'idle' | 'situation_input' | 'awaiting_reinput') {
  // 仕様では "/" 始まりは会話処理対象外とし、シチュエーション入力モードを破棄（idleへ）
  if (currentMode === 'situation_input') return 'idle' as const;
  if (currentMode === 'awaiting_reinput') return 'idle' as const;
  return 'idle' as const;
}

// ♻️がBOTメッセージに付いたときの再生成対象メッセージ群を構築する純関数
// 対象 assistant メッセージID より前の user/assistant 文脈から、同 assistant 発言を除いて再生成する
export function handleRecycleActionOnAssistantLogic(
  history: ConversationMessage[],
  targetAssistantDiscordMessageId: string
): {
  nextMessages: Array<{ role: 'user' | 'assistant'; content: string }> | null;
  deleteFromDiscordMessageId: string | null;
} {
  // 昇順リストから対象assistant発言のインデックスを探す
  const idx = history.findIndex(
    (h) => h.role === 'assistant' && h.discordMessageId === targetAssistantDiscordMessageId
  );
  if (idx === -1) {
    return { nextMessages: null, deleteFromDiscordMessageId: null };
  }

  // 例に基づき、対象 assistant 発言と、それ以降（= idx 以降）は削除し、手前の文脈のみで再生成
  // ただし直前の assistant は削る必要があるため、単純に 0..idx-1 を採用
  const truncated = history.slice(0, idx); // idx の assistant は含めない

  // OpenAIに渡す形式（system は呼び出し側で付与するためここでは付けない）
  const nextMessages = truncated.map((m) => ({ role: m.role, content: m.content })) as Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;

  // 呼出側で system を付与しやすいように user/assistant 配列として返す（ここでは system を含めない）
  return { nextMessages, deleteFromDiscordMessageId: targetAssistantDiscordMessageId };
}

// ♻️がユーザーメッセージに付いたときの削除範囲を決める純関数
// 指定ユーザー投稿以降（当該含む or 以降? →仕様の記述例的に以降削除で、当該ユーザー投稿は残す）を削除する想定
export function handleRecycleActionOnUserLogic(
  history: ConversationMessage[],
  targetUserDiscordMessageId: string
): {
  // 残すべき index（target の直前まで残す）と、削除開始 index
  keepUntilIndex: number; // このindexまで残す（含む）
  deleteFromIndex: number; // このindexから末尾まで削除
} | null {
  const idx = history.findIndex((h) => h.role === 'user' && h.discordUserMessageId === targetUserDiscordMessageId);
  if (idx === -1) return null;

  // 例より、対象ユーザー投稿は残し、その後は削除
  return {
    keepUntilIndex: idx,
    deleteFromIndex: idx + 1
  };
}
