import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  type TextChannel
} from 'discord.js';
import { config as dotenvConfig } from 'dotenv';
import OpenAI from 'openai';
import {
  deleteAllConversations,
  deleteConversationsAfterDiscordMessageId,
  getChannelState,
  getRecentConversation,
  saveAssistantMessage,
  saveUserMessage,
  setChannelMode,
  setChannelSituation,
  withFirestoreOrNull
} from './discord/firestore.js';
import { buildChatCompletionMessages, handleRecycleActionOnAssistantLogic } from './discord/logic.js';
import {
  ALLOWED_CHANNEL_IDS,
  type ChannelState,
  type ConversationMessage,
  DEFAULT_SYSTEM_PROMPT,
  FALLBACK_FIRESTORE_ERROR,
  FALLBACK_OPENAI_ERROR,
  MAX_HISTORY,
  RECYCLE_EMOJI
} from './discord/types.js';

dotenvConfig();

// 環境変数検証
const { DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, FIREBASE_SECRET_JSON } = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) {
  // 必須環境変数がない場合は即時終了
  console.error('環境変数 DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID は必須です。');
  process.exit(1);
}

// Firestore 初期化（失敗しても null を返す設計）
const firestore = await withFirestoreOrNull(FIREBASE_SECRET_JSON);

// OpenAI クライアント初期化
const openai = new OpenAI({
  apiKey: 'sk-dummy',
  baseURL: 'http://192.168.16.20:8000/v1'
});

// Discord クライアント初期化
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// スラッシュコマンド定義
const commands = [
  new SlashCommandBuilder().setName('time').setDescription('現在時刻を返す'),
  new SlashCommandBuilder().setName('init').setDescription('シチュエーション入力モードへ遷移'),
  new SlashCommandBuilder().setName('clear').setDescription('会話履歴を削除（シチュエーションは保持）'),
  new SlashCommandBuilder().setName('show').setDescription('現在登録されているシチュエーションを表示'),
  new SlashCommandBuilder().setName('debug').setDescription('会話一覧を箇条書き表示')
].map((c) => c.toJSON());

// コマンド登録
client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
    console.log('スラッシュコマンドを同期しました');
  } catch (e) {
    console.error('スラッシュコマンド同期に失敗:', e);
  }
});

// ユーティリティ: 許可チャンネル判定
function isAllowedChannel(channelId?: string | null): boolean {
  if (!channelId) return false;
  if (ALLOWED_CHANNEL_IDS.size === 0) return true; // 未設定なら全許可（テスト/開発用）
  return ALLOWED_CHANNEL_IDS.has(channelId);
}

// スラッシュコマンド
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!isAllowedChannel(interaction.channelId)) return;

  const channel = interaction.channel;
  if (!channel || channel?.type !== ChannelType.GuildText) {
    await interaction.reply({ content: 'このチャンネルタイプでは動作しません', ephemeral: true });
    return;
  }

  if (interaction.commandName === 'time') {
    const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    await interaction.reply(`現在時刻: ${now}`);
    return;
  }

  if (interaction.commandName === 'init') {
    if (!firestore) {
      await interaction.reply(FALLBACK_FIRESTORE_ERROR);
      return;
    }
    await deleteAllConversations(firestore, channel.id);
    await setChannelMode(firestore, channel.id, 'situation_input');
    await interaction.reply('シチュエーションを入力してください');
    return;
  }

  if (interaction.commandName === 'clear') {
    if (!firestore) {
      await interaction.reply(FALLBACK_FIRESTORE_ERROR);
      return;
    }
    await deleteAllConversations(firestore, channel.id);
    await interaction.reply('過去の会話を削除しました。シチュエーションは維持されます。');
    return;
  }

  if (interaction.commandName === 'show') {
    if (!firestore) {
      await interaction.reply(FALLBACK_FIRESTORE_ERROR);
      return;
    }
    const state = await getChannelState(firestore, channel.id);
    const situation = state?.situation;
    if (!situation) {
      await interaction.reply('現在登録されているシチュエーションはありません。/init で登録できます。');
      return;
    }
    const embed = new EmbedBuilder().setTitle('現在のシチュエーション').setDescription(situation).setColor(0x00ae86);
    await interaction.reply({ embeds: [embed] });
    return;
  }

  if (interaction.commandName === 'debug') {
    // Firestore がない場合はエラー応答
    if (!firestore) {
      await interaction.reply(FALLBACK_FIRESTORE_ERROR);
      return;
    }
    // 直近履歴とシステムを取得し、実際にAPIへ投げる messages を構築
    const state = await getChannelState(firestore, channel.id);
    const history = await getRecentConversation(firestore, channel.id, MAX_HISTORY);
    const system = state?.situation ?? DEFAULT_SYSTEM_PROMPT;
    const messages = buildChatCompletionMessages(system, history);

    // 各行を「- role: 先頭20文字（超過時は…）」で1行に整形（行内改行は削除）
    const toOneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
    const clip = (s: string) => (s.length > 20 ? `${s.slice(0, 20)}…` : s);
    const lines = messages.map((m) => `- ${m.role}: ${clip(toOneLine(m.content))}`);

    const description = lines.join('\n') || '(empty)';

    const embed = new EmbedBuilder().setTitle('次にAPIに投げる会話一覧').setDescription(description).setColor(0x888888);

    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }
});

// 通常メッセージ
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!isAllowedChannel(message.channelId)) return;

  // "/" 始まりは会話対象外かつ idle へ
  if (message.content.startsWith('/')) {
    if (firestore) {
      await setChannelMode(firestore, message.channelId, 'idle');
    }
    return;
  }

  if (!firestore) {
    await (message.channel as TextChannel).send(FALLBACK_FIRESTORE_ERROR);
    return;
  }

  const channelState = (await getChannelState(firestore, message.channelId)) ?? ({ mode: 'idle' } as ChannelState);

  if (channelState.mode === 'situation_input') {
    // 受信本文をシチュエーションとして保存、状態 idle
    await setChannelSituation(firestore, message.channelId, message.content);
    await setChannelMode(firestore, message.channelId, 'idle');
    await (message.channel as TextChannel).send('シチュエーションを登録しました。会話を開始できます。');
    return;
  }

  // reinput からの復帰だけ idle に戻す
  if (channelState.mode === 'awaiting_reinput') {
    await setChannelMode(firestore, message.channelId, 'idle');
  }

  // 会話ログにユーザー投稿保存
  await saveUserMessage(firestore, message.channelId, {
    role: 'user',
    content: message.content,
    discordUserMessageId: message.id
  });

  // 履歴取得
  const history = await getRecentConversation(firestore, message.channelId, MAX_HISTORY);
  const system = channelState.situation ?? DEFAULT_SYSTEM_PROMPT;

  // タイピング
  try {
    await message.channel.sendTyping();
  } catch {}

  // OpenAI へ
  const payload = buildChatCompletionMessages(system, history);
  try {
    const res = await openai.chat.completions.create({
      model: 'main',
      messages: payload
    });
    const content = res.choices?.[0]?.message?.content ?? '';
    const sent = await (message.channel as TextChannel).send(content || '(empty)');
    // BOT 応答を保存
    await saveAssistantMessage(firestore, message.channelId, {
      role: 'assistant',
      content: content,
      discordMessageId: sent.id
    });
  } catch (e) {
    console.error(e);
    await (message.channel as TextChannel).send(FALLBACK_OPENAI_ERROR);
  }
});

// リアクション（♻️）
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  try {
    if (reaction.partial) await reaction.fetch();
  } catch {
    // 取得失敗は無視
    return;
  }
  const msg = reaction.message;
  if (!isAllowedChannel(msg.channelId)) return;
  if (reaction.emoji.name !== RECYCLE_EMOJI) return;
  if (!firestore) {
    if (msg.channel) {
      await (msg.channel as TextChannel).send(FALLBACK_FIRESTORE_ERROR);
    }
    return;
  }

  const channelId = msg.channelId;

  // 対象が BOT メッセージ or ユーザーメッセージで分岐
  if (msg.author?.bot) {
    // BOTメッセージの再生成
    const history = await getRecentConversation(firestore, channelId, MAX_HISTORY);
    const { nextMessages, deleteFromDiscordMessageId } = handleRecycleActionOnAssistantLogic(history, msg.id);
    if (!nextMessages || !deleteFromDiscordMessageId) return;

    // DBから対象メッセージ以降を削除
    await deleteConversationsAfterDiscordMessageId(firestore, channelId, deleteFromDiscordMessageId);

    const system = (await getChannelState(firestore, channelId))?.situation ?? DEFAULT_SYSTEM_PROMPT;
    const payload = buildChatCompletionMessages(system, nextMessages as ConversationMessage[]);

    try {
      await (msg.channel as TextChannel).sendTyping();
    } catch {}

    try {
      const res = await openai.chat.completions.create({
        model: 'main',
        messages: payload
      });
      const content = res.choices?.[0]?.message?.content ?? '';
      const reply = await (msg.channel as TextChannel).send(content || '(empty)');
      await saveAssistantMessage(firestore, channelId, {
        role: 'assistant',
        content,
        discordMessageId: reply.id
      });
    } catch (e) {
      console.error(e);
      await (msg.channel as TextChannel).send(FALLBACK_OPENAI_ERROR);
    }
  } else {
    // ユーザーメッセージに対する巻き戻し→reinput
    await deleteConversationsAfterDiscordMessageId(firestore, channelId, msg.id);
    await setChannelMode(firestore, channelId, 'awaiting_reinput');
    await (msg.channel as TextChannel).send('入力してください');
  }
});

client.login(DISCORD_BOT_TOKEN).catch((e) => {
  console.error('Discord ログイン失敗:', e);
  process.exit(1);
});
