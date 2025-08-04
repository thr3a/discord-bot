# Discord BOT 再実装 仕様書（src/scripts/discord.ts 相当）

以下は、同等BOTをゼロから再実装できるようにするための要件定義（仕様・挙動・DB処理）の箇条書き仕様。

## 前提・環境
- 実行環境: Node.js v22 / TypeScript
- Discord ライブラリ: discord.js v14
- OpenAI 互換APIクライアント: openai (official SDK)
- データベース: Firebase Firestore（firebase-admin）
- 環境変数:
  - DISCORD_BOT_TOKEN: Discord Bot Token
  - DISCORD_CLIENT_ID: Discord Application Client ID
  - FIREBASE_SECRET_JSON: Firebase サービスアカウント JSON (文字列; private_key の \n は実際の改行に置換して利用)
- 許可チャンネル制御: BOTは特定チャンネルIDのみに反応（固定のID集合を持つ）
- 既定の会話履歴最大保持件数（参照件数）: 直近 50 件を上限として利用

## BOTの仕様
- スラッシュコマンドをアプリケーションコマンドとしてグローバル登録する
  - /time: 現在時刻（Asia/Tokyo）を返す
  - /init: シチュエーション入力モードへ遷移
  - /clear: 会話履歴のみを削除（シチュエーションは保持）
  - /show: 現在登録されているシチュエーションをエンベッドで表示
  - /debug: 次に API に投げるべき会話一覧を簡易表示（各行 20 文字でカット）
    - Firestore から直近履歴（最大50件）とチャンネルのシチュエーションを取得
    - buildChatCompletionMessages(system, history) で API に送る messages を構築（system/user/assistant を含む）
    - 各 message を「- role: 先頭20文字（21文字以上は … を付与）」形式で1行に整形
      - 行内の改行はスペースに置換して1行化
      - 例: 
        - - assistant: こんにちは……
        - - user: 元気？
        - - assistant: 両親や友だちが息…
    - Discord への表示はエンベッド（ephemeral=true）
- 通常メッセージに反応して会話する
  - 許可チャンネル内のユーザー投稿のみ処理
  - "/" 始まりのメッセージは会話処理対象外とし、シチュエーション入力モードを破棄（idleへ）
  - Firestore 未接続時は固定メッセージでエラー応答
- リアクションイベントの取り扱い（♻️）
  - BOTメッセージへの♻️: 直近の会話文脈から再生成を行い、新たなBOT応答を投稿・保存
    - 例: HUMAN: 投稿1,AI: 投稿2, HUMAN: 投稿3, AI: 投稿4のときに投稿2にリアクションしたら投稿2~4はDB削除して投稿1のみをAPIに投げる
  - ユーザーメッセージへの♻️: 指定メッセージ以降の履歴を削除し、再入力待ちモードへ遷移、促しメッセージ（「入力してください」）のみ投稿（DB保存はしない）
    - 例: HUMAN: 投稿1,AI: 投稿2, HUMAN: 投稿3, AI: 投稿4のときに投稿3にリアクションしたら「入力してください」と返信
    - 投稿3,4はDB削除、その後に両職されたのを投稿5とすると投稿1,投稿2,投稿5をAPIになげる
- OpenAI 互換APIへの問い合わせ
  - ベースURLは http://192.168.16.20:8000/v1 を使用し API Key はダミー(sk-dummy)
  - Chat Completions フォーマットで、system（シチュエーション）/user/assistant のメッセージ配列を送信
  - モデル名は "main" を使用
  - 応答の本文をテキストとして抽出し、Discord に返信
- タイピングインジケータ
  - 応答生成時、可能であれば sendTyping を使ってタイピング中表示
- エラーハンドリング
  - Firestore 未接続時の固定メッセージ
  - OpenAI 応答失敗時の固定メッセージ
  - 予期せぬ例外時はログ出力し、ユーザーには包括的なエラーメッセージを返信

## 挙動（ユーザーフロー）
- /time:
  - 許可チャンネル判定 → 現在時刻を文字列で返信
- /init:
  - Firestore 接続チェック → チャンネル状態を「situation_input」に更新 → 「シチュエーションを入力してください」と返信
  - シチュエーション入力後は過去の会話全削除する
- /clear:
  - Firestore 接続チェック → 会話コレクションを全削除 → 「過去の会話を削除しました。シチュエーションは維持されます。」と返信
- /show:
  - Firestore 接続チェック → チャンネル状態のシチュエーション文字列を取得
  - 登録なし: 「現在登録されているシチュエーションはありません。/init で登録できます。」と返信
  - 登録あり: エンベッドで表示して返信
- 通常メッセージ（ユーザー）:
  - 許可チャンネル判定 → "/" 始まりは無視（状態を idle に）
  - Firestore 接続チェック
  - チャンネル状態取得
    - 状態が「situation_input」:
      - 受信本文をシチュエーションとして保存し、状態を idle に
      - 「シチュエーションを登録しました。会話を開始できます。」と返信（会話ログには保存しない）
    - それ以外（通常会話）:
      - reinput（awaiting_reinput）であれば状態を idle に戻す（rebase 情報は保持してよい）
      - ユーザー投稿を会話ログとして保存
      - 直近履歴（最大50件）を取得
      - system はシチュエーション（未設定ならデフォルト "You are a helpful chatbot."）として AI に渡す
      - 生成テキストを返信 → 返信を会話ログとして保存
- リアクション（♻️）:
  - 許可チャンネル判定 → Firestore 接続チェック
  - 対象がBOTメッセージ:
    - 対象BOT発言の直前の「assistant」「user」2つの履歴で文脈を再構成し、同assistant発言は除いて AI に再生成依頼
    - 新たな応答を投稿し、会話ログに保存
  - 対象がユーザーメッセージ:
    - そのユーザー投稿（discordUserMessageId 一致）以降の履歴を削除
    - 状態を awaiting_reinput に遷移し、最後に対象ユーザー投稿のIDを rebase 情報として保持
    - 「入力してください」と返信（この促しは会話ログに保存しない）

## DB（Firestore）設計・処理
- コレクション/ドキュメント
  - channelStates コレクション
    - ドキュメントID: Discord チャンネルID
    - フィールド:
      - mode: 'idle' | 'situation_input' | 'awaiting_reinput'
      - situation: シチュエーション文字列（任意）
      - rebaseLastUserMessageId: 巻き戻し基準の最後のユーザーDiscordメッセージID（任意）
      - rebaseLastAssistantMessageId: 巻き戻し基準の最後のBOT DiscordメッセージID（任意）
      - updatedAt: サーバタイムスタンプ
  - channelConversations コレクション
    - ドキュメントID: Discord チャンネルID
    - サブコレクション: messages
      - ドキュメント: 1会話メッセージ
      - フィールド:
        - role: 'user' | 'assistant'
        - content: 本文
        - discordMessageId: BOT返信に対応するDiscordメッセージID（assistant側のみ・任意）
        - discordUserMessageId: ユーザー投稿に対応するDiscordメッセージID（user側のみ・任意）
        - createdAt: サーバタイムスタンプ
- 初期化
  - FIREBASE_SECRET_JSON を解析し、ServiceAccount を構築
  - すでに admin.apps が存在しない場合のみ initializeApp
  - 初期化失敗時は Firestore 利用不可として扱い、機能はエラーメッセージでフォールバック
- チャンネル状態の取得・更新
  - get: 該当ドキュメントを取得。存在しない場合は null を返す
  - set: mode と updatedAt をデフォルトに設定しつつ、指定されたフィールドを merge 更新
- 会話メッセージ
  - 追加: messages サブコレクションに追加（createdAt は serverTimestamp）
  - 取得: createdAt 昇順で全件取得 → 末尾から上限件数（50件）をスライスして使用（serverTimestampの都合で昇順取得後に制限）
- 履歴の巻き戻し
  - 指定した Discord メッセージID（ユーザー or BOT）に一致する位置を昇順リストから検索し、以降のドキュメントをバッチ削除
  - 巻き戻し後、チャンネル状態に reinput 用のモード（awaiting_reinput）と参照IDを格納
- 全削除
  - 指定チャンネルの messages サブコレクションを全件取得し、バッチで削除
- 例外・失敗時の扱い
  - Firestore 接続不可/操作失敗時は固定エラーメッセージで通知
  - 失敗時の部分状態は致し方ない範囲で許容（例: 促しメッセージをDBに保存しない）

## Discord 側設定・制約
- intents:
  - Guilds, GuildMessages, GuildMessageReactions, MessageContent を要求
- partials:
  - Message, Channel, Reaction を有効
- 許可チャンネル:
  - 固定のチャンネルID集合を保持し、該当チャンネルのみ動作
- スラッシュコマンド登録:
  - アプリケーション全体コマンドに登録し、起動時（ready）に同期

## セキュリティ・その他
- 環境変数の未設定時はプロセス終了（必須値）
- FIREBASE_SECRET_JSON の private_key は \n を実改行に正規化
- OpenAI 呼び出しはベースURL/キーを外部設定可能とする実装に拡張しやすい構造を前提
- 会話履歴保存はユーザー発言とBOT応答のみ（促し・通知系は保存しない方針）
