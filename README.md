# AI Assistant

An AI chat app you can also talk to. React + TypeScript + Vite, Tailwind

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
