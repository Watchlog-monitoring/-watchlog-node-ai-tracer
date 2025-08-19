# @watchlog/ai-tracer

A lightweight Node.js tracer for AI workloads, designed to capture and forward span data for monitoring and observability with Watchlog.

## Features

- **Automatic trace & span management** with unique IDs  
- **Disk-backed queue** with TTL to prevent data loss  
- **Batch HTTP delivery** with retry and exponential backoff  
- **Kubernetes-aware endpoint detection**  
- **Sensitive field sanitization** and output truncation  

## Installation

```bash
npm install @watchlog/ai-tracer
```

or

```bash
yarn add @watchlog/ai-tracer
```

## Usage

```js
// README example — OpenAI call + tracing (non-blocking, no sleep)
const WatchlogTracer = require('@watchlog/ai-tracer');

// 1) Init tracer (exit hooks خودکار: beforeExit / SIGINT / SIGTERM)
const tracer = new WatchlogTracer({
  app: 'your-app-name',                 // 🆔 required
  batchSize: 200,                       // 🔄 spans per HTTP batch
  flushOnSpanCount: 200,                // 🧺 enqueue to disk after N spans
  autoFlushInterval: 1500,              // ⏲ background flush interval (ms)
  maxQueueSize: 100000,                 // 📥 max queued spans on disk
  queueItemTTL: 10 * 60 * 1000,         // ⌛ TTL for queued spans (ms)
  // autoInstallExitHooks: true,        // ✅ default (flushes on exit)
});

// 2) Helper: Wrap any async work in a span
async function traceAsync(name, metadata, fn) {
  const spanId = tracer.startSpan(name, metadata);
  try {
    const result = await fn();
    tracer.endSpan(spanId, { output: 'ok' });
    return result;
  } catch (e) {
    tracer.endSpan(spanId, { output: String(e?.message || e) });
    throw e;
  } finally {
    tracer.send(); // non-blocking: write to disk + background flush
  }
}

// 3) Call OpenAI and capture input/output/tokens in trace
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function callOpenAI(prompt, { parentId } = {}) {
  const llmSpan = tracer.childSpan(parentId, 'openai.chat.completions', {
    provider: 'openai',
    model: 'gpt-4o',
  });

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const json = await res.json();
    const output = json?.choices?.[0]?.message?.content ?? '';
    const tokens = json?.usage?.total_tokens ?? 0;

    tracer.endSpan(llmSpan, {
      input: prompt,
      output,
      tokens,
      model: 'gpt-4o',
      provider: 'openai',
      cost: 0, // Optional : if you have cost
    });

    return output;
  } catch (e) {
    tracer.endSpan(llmSpan, { input: prompt, output: String(e?.message || e) });
    throw e;
  } finally {
    tracer.send(); // non-blocking
  }
}

// 4) Example flow (root span + child span for LLM)
async function main() {
  tracer.startTrace(); // optional but recommended (groups spans)

  const root = tracer.startSpan('handle-request', { feature: 'ai-summary' });

  // Validate input (fast op, no sleep)
  await traceAsync('validate-input', { parentId: root }, async () => {
    // ... your validation logic
  });

  // Call LLM and capture trace
  const summary = await callOpenAI('Summarize: Hello world...', { parentId: root });

  // Close root
  tracer.endSpan(root, { output: 'done' });
  tracer.send(); // non-blocking

  console.log('LLM summary:', summary);
}

main().catch(err => {
  console.error('App error:', err);
});

```

## API

### `new WatchlogTracer(config)`

- **`config.app`** _(_string_, **required**)_ — Your application name.
- **`config.endpoint`** _(_string_)_ — URL of the Watchlog agent (default: auto-detected per environment).
- **`config.batchSize`** _(_number_)_ — Number of spans per HTTP batch (default: `50`).
- **`config.autoFlushInterval`** _(_number_)_ — Milliseconds between automatic queue flushes (default: `1000`).
- **`config.maxQueueSize`** _(_number_)_ — Maximum spans stored on disk before rotation (default: `10000`).
- **`config.queueItemTTL`** _(_number_)_ — Time‑to‑live for queued spans in ms (default: `600000`).
- **`config.maxRetries`** _(_number_)_ — HTTP retry attempts (default: `3`).
- **`config.requestTimeout`** _(_number_)_ — Axios request timeout in ms (default: `5000`).
- **`config.sensitiveFields`** _(_string[]_)_ — Field keys to strip from trace data.

### Tracing Methods

- **`startTrace()`** → _`traceId`_  
  Begins a new trace. Returns the generated `traceId`.

- **`startSpan(name, metadata)`** → _`spanId`_  
  Creates a span under the current `traceId`.

- **`childSpan(parentSpanId, name, metadata)`** → _`spanId`_  
  Alias for `startSpan` with a `parentId`.

- **`endSpan(spanId, data)`**  
  Marks a span as complete, recording timestamps, duration, tokens, cost, etc.

- **`send()`**  
  Enqueues all pending spans to disk immediately.

## Kubernetes Endpoint Detection

When running inside Kubernetes, the tracer auto-detects via ServiceAccount tokens, cgroup info, or DNS lookup and switches `endpoint`:
- **K8s:** `http://watchlog-node-agent.monitoring.svc.cluster.local:3774`
- **Local:** `http://127.0.0.1:3774`

## Running Tests

Use the provided `test.js` script under root:

```bash
node test.js
```

## Contributing

PRs and issues welcome — please read our [contributing guidelines](https://github.com/Watchlog-monitoring/-watchlog-node-ai-tracer/blob/main/CONTRIBUTING.md).

## License

MIT © Watchlog Monitoring
