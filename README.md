# Orbit

A friendly, general-purpose AI chatbot powered by [Groq](https://groq.com). Ask questions on any topic, draft writing, brainstorm, get concepts explained and keep asking follow-ups.

Plain HTML, CSS and JavaScript on the front end, plus one Vercel serverless function (`api/chat.js`) that talks to Groq. There's no build step and no dependencies.

```
orbit/
├── api/chat.js          # POST /api/chat → Groq (key stays server-side)
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── theme-init.js    # applies saved theme before first paint
│   └── assets/robot.png
├── test/chat.test.js    # API tests (Groq mocked, no key needed)
├── dev-server.js        # local server that mimics Vercel
├── vercel.json          # output dir, function timeout, security headers
└── .env.example
```

## Run locally

Requires Node 18 or newer.

```bash
cp .env.example .env.local     # then put your real key in .env.local
npm run dev                    # http://localhost:3000
npm test                       # API tests, no key or network needed
```

`.env.local` is git-ignored, so never commit it.

## Configuration

| Variable       | Required | Default               | Notes                                  |
| -------------- | -------- | --------------------- | -------------------------------------- |
| `GROQ_API_KEY` | yes      | none                  | Create one at console.groq.com/keys    |
| `GROQ_MODEL`   | no       | `openai/gpt-oss-120b` | Any chat model your Groq account has   |

## Limits and safeguards

- **Input:** 4,000 characters per message (enforced in the browser and on the server).
- **Context:** the last 20 messages, capped at about 24,000 characters in total. The newest messages win, and older ones are clipped.
- **Request size:** 200 KB maximum.
- **Timeouts:** 25 s for the Groq request on the server, 40 s on the client, and a 30 s Vercel function limit.
- **Reply length:** up to 2,048 tokens. If a reply is cut off, the UI says so.
- **Errors:** Groq errors (bad key, rate limit, unknown model, outages) become clear messages with a **Try again** button.
- **Rendering:** replies are rendered as escaped Markdown, so model output can never inject HTML.
- **Security headers:** a strict Content-Security-Policy and related headers are set in `vercel.json`.

This version has no authentication, database, payments, custom rules or knowledge files. Anyone with the URL can use it, and the usage counts against your Groq key's limits.

## Deploy to Vercel

1. Push this folder to a GitHub repo.
2. In Vercel, go to **Add New → Project**, import the repo, and leave the framework preset as **Other**. No build settings are needed.
3. Under **Settings → Environment Variables**, add `GROQ_API_KEY` and, optionally, `GROQ_MODEL`.
4. Deploy. If you add or change variables later, redeploy for them to take effect.
