import 'dotenv/config';
import {
  ApplicationCommandType,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
  Partials,
  REST,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  Routes
} from 'discord.js';

import admin from 'firebase-admin';
type AdminFirestore = admin.firestore.Firestore;

import OpenAI from 'openai';

const ALLOWED_CHANNEL_IDS = new Set<string>(['1005750360301912210']);

const COLLECTION_CHANNEL_STATES = 'channelStates';
const COLLECTION_CHANNEL_CONVERSATIONS = 'channelConversations';

/**
 * 絵文字リアクション
 * - 再生成トリガー: BOTメッセージに対する♻️
 * - 会話巻き戻しトリガー: ユーザーメッセージに対する♻️
 */
const REGENERATE_EMOJI = '♻️';

// 直近の会話件数
const HISTORY_LIMIT = 50;

function getEnv(name: string, optional = false): string | undefined {
  const v = process.env[name];
  if (!v && !optional) {
    console.error(`[ENV] ${name} が設定されていません`);
  }
  return v;
}

const DISCORD_BOT_TOKEN = getEnv('DISCORD_BOT_TOKEN');
const DISCORD_CLIENT_ID = getEnv('DISCORD_CLIENT_ID');
const FIREBASE_PROJECT_ID = getEnv('FIREBASE_PROJECT_ID');
const FIREBASE_CLIENT_EMAIL = getEnv('FIREBASE_CLIENT_EMAIL');
let FIREBASE_PRIVATE_KEY = getEnv('FIREBASE_PRIVATE_KEY');

if (FIREBASE_PRIVATE_KEY) {
  FIREBASE_PRIVATE_KEY = FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
}

let firestore: AdminFirestore | null = null;
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID ?? '',
        clientEmail: FIREBASE_CLIENT_EMAIL ?? '',
        privateKey: FIREBASE_PRIVATE_KEY ?? ''
      } as admin.ServiceAccount)
    });
  }
  firestore = admin.firestore();
} catch (e) {
  console.error('[Firebase] 初期化に失敗しました:', e);
  firestore = null;
}

type ChannelState = {
  mode: 'idle' | 'situation_input' | 'awaiting_reinput';
  situation?: string;
  // 巻き戻し後に保持する最後のユーザー/アシスタントのDiscordメッセージID
  // （履歴の切り詰め後、再入力を受けたらこの位置から会話を続ける）
  rebaseLastUserMessageId?: string | undefined;
  rebaseLastAssistantMessageId?: string | undefined;
  updatedAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
};

// 会話メッセージの型
type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  // Discordメッセージ関連の参照情報（再生成や追跡に利用）
  discordMessageId?: string; // この会話に対応するBot側メッセージID（assistant の場合）
  discordUserMessageId?: string; // この会話に対応するユーザー側メッセージID（user の場合）
  createdAt: admin.firestore.FieldValue | admin.firestore.Timestamp;
};

async function getChannelState(channelId: string): Promise<ChannelState | null> {
  if (!firestore) return null;
  try {
    const ref = firestore.collection(COLLECTION_CHANNEL_STATES).doc(channelId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    return snap.data() as ChannelState;
  } catch (e) {
    console.error('[Firestore] getChannelState エラー:', e);
    return null;
  }
}

async function setChannelState(channelId: string, partial: Partial<ChannelState>): Promise<boolean> {
  if (!firestore) return false;
  try {
    const ref = firestore.collection(COLLECTION_CHANNEL_STATES).doc(channelId);
    await ref.set(
      {
        mode: 'idle',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        ...partial
      },
      { merge: true }
    );
    return true;
  } catch (e) {
    console.error('[Firestore] setChannelState エラー:', e);
    return false;
  }
}

function channelMessagesColRef(channelId: string) {
  if (!firestore) return null;
  return firestore.collection(COLLECTION_CHANNEL_CONVERSATIONS).doc(channelId).collection('messages');
}

async function addConversationMessage(channelId: string, message: ConversationMessage): Promise<boolean> {
  const col = channelMessagesColRef(channelId);
  if (!col) return false;
  try {
    await col.add({
      ...message,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return true;
  } catch (e) {
    console.error('[Firestore] addConversationMessage エラー:', e);
    return false;
  }
}

async function fetchRecentMessages(channelId: string, limit: number): Promise<ConversationMessage[]> {
  const col = channelMessagesColRef(channelId);
  if (!col) return [];
  try {
    const snap = await col.orderBy('createdAt', 'asc').get(); // ascで全件取り、後でスライス（createdAtにserverTimestampが入るため）
    const all = snap.docs.map((d: admin.firestore.QueryDocumentSnapshot) => d.data() as ConversationMessage);
    // 直近 limit 件
    return all.slice(Math.max(0, all.length - limit));
  } catch (e) {
    console.error('[Firestore] fetchRecentMessages エラー:', e);
    return [];
  }
}

/**
 * 指定したDiscordメッセージID（ユーザー/アシスタント）より後の履歴を削除する
 * targetUserId または targetAssistantId のいずれかを指定する
 */
async function truncateConversationAfter(
  channelId: string,
  params: { targetUserId?: string; targetAssistantId?: string }
): Promise<{ ok: boolean; keptCount: number }> {
  const col = channelMessagesColRef(channelId);
  if (!col) return { ok: false, keptCount: 0 };
  try {
    const snap = await col.orderBy('createdAt', 'asc').get();
    const all = snap.docs.map((d: admin.firestore.QueryDocumentSnapshot) => ({
      id: d.id,
      data: d.data() as ConversationMessage,
      ref: d.ref
    }));

    let cutIndex = -1;
    if (params.targetUserId) {
      cutIndex = all.findIndex((x) => x.data.role === 'user' && x.data.discordUserMessageId === params.targetUserId);
    } else if (params.targetAssistantId) {
      cutIndex = all.findIndex(
        (x) => x.data.role === 'assistant' && x.data.discordMessageId === params.targetAssistantId
      );
    }

    if (cutIndex === -1) {
      // 見つからない場合は何もしない
      return { ok: true, keptCount: all.length };
    }

    // cutIndex より後を削除
    const toDelete = all.slice(cutIndex + 1);
    if (!firestore) return { ok: false, keptCount: 0 };
    const batchInstance = (firestore as AdminFirestore).batch();
    for (const doc of toDelete) {
      batchInstance.delete(doc.ref);
    }
    await batchInstance.commit();

    return { ok: true, keptCount: cutIndex + 1 };
  } catch (e) {
    console.error('[Firestore] truncateConversationAfter エラー:', e);
    return { ok: false, keptCount: 0 };
  }
}

async function clearConversation(channelId: string): Promise<boolean> {
  const col = channelMessagesColRef(channelId);
  if (!col) return false;
  try {
    const snap = await col.get();
    if (!firestore) return false;
    const batchInstance = (firestore as AdminFirestore).batch();
    for (const doc of snap.docs as admin.firestore.QueryDocumentSnapshot[]) {
      batchInstance.delete(doc.ref);
    }
    await batchInstance.commit();
    return true;
  } catch (e) {
    console.error('[Firestore] clearConversation エラー:', e);
    return false;
  }
}

// Bot の投稿 MessageID から、その前後関係で再生成対象の会話を抽出する
async function buildRegenerateContextFromBotMessage(
  channelId: string,
  botMessageId: string
): Promise<{ system?: string | undefined; messages: { role: 'user' | 'assistant'; content: string }[] } | null> {
  const state = await getChannelState(channelId);
  const history = await fetchRecentMessages(channelId, HISTORY_LIMIT);

  // botMessageId に一致する assistant メッセージの位置を取得
  const idx = history.findIndex((m) => m.role === 'assistant' && m.discordMessageId === botMessageId);
  if (idx === -1) return null;

  // 会話は ... BOT:投稿1 (assistant), HUMAN:投稿2 (user), BOT:投稿3 (assistant=対象)
  // 投稿3に♻️ => 投稿1, 投稿2 を使い、投稿3は除外して再生成
  // つまり対象 assistant の一つ前の user、その一つ前の assistant が必要
  const userIdx = idx - 1;
  const prevBotIdx = idx - 2;

  if (userIdx < 0 || prevBotIdx < 0) return null;
  if (history[userIdx]?.role !== 'user' || history[prevBotIdx]?.role !== 'assistant') return null;

  const messages = [
    { role: 'assistant' as const, content: history[prevBotIdx].content },
    { role: 'user' as const, content: history[userIdx].content }
  ];

  return {
    // exactOptionalPropertyTypes 対応: optional だが undefined を許容する
    system: state?.situation ?? undefined,
    messages
  };
}

// =================== Discord クライアント初期化 ===================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// =================== スラッシュコマンド登録 ===================
const slashCommands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  {
    name: 'time',
    description: '現在時刻を返信します',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'init',
    description: 'シチュエーション入力モード',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'clear',
    description: '会話履歴を削除します',
    type: ApplicationCommandType.ChatInput
  },
  {
    name: 'show',
    description: '現在登録されているシチュエーションを表示します',
    type: ApplicationCommandType.ChatInput
  }
];

async function registerCommands() {
  if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) return;
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: slashCommands });
    console.log('[Discord] スラッシュコマンド登録完了');
  } catch (e) {
    console.error('[Discord] スラッシュコマンド登録失敗:', e);
  }
}

// 許可チャンネルのみ許可
function isAllowedChannel(messageOrInteraction: { channelId: string | null | undefined }): boolean {
  if (!messageOrInteraction.channelId) return false;
  return ALLOWED_CHANNEL_IDS.has(messageOrInteraction.channelId);
}

// タイピング表示
async function withTyping<T>(channel: Message['channel'], fn: () => Promise<T>): Promise<T> {
  try {
    // typing 開始
    if ('sendTyping' in channel && typeof channel.sendTyping === 'function') {
      await channel.sendTyping();
    }
  } catch {
    // ignore
  }
  try {
    return await fn();
  } finally {
    // discord.js v14は明示停止APIなし。sendTypingは数秒継続。
  }
}

// Firestore が未接続時の固定エラーメッセージ
const FIREBASE_ERROR_MSG = '現在、データベースに接続できません。時間をおいて再度お試しください。';
// OpenAI エラーメッセージ
const OPENAI_ERROR_MSG = 'AIの応答がありませんでした。時間をおいて再度お試しください。';

/**
 * 会話を OpenAI (official SDK) に投げる
 * @returns 生成テキスト / null
 */
async function chatWithAI(params: {
  // exactOptionalPropertyTypes 対応: optional プロパティは undefined を明示許容
  system?: string | undefined;
  history: { role: 'user' | 'assistant'; content: string }[];
  latestUser?: { content: string };
}): Promise<string | null> {
  try {
    // OpenAI クライアント。環境によってはプロキシ/互換APIを使うため baseURL を指定
    // 既存コードで使っていた互換APIエンドポイントを維持
    const client = new OpenAI({
      baseURL: 'http://192.168.16.20:8000/v1',
      apiKey: 'dummy'
    });

    // Chat Completions 形式へ変換
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [];

    const system = params.system?.trim();
    messages.push({
      role: 'system',
      content: system && system.length > 0 ? system : 'You are a helpful chatbot.'
    });

    for (const m of params.history) {
      messages.push({
        role: m.role,
        content: m.content
      });
    }
    if (params.latestUser) {
      messages.push({
        role: 'user',
        content: params.latestUser.content
      });
    }

    const completion = await client.chat.completions.create({
      model: 'main', // 互換サーバ側で "main" などにマッピングしている場合は適宜変更
      messages,
      max_tokens: 1024
    });

    return completion.choices[0]?.message?.content ?? '';
  } catch (e) {
    console.error('[OpenAI] エラー:', e);
    return null;
  }
}

// =================== イベントハンドラ ===================

client.once(Events.ClientReady, async (c) => {
  console.log(`[Discord] ログイン完了: ${c.user.tag}`);
  await registerCommands();
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // チャンネル制限
  if (!isAllowedChannel(interaction)) {
    await interaction.reply({ content: 'このチャンネルでは利用できません。', ephemeral: true });
    return;
  }

  // channelId の型を絞り込む（biome対応: 非nullアサーション禁止）
  const channelId = interaction.channelId;
  if (!channelId) {
    await interaction.reply({ content: 'チャンネル情報を取得できませんでした。', ephemeral: true });
    return;
  }
  const name = interaction.commandName;

  if (name === 'time') {
    // 現在時刻を返信
    const now = new Date();
    await interaction.reply(`現在時刻: ${now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`);
    return;
  }

  if (name === 'init') {
    // シチュエーション入力モードにする
    if (!firestore) {
      await interaction.reply(FIREBASE_ERROR_MSG);
      return;
    }
    const ok = await setChannelState(channelId, { mode: 'situation_input' });
    if (!ok) {
      await interaction.reply(FIREBASE_ERROR_MSG);
      return;
    }
    await interaction.reply('シチュエーションを入力してください');
    return;
  }

  if (name === 'clear') {
    // 会話ログのみ削除（シチュエーションは維持）
    if (!firestore) {
      await interaction.reply(FIREBASE_ERROR_MSG);
      return;
    }
    const ok = await clearConversation(channelId);
    if (!ok) {
      await interaction.reply(FIREBASE_ERROR_MSG);
      return;
    }
    await interaction.reply('過去の会話を削除しました。シチュエーションは維持されます。');
    return;
  }

  if (name === 'show') {
    // 現在のシチュエーションを表示
    if (!firestore) {
      await interaction.reply(FIREBASE_ERROR_MSG);
      return;
    }
    const state = await getChannelState(channelId);
    const situation = state?.situation?.trim();
    if (!situation) {
      await interaction.reply('現在登録されているシチュエーションはありません。/init で登録できます。');
      return;
    }
    // 長文にも対応できるようにエンベッドで表示
    const embed = new EmbedBuilder().setTitle('現在のシチュエーション').setDescription(situation).setColor(0x3b82f6);
    await interaction.reply({ embeds: [embed] });
    return;
  }
});

// 通常メッセージ処理
client.on(Events.MessageCreate, async (message: Message) => {
  try {
    // Bot 自身や他 Bot は無視
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.GuildText) return;

    // チャンネル制限
    if (!ALLOWED_CHANNEL_IDS.has(message.channelId)) return;

    // スラッシュコマンドはここに来ないが、将来の拡張も考慮し "/" 始まりは無視（指定に従いモード破棄）
    if (message.content.startsWith('/')) {
      // シチュエーション入力モードを破棄
      if (firestore) {
        await setChannelState(message.channelId, { mode: 'idle' });
      }
      return;
    }

    // Firestore 必須
    if (!firestore) {
      await message.reply(FIREBASE_ERROR_MSG);
      return;
    }

    const state = (await getChannelState(message.channelId)) ?? ({ mode: 'idle' } as const);

    // シチュエーション入力モードの場合、今回の入力をシチュエーションとして登録
    if (state.mode === 'situation_input') {
      const ok = await setChannelState(message.channelId, {
        mode: 'idle',
        situation: message.content
      });
      if (!ok) {
        await message.reply(FIREBASE_ERROR_MSG);
        return;
      }
      await message.reply('シチュエーションを登録しました。会話を開始できます。');
      return;
    }

    // ここから通常の会話
    await withTyping(message.channel, async () => {
      // reinput（巻き戻し後の再入力）モード判定
      const isReinput = state.mode === 'awaiting_reinput';

      if (isReinput) {
        // モードを idle に戻し、rebase 情報は保持したまま（以降の履歴保存/AI応答に必要ないので消しても良いが、ここでは保持）
        await setChannelState(message.channelId, { mode: 'idle' });
      }

      // ユーザーメッセージを履歴に保存
      await addConversationMessage(message.channelId, {
        role: 'user',
        content: message.content,
        discordUserMessageId: message.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // 直近履歴取得
      const history = await fetchRecentMessages(message.channelId, HISTORY_LIMIT);

      // AI呼び出し
      const aiText = await chatWithAI({
        // exactOptionalPropertyTypes 対応: optional に undefined を渡すのは OK
        system: (state as ChannelState).situation,
        history,
        latestUser: { content: message.content }
      });

      if (!aiText) {
        await message.reply(OPENAI_ERROR_MSG);
        return;
      }

      const sent = await message.reply(aiText);

      // Bot 応答を保存
      await addConversationMessage(message.channelId, {
        role: 'assistant',
        content: aiText,
        discordMessageId: sent.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (e) {
    console.error('[MessageCreate] 予期せぬエラー:', e);
    try {
      await message.reply('エラーが発生しました。時間をおいて再度お試しください。');
    } catch {
      // ignore
    }
  }
});

/**
 * リアクション追加イベント
 * - BOTメッセージに♻️: 既存の「再生成」
 * - ユーザーメッセージに♻️: 指定メッセージ以降の履歴を削除し、「入力してください」で促し、その後の入力から会話を続行
 */
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    // 部分的（Partial）を解決
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch {
        return;
      }
    }

    const message = reaction.message as Message<true>;

    // チャンネル制限
    if (!ALLOWED_CHANNEL_IDS.has(message.channelId)) return;

    if (reaction.emoji.name !== REGENERATE_EMOJI) return;

    // Firestore 必須
    if (!firestore) {
      await message.reply(FIREBASE_ERROR_MSG);
      return;
    }

    // 分岐: BOTメッセージに対する♻️ => 再生成（既存機能）
    if (message.author?.bot) {
      const ctx = await buildRegenerateContextFromBotMessage(message.channelId, message.id);
      if (!ctx) {
        await message.reply('再生成に必要な会話履歴が見つかりませんでした。');
        return;
      }

      await withTyping(message.channel, async () => {
        const aiText = await chatWithAI({
          system: ctx.system,
          history: ctx.messages
        });

        if (!aiText) {
          await message.reply(OPENAI_ERROR_MSG);
          return;
        }

        const sent = await message.reply(aiText);

        // 新しい Bot 応答として保存
        await addConversationMessage(message.channelId, {
          role: 'assistant',
          content: aiText,
          discordMessageId: sent.id,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
      return;
    }

    // 分岐: ユーザーメッセージに対する♻️ => 指定メッセージ以降の履歴を削除し再入力待ちへ
    // message はユーザー投稿
    await withTyping(message.channel, async () => {
      // 指定のユーザー投稿（discordUserMessageId=message.id）以降を削除
      const result = await truncateConversationAfter(message.channelId, { targetUserId: message.id });
      if (!result.ok) {
        await message.reply(FIREBASE_ERROR_MSG);
        return;
      }

      // 状態を再入力待ちに遷移（この「入力してください」はDBに保存しない）
      await setChannelState(message.channelId, {
        mode: 'awaiting_reinput',
        rebaseLastUserMessageId: message.id,
        // exactOptionalPropertyTypes 対応: optional に undefined を許容
        rebaseLastAssistantMessageId: undefined
      });

      await message.reply('入力してください');
      // ここでは返信をDBに入れない（仕様）
    });
  } catch (e) {
    console.error('[MessageReactionAdd] エラー:', e);
    try {
      const ch = reaction.message.channel;
      if (ch?.isTextBased?.()) {
        await (ch as unknown as { send: (c: string) => Promise<unknown> }).send(
          'エラーが発生しました。時間をおいて再度お試しください。'
        );
      }
    } catch {
      // ignore
    }
  }
});

// =================== ログイン ===================
async function main() {
  if (!DISCORD_BOT_TOKEN) {
    console.error('DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
  }
  // login 実行前に型ガード
  if (!client) {
    throw new Error('Discord client が初期化されていません。');
  }
  await client.login(DISCORD_BOT_TOKEN);
}

main().catch((e) => {
  console.error('起動時エラー:', e);
  process.exit(1);
});
