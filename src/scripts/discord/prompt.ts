import { createOpenAI } from '@ai-sdk/openai';
import { generateObject } from 'ai';
import { ChannelType, type CommandInteraction, type Message, type TextChannel } from 'discord.js';
import type { Firestore } from 'firebase-admin/firestore';
import { dedent } from 'ts-dedent';
import { setChannelMode } from './firestore.js';
import { schema, systemPrompt } from './prompt-schema.js';
import { OK_EMOJI } from './types.js';

const openai = createOpenAI({
  baseURL: 'http://192.168.16.20:8000/v1',
  apiKey: 'sk-dummy'
});

/**
 * /prompt コマンドの初期応答を処理する
 */
export async function handlePromptCommand(firestore: Firestore, interaction: CommandInteraction): Promise<void> {
  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: 'このコマンドはテキストチャンネルでのみ使用できます。',
      ephemeral: true
    });
    return;
  }

  await setChannelMode(firestore, interaction.channelId, 'prompt_situation_input');
  await interaction.reply({
    content: '拡張したいシチュエーションを入力してください。',
    ephemeral: true
  });
}

/**
 * 拡張したいシチュエーションを受け取り、AIで生成したプロンプトを返信する
 */
export async function handlePromptSituationInput(firestore: Firestore, message: Message): Promise<void> {
  if (message.channel.type !== ChannelType.GuildText) {
    return;
  }
  const situation = message.content;
  await setChannelMode(firestore, message.channelId, 'idle');

  try {
    await message.channel.sendTyping();
  } catch (e) {
    console.warn('Typing indicator failed:', e);
  }

  try {
    const { object } = await generateObject({
      model: openai.chat('main'),
      schema,
      prompt: situation,
      system: systemPrompt
    });

    const markdown = generateMarkdown(object);
    const sentMessage = await message.channel.send(markdown);
    await sentMessage.react(OK_EMOJI);
  } catch (e) {
    console.error('AI response generation failed:', e);
    await message.channel.send('プロンプトの生成に失敗しました。時間をおいて再度お試しください。');
  }
}

/**
 * AIが生成したオブジェクトからMarkdownプロンプトを生成する
 */
function generateMarkdown(object: unknown): string {
  const data = object as any; // 簡単のため any を使用
  if (!data || Object.keys(data).length === 0) {
    return '生成されたデータが空です。';
  }

  const user = data.userCharacterSetting;
  const ai = data.aiCharacterSetting;
  const worldSetting = data.worldSetting;
  const md = dedent`
    今からロールプレイを行いましょう。"${ai?.name ?? ''}"というキャラとしてロールプレイしてください。以下に示す設定に従い、キャラに成りきって返答してください。
    <WorldSetting>
      <Place>${worldSetting?.location ?? ''}</Place>
      <Time>${worldSetting?.time ?? ''}</Time>
      <Situation>${worldSetting?.situation ?? ''}</Situation>
    </WorldSetting>

    <SceneSetting>
      ${data.dialogueSceneSetting}
    </SceneSetting>

    <UserCharacter>
      <Name>${user?.name ?? ''}</Name>
      <Gender>${user?.gender ?? ''}</Gender>
      <Age>${user?.age ?? 0}</Age>
      <Personality>${user?.personality ?? ''}</Personality>
      <Background>${user?.background ?? ''}</Background>
    </UserCharacter>

    <YourCharacter>
      <Name>${ai?.name ?? ''}</Name>
      <Gender>${ai?.gender ?? ''}</Gender>
      <Age>${ai?.age ?? 0}</Age>
      <FirstPerson>${ai?.firstPersonPronoun ?? ''}</FirstPerson>
      <SecondPerson>${ai?.secondPersonPronoun ?? ''}</SecondPerson>
      <Personality>${ai?.personality ?? ''}</Personality>
      <Background>${ai?.background ?? ''}</Background>
    </YourCharacter>

    <Goal>
      ${data.goal}
    </Goal>

    <DialogueTone>
      ${data.dialogueTone}
    </DialogueTone>

    <Relationship>
      ${data.relationshipSetting}
    </Relationship>
    
    <ResponseFormat>
      ${ai?.name ?? ''}が話す内容は、必ず「」かぎ括弧で囲んで記述する。${ai?.name ?? ''}の動作、表情、周囲の状況などは、必ず（）丸括弧で囲んで記述する。
      最後に必ず「現在の${ai?.name ?? ''}の服装: 〇〇」と書く
    </ResponseFormat>
  `;
  return md;
}
