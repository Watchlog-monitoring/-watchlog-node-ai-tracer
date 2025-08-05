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
// index.js
const WatchlogTracer = require('@watchlog/ai-tracer');

const tracer = new WatchlogTracer({
  app: 'your-app-name',                // 🆔 Application name (required)
  endpoint: 'http://localhost:3774',   // 🔗 Agent endpoint (optional)
  batchSize: 50,                       // 🔄 Spans per batch
  autoFlushInterval: 1000,             // ⏲ Flush queue every 1s
  maxQueueSize: 10000,                 // 📥 Max queued spans
  queueItemTTL: 10 * 60 * 1000,        // ⌛ Span TTL in ms (default: 10m)
  /* ... other config options (see below) ... */
});

// Simulated async sleep
function sleep(sec) {
  return new Promise(resolve => setTimeout(resolve, sec * 1000));
}

async function main() {
  // Start a new trace (optional)
  tracer.startTrace();

  // Root span
  const root = tracer.startSpan('handle-request', { feature: 'ai-summary' });
  await sleep(1);

  // Child span
  const llm = tracer.childSpan(root, 'call-llm');
  await sleep(0.5);
  tracer.endSpan(llm, {
    tokens:   42,
    cost:     0.0012,
    model:    'gpt-4',
    provider: 'openai',
    input:    'Summarize: Hello world...',
    output:   'Hello world summary.'
  });

  // End root span
  tracer.endSpan(root);

  // Ensure spans are flushed to disk and send
  await sleep(1);
  tracer.send();
}

main();
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
