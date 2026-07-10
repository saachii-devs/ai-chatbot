# AI Assistant

A ChatGPT-style chat app you can also talk to. React + TypeScript + Vite, Tailwind,
no backend — chats live in `localStorage`.

- Streaming replies, stop/retry, multiple conversations, search, cross-tab sync
- Voice calls: live transcript, spoken replies, barge-in. Hang up and the chat keeps
  a one-line marker you can unfold into the transcript
- Chat works with any OpenAI-compatible provider; voice with ElevenLabs or the
  browser's built-in Web Speech API. Both swap via `.env`, no code change

## Setup

```bash
npm install
cp .env.example .env    # then add VITE_CHAT_API_KEY
npm run dev
```

Vite reads `.env` only at startup — restart the dev server after editing it. Voice
needs no key: without one it falls back to Web Speech (Chrome/Edge).

| Script | |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck + bundle to `dist/` |
| `npm run preview` | Serve the build |
| `npm run lint` | oxlint |

See `.env.example` for every setting, and `PROJECT.md` for the architecture.

> Keys in `.env` ship in the browser bundle and are readable in DevTools. Fine
> locally; production needs a backend proxy holding them.
