# 🧠 Watchlog AI Tracer (Node.js)

`watchlog-ai-tracer` is a lightweight SDK for tracing AI interactions (like GPT-4 requests) by sending spans to the Watchlog Agent installed on your local server.

## 🚀 Installation

```bash
npm install ./watchlog-ai-tracer
```

Or use it directly in your project:

```js
const WatchlogTracer = require('./watchlog-ai-tracer');
```

## ⚙️ How It Works

### 1. Start a trace and spans

```js
const tracer = new WatchlogTracer();

tracer.startTrace();

const rootSpan = tracer.startSpan('handle-request', {
  feature: 'chat',
  promptVersion: 'v1'
});

const llmSpan = tracer.childSpan(rootSpan, 'call-llm');

// ... make LLM call

tracer.endSpan(llmSpan, {
  tokens: 67,
  cost: 0.0021,
  model: 'gpt-4',
  provider: 'openai',
  input: 'Summarize this...',
  output: 'Here is the summary...'
});

await tracer.send();
```

### 2. Reliable delivery with fallback queue

- If the local Watchlog Agent (`http://localhost:3774/ai-tracer`) is unavailable, spans will be stored silently in a local file.
- Queue file path is OS-independent (e.g. `/tmp/watchlog-queue.jsonl` on Unix-based systems).

### 3. Metadata Support

```js
{
  feature: 'chat-api',
  step: 'generate',
  promptVersion: 'v3',
  userId: 'u-123',
  label: 'production-test'
}
```

---

## 📦 Span Format

```json
{
  "traceId": "trace-xxx",
  "spanId": "span-yyy",
  "parentId": null,
  "name": "call-llm",
  "startTime": "...",
  "endTime": "...",
  "duration": 1234,
  "tokens": 64,
  "cost": 0.0018,
  "model": "gpt-4",
  "provider": "openai",
  "input": "...",
  "output": "...",
  "metadata": {
    "feature": "summary",
    "promptVersion": "v2"
  }
}
```

---

## 🔁 Local Queue Management

- The file `/tmp/watchlog-queue.jsonl` is flushed every time `send()` is called.
- Successfully sent spans are removed.
- Failed spans remain and will retry on the next `.send()` call.

---

## 📄 License

MIT — Built for Watchlog by [Mohammadreza](https://github.com/mohammadnajm)