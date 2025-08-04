// 型定義や定数を集約

export type Mode = 'idle' | 'situation_input' | 'awaiting_reinput';

export type ConversationRole = 'user' | 'assistant';

export interface ChannelState {
  mode: Mode;
  situation?: string;
  rebaseLastUserMessageId?: string;
  rebaseLastAssistantMessageId?: string;
  updatedAt?: unknown;
}

export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  discordMessageId?: string; // assistant 側のみ任意
  discordUserMessageId?: string; // user 側のみ任意
  createdAt?: unknown;
}

export interface ChatHistory {
  system: string | null; // シチュエーション
  messages: ConversationMessage[]; // 昇順（古い→新しい）
}

export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

export interface ChatCompletionResponse {
  content: string;
}

// 固定メッセージ
export const FALLBACK_FIRESTORE_ERROR = '現在データベースに接続できません。しばらくしてからお試しください。';

export const FALLBACK_OPENAI_ERROR = 'AIの応答生成に失敗しました。時間をおいて再度お試しください。';

export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful chatbot.';

// 許可チャンネルIDの固定集合（必要に応じて環境変数化しやすく）
export const ALLOWED_CHANNEL_IDS: Set<string> = new Set([
  // ここに許可するチャンネルIDを列挙
  // 例: '123456789012345678',
]);

// 直近履歴最大利用件数
export const MAX_HISTORY = 50;

// リアクションで使用する絵文字
export const RECYCLE_EMOJI = '♻️';
