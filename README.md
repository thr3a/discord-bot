# ts実行

```bash
node --import tsx --env-file .env --watch ./src/scripts/hello.ts
```

```
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
```

を

```
import OpenAI from "openai";
```

のライブラリだけに変更して@ai-sdk/openaiとai削除したい
修正して
以下はサンプルコード

```ts
import OpenAI from "openai";
const client = new OpenAI();

const completion = await client.chat.completions.create({
    model: "gpt-4.1",
    messages: [
        {
            role: "user",
            content: "Write a one-sentence bedtime story about a unicorn.",
        },
    ],
});
console.log(completion.choices[0].message.content);
```
