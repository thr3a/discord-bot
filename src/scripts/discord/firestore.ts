// Firestore アクセス層。仕様書のDB操作をここに集約。
// テスト容易性のため、ここは Discord / OpenAI に依存しない。

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, type Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import type { ChannelState, ConversationMessage } from './types.js';

// サービスアカウントJSON文字列の \n を改行へ正規化
function normalizePrivateKey(input: string): string {
  return input.replace(/\\n/g, '\n');
}

// Firestore 初期化。失敗時は null を返す。
export async function withFirestoreOrNull(secretJson?: string): Promise<Firestore | null> {
  try {
    if (!getApps().length) {
      if (!secretJson) {
        // 環境変数未指定なら Firestore 未接続扱い
        throw new Error('FIREBASE_SECRET_JSON is not provided');
      }
      const svc = JSON.parse(secretJson);
      if (svc.private_key) {
        svc.private_key = normalizePrivateKey(svc.private_key);
      }
      initializeApp({
        credential: cert(svc)
      });
    }
    return getFirestore();
  } catch (e) {
    console.error('Firestore 初期化に失敗:', e);
    return null;
  }
}

// channelStates ドキュメント参照
function channelStateRef(db: Firestore, channelId: string) {
  return db.collection('channelStates').doc(channelId);
}

// channelConversations/{channelId}/messages コレクション参照
function messagesColRef(db: Firestore, channelId: string) {
  return db.collection('channelConversations').doc(channelId).collection('messages');
}

// チャンネル状態の取得
export async function getChannelState(db: Firestore, channelId: string): Promise<ChannelState | null> {
  try {
    const snap = await channelStateRef(db, channelId).get();
    if (!snap.exists) return null;
    return snap.data() as ChannelState;
  } catch (e) {
    console.error('getChannelState 失敗:', e);
    return null;
  }
}

// チャンネル状態の一部更新（mode を必ず設定、updatedAt を更新）
async function updateChannelState(
  db: Firestore,
  channelId: string,
  data: Partial<ChannelState> & { mode?: ChannelState['mode'] }
) {
  const ref = channelStateRef(db, channelId);
  const payload: Partial<ChannelState> = {
    ...data,
    updatedAt: FieldValue.serverTimestamp() as unknown
  };
  if (!payload.mode) {
    // mode を指定しない場合でも既存維持のため merge のみ
    await ref.set(payload, { merge: true });
  } else {
    await ref.set(payload as ChannelState, { merge: true });
  }
}

// モード更新
export async function setChannelMode(db: Firestore, channelId: string, mode: ChannelState['mode']): Promise<void> {
  await updateChannelState(db, channelId, { mode });
}

// シチュエーション更新
export async function setChannelSituation(db: Firestore, channelId: string, situation: string): Promise<void> {
  await updateChannelState(db, channelId, { situation, mode: 'idle' });
}

// 会話メッセージ追加（user/assistant）
export async function saveUserMessage(db: Firestore, channelId: string, msg: ConversationMessage): Promise<void> {
  const col = messagesColRef(db, channelId);
  await col.add({
    ...msg,
    createdAt: FieldValue.serverTimestamp()
  });
}

export async function saveAssistantMessage(db: Firestore, channelId: string, msg: ConversationMessage): Promise<void> {
  const col = messagesColRef(db, channelId);
  await col.add({
    ...msg,
    createdAt: FieldValue.serverTimestamp()
  });
}

// 昇順で全件取得 → 末尾から最大MAX件を返す（呼び出し側でMAXを渡す）
export async function getRecentConversation(
  db: Firestore,
  channelId: string,
  max: number
): Promise<ConversationMessage[]> {
  const col = messagesColRef(db, channelId);
  const snap = await col.orderBy('createdAt', 'asc').get();
  const all: ConversationMessage[] = [];
  snap.forEach((doc) => {
    all.push(doc.data() as ConversationMessage);
  });
  if (all.length <= max) return all;
  return all.slice(all.length - max);
}

// 指定メッセージID（user/assistant いずれか）以降をバッチ削除
export async function deleteConversationsAfterDiscordMessageId(
  db: Firestore,
  channelId: string,
  targetDiscordMessageId: string
): Promise<void> {
  const col = messagesColRef(db, channelId);
  const snap = await col.orderBy('createdAt', 'asc').get();
  const docs = snap.docs ?? [];
  let idx = -1;

  for (let i = 0; i < docs.length; i++) {
    const docSnap = docs[i];
    const data = docSnap?.data?.();
    if (!data) continue;
    const d = data as ConversationMessage;
    if (d.discordMessageId === targetDiscordMessageId || d.discordUserMessageId === targetDiscordMessageId) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return; // 見つからない場合は何もしない

  const batch = db.batch();
  for (let i = idx + 1; i < docs.length; i++) {
    const ref = docs[i]?.ref;
    // 型安全のため存在チェック
    if (ref) {
      batch.delete(ref);
    }
  }
  await batch.commit();
}

// 全削除
export async function deleteAllConversations(db: Firestore, channelId: string): Promise<void> {
  const col = messagesColRef(db, channelId);
  const snap = await col.get();
  const batch = db.batch();
  snap.forEach((d) => batch.delete(d.ref));
  await batch.commit();
}
