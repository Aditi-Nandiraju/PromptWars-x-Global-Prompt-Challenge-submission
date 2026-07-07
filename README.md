# Civic Assistant

GenAI-powered government services portal and grievance assistant. Runs
entirely on local models — no external API keys, no rate limits, works
offline once set up.

## Architecture

| Feature | Endpoint | Model |
|---|---|---|
| Conversational assistant | `POST /chat` | Local LLM via [Ollama](https://ollama.com) (`qwen2.5:3b`) |
| Document simplification | `POST /simplify-document` | Local LLM via Ollama (`qwen2.5:3b`) |
| Service recommendation | `POST /recommend-service` | Local embeddings via [`@xenova/transformers`](https://github.com/xenova/transformers.js) (`paraphrase-multilingual-MiniLM-L12-v2`) |
| Grievance triage | `POST /report-issue` | Local embeddings (category match) + rule-based keyword urgency scorer |

`/chat` and `/simplify-document` fall back to canned multilingual mock
responses if Ollama isn't running, so the app never crashes — it just
degrades gracefully. `/recommend-service` and `/report-issue` don't
depend on Ollama at all; they run fully in-process via WASM.

## Setup

### 1. Install Ollama and pull the model

Install Ollama from [ollama.com](https://ollama.com), then:

```bash
ollama pull qwen2.5:3b
ollama serve
```

Leave `ollama serve` running in a terminal (on most installs it also
runs automatically as a background service after install — in that
case you can skip this step).

### 2. Install dependencies and start the app

```bash
npm install
node server.js
```

The first `/recommend-service` or `/report-issue` request downloads the
embedding model (~470MB) from Hugging Face into a local cache
(`node_modules/@xenova/transformers` cache directory) — this needs
internet access once. After that, everything runs fully offline.

The server starts on **http://localhost:3000** by default. If Ollama
isn't reachable at startup, you'll see:

```
Ollama not running — start it with `ollama serve` (and run `ollama pull qwen2.5:3b` if you haven't already).
/chat and /simplify-document will use offline fallback responses until Ollama is available.
```

The app keeps running in this state — chat and document simplification
just use the built-in multilingual fallback responses instead of the LLM.

### 3. Run the offline test suite

```bash
npm test
```

Runs all API endpoint tests against a freshly spawned server with no
API keys in the environment.

## Configuration

Copy `.env.example` to `.env` to override defaults:

```
PORT=3000
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:3b
```

## Known limitations

- The compact multilingual embedding model (`paraphrase-multilingual-MiniLM-L12-v2`)
  occasionally favors a generic identity-document match (e.g. Aadhaar) over the
  exact topical service for some Tamil queries, since Aadhaar-related phrasing
  is broadly referenced across many other services. Recommendations still
  return relevant results in the top 2-3, just not always ranked first.
- The first request to `/recommend-service` or `/report-issue` after a cold
  start takes a few seconds while the embedding model loads into memory.
