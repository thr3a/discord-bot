import { describe, expect, it } from 'vitest';
import {
  buildChatCompletionMessages,
  handleRecycleActionOnAssistantLogic,
  handleRecycleActionOnUserLogic
} from '../logic.js';
import type { ConversationMessage } from '../types.js';

describe('buildChatCompletionMessages', () => {
  it('system が未設定ならデフォルトを先頭に付与し、履歴を後続に並べる', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'こんにちは' },
      { role: 'assistant', content: 'どうしました？' }
    ];
    const messages = buildChatCompletionMessages(null, history);
    expect(messages.at(0)?.role).toBe('system');
    expect(messages[1]).toEqual({ role: 'user', content: 'こんにちは' });
    expect(messages[2]).toEqual({ role: 'assistant', content: 'どうしました？' });
  });

  it('system が指定されている場合はそれを使用', () => {
    const history: ConversationMessage[] = [{ role: 'user', content: 'Hi' }];
    const messages = buildChatCompletionMessages('You are strict.', history);
    expect(messages[0]).toEqual({ role: 'system', content: 'You are strict.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hi' });
  });
});

describe('handleRecycleActionOnAssistantLogic', () => {
  it('対象 assistant メッセージID 以前の履歴だけを採用（対象 assistant 自身は除外）', () => {
    // HUMAN: 投稿1, AI: 投稿2, HUMAN: 投稿3, AI: 投稿4 のとき
    const history: ConversationMessage[] = [
      { role: 'user', content: '投稿1' },
      { role: 'assistant', content: '投稿2', discordMessageId: 'A2' },
      { role: 'user', content: '投稿3' },
      { role: 'assistant', content: '投稿4', discordMessageId: 'A4' }
    ];
    // 投稿2に♻️の場合 → 投稿1のみをAPIに投げる（assistant は除く）
    const { nextMessages } = handleRecycleActionOnAssistantLogic(history, 'A2');
    expect(nextMessages).not.toBeNull();
    // system は呼出側付与前提なので含まない想定、ここでは user/assistant のみ
    expect(nextMessages).toEqual([{ role: 'user', content: '投稿1' }]);
  });

  it('対象が見つからない場合は null', () => {
    const history: ConversationMessage[] = [{ role: 'user', content: 'x' }];
    const { nextMessages } = handleRecycleActionOnAssistantLogic(history, 'not-found');
    expect(nextMessages).toBeNull();
  });
});

describe('handleRecycleActionOnUserLogic', () => {
  it('対象 user メッセージ以降を削除するインデックスを返す（対象は残す）', () => {
    // HUMAN: 投稿1(U1), AI: 投稿2(A2), HUMAN: 投稿3(U3), AI: 投稿4(A4)
    const history: ConversationMessage[] = [
      { role: 'user', content: '投稿1', discordUserMessageId: 'U1' },
      { role: 'assistant', content: '投稿2', discordMessageId: 'A2' },
      { role: 'user', content: '投稿3', discordUserMessageId: 'U3' },
      { role: 'assistant', content: '投稿4', discordMessageId: 'A4' }
    ];
    const res = handleRecycleActionOnUserLogic(history, 'U3');
    expect(res).not.toBeNull();
    expect(res?.keepUntilIndex).toBe(2); // U3 自身は残す
    expect(res?.deleteFromIndex).toBe(3); // それ以降を削除
  });

  it('対象が存在しなければ null', () => {
    const history: ConversationMessage[] = [{ role: 'user', content: 'hello', discordUserMessageId: 'U1' }];
    const res = handleRecycleActionOnUserLogic(history, 'U2');
    expect(res).toBeNull();
  });
});
