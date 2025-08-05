/**
 * @typedef {Object} TracerConfig
 * @property {string} app                   - Application name (required)
 * @property {string} [agentURL]           - Override agent URL (optional)
 * @property {number} [batchSize=50]       - Spans per HTTP batch
 * @property {number} [flushOnSpanCount=50]- Completed spans to auto-enqueue
 * @property {number} [maxRetries=3]       - HTTP retry attempts
 * @property {number} [maxQueueSize=10000] - Max spans in queue before rotation
 * @property {number} [maxFieldLength=256] - Max length of serialized fields
 * @property {string[]} [sensitiveFields]  - Fields to redact
 * @property {number} [autoFlushInterval=1000] - ms between background flushes
 * @property {number} [maxInMemorySpans=5000]   - Keep this many completed in RAM
 * @property {number} [requestTimeout=5000]     - Axios timeout (ms)
 * @property {number} [queueItemTTL=600000]     - TTL (ms) for queued spans
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");
const axios = require("axios");
const lockfile = require("proper-lockfile");
const { v4: uuidv4 } = require("uuid");

const lookup = promisify(dns.lookup);

/** Detect Kubernetes environment by ServiceAccount token, cgroup, or DNS */
async function isRunningInK8s() {
  if (fs.existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token"))
    return true;
  try {
    if (fs.readFileSync("/proc/1/cgroup", "utf8").includes("kubepods"))
      return true;
  } catch {}
  try {
    await lookup("kubernetes.default.svc.cluster.local");
    return true;
  } catch {
    return false;
  }
}

let _cachedURL = null;
/** Resolve agent URL: override or Kubernetes vs localhost */
async function getAgentURL(override) {
  if (override) return override;
  if (_cachedURL) return _cachedURL;
  _cachedURL = (await isRunningInK8s())
    ? "http://watchlog-node-agent.monitoring.svc.cluster.local:3774"
    : "http://127.0.0.1:3774";
  return _cachedURL;
}

/** @type {TracerConfig} */
const DEFAULT_CONFIG = {
  app: "",
  agentURL: null,
  batchSize: 50,
  flushOnSpanCount: 50,
  maxRetries: 3,
  maxQueueSize: 10000,
  maxFieldLength: 256,
  sensitiveFields: ["password", "api_key", "token"],
  autoFlushInterval: 1000,
  maxInMemorySpans: 5000,
  requestTimeout: 5000,
  queueItemTTL: 10 * 60 * 1000,
};

class WatchlogTracer {
  /**
   * @param {TracerConfig} config
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.app || !this.config.app.trim()) {
      throw new Error("WatchlogTracer: required `app` option missing or empty");
    }
    this.queueFile = path.join(
      os.tmpdir(),
      `watchlog-queue-${this.config.app}.jsonl`
    );
    this.traceId = null;
    this.activeSpans = [];
    this.completedSpans = [];

    if (this.config.autoFlushInterval > 0) {
      this._timer = setInterval(
        () =>
          this.flushQueue().catch((err) =>
            console.error("flush error:", err.message)
          ),
        this.config.autoFlushInterval
      );
    }
  }

  /** Start a new trace */
  startTrace() {
    this.traceId = `trace-${uuidv4()}`;
    return this.traceId;
  }

  /**
   * Start a new span under the current trace
   * @param {string} name
   * @param {object} [metadata]
   */
  startSpan(name, metadata = {}) {
    if (!this.traceId) this.startTrace();
    const spanId = `span-${uuidv4()}`;
    const span = {
      traceId: this.traceId,
      spanId,
      app: this.config.app,
      parentId: metadata.parentId || null,
      name,
      startTime: new Date().toISOString(),
      metadata: {
        feature: "",
        step: "",
        promptVersion: "",
        userId: "",
        label: "",
        ...metadata,
      },
    };
    this.activeSpans.push(span);

    // offload if memory too large
    if (this.completedSpans.length > this.config.maxInMemorySpans) {
      const overflow = this.completedSpans.splice(
        0,
        this.completedSpans.length - this.config.maxInMemorySpans
      );
      this._enqueue(overflow);
    }

    return spanId;
  }

  /** Shorthand to create a child span */
  childSpan(parentSpanId, name, metadata = {}) {
    return this.startSpan(name, { ...metadata, parentId: parentSpanId });
  }

  /**
   * End a span, record metrics and maybe enqueue
   * @param {string} spanId
   * @param {object} [data]
   */
  endSpan(spanId, data = {}) {
    const idx = this.activeSpans.findIndex((s) => s.spanId === spanId);
    if (idx < 0) return;
    const span = this.activeSpans.splice(idx, 1)[0];
    const now = new Date().toISOString();
    span.endTime = now;
    span.duration = Date.parse(now) - Date.parse(span.startTime);
    span.tokens = data.tokens || 0;
    span.cost = data.cost || 0;
    span.model = data.model || "";
    span.provider = data.provider || "";
    span.input = this._sanitize("input", data.input);
    span.output = this._sanitize("output", data.output);
    span.status = this._determineStatus(span);

    this.completedSpans.push(span);

    if (this.completedSpans.length >= this.config.flushOnSpanCount) {
      const batch = this.completedSpans.splice(0, this.config.flushOnSpanCount);
      this._enqueue(batch);
    }
  }

  /** Fire-and-forget: end all open, enqueue and immediately flush */
  send() {
    // close any open spans
    while (this.activeSpans.length) {
      this.endSpan(this.activeSpans[0].spanId);
    }
    if (this.completedSpans.length) {
      const all = this.completedSpans.splice(0, this.completedSpans.length);
      this._enqueue(all);
      // immediately attempt to flush over network
      this.flushQueue().catch((err) =>
        console.error("send flush error:", err.message)
      );
    }
  }

  /** @private enqueue spans to disk (with TTL purge & rotation) */
  _enqueue(spans) {
    (async () => {
      try {
        await lockfile.lock(this.queueFile);
      } catch {}
      try {
        // read existing
        let lines = [];
        if (fs.existsSync(this.queueFile)) {
          lines = (await fs.promises.readFile(this.queueFile, "utf8"))
            .split("\n")
            .filter(Boolean);
        }
        // purge expired
        const now = Date.now(),
          ttl = this.config.queueItemTTL;
        lines = lines.filter((l) => {
          try {
            const s = JSON.parse(l);
            return now - Date.parse(s.startTime) <= ttl;
          } catch {
            return false;
          }
        });
        // append new
        spans.forEach((s) => lines.push(JSON.stringify(s)));
        // rotate if too large
        if (lines.length > this.config.maxQueueSize) {
          await fs.promises.rename(this.queueFile, `${this.queueFile}.bak`);
          lines = lines.slice(-this.config.maxQueueSize);
        }
        await fs.promises.writeFile(
          this.queueFile,
          lines.join("\n") + "\n",
          "utf8"
        );
      } finally {
        try {
          await lockfile.unlock(this.queueFile);
        } catch {}
      }
    })();
  }

  /** @private send all queued spans over HTTP and clear file */
  async flushQueue() {
    if (!fs.existsSync(this.queueFile)) return;
    let release;
    try {
      release = await lockfile.lock(this.queueFile);
      const content = await fs.promises.readFile(this.queueFile, "utf8");
      const spans = content.split("\n").filter(Boolean).map(JSON.parse);
      if (spans.length) {
        // send in batches
        const base = await getAgentURL(this.config.agentURL);
        const url = `${base}/ai-tracer`;
        for (let i = 0; i < spans.length; i += this.config.batchSize) {
          const chunk = spans.slice(i, i + this.config.batchSize);
          await this._retryPost(url, chunk);
        }
      }
    } catch (err) {
      // console.error('Queue flush failed:', err.message);
    } finally {
      try {
        await fs.promises.unlink(this.queueFile);
      } catch {}
      try {
        if (release) await release();
      } catch {}
    }
  }

  /** @private HTTP POST with retries/backoff */
  async _retryPost(url, data) {
    let lastErr;
    for (let i = 0; i < this.config.maxRetries; i++) {
      try {
        await axios.post(url, data, {
          headers: { "Content-Type": "application/json" },
          timeout: this.config.requestTimeout,
        });
        return;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, Math.pow(2, i) * 100));
      }
    }
    throw lastErr;
  }

  /** @private determine status */
  _determineStatus(span) {
    if (!span.output) return "Error";
    if (span.duration > 10000) return "Timeout";
    return "Success";
  }

  /** @private redact & truncate */
  _sanitize(field, value) {
    const obj =
      value && typeof value === "object"
        ? { ...value }
        : { [field]: value || "" };
    this.config.sensitiveFields.forEach((k) => delete obj[k]);
    let str = JSON.stringify(obj[field] !== undefined ? obj[field] : value);
    if (str.length > this.config.maxFieldLength) {
      str = str.slice(0, this.config.maxFieldLength) + "...[TRUNCATED]";
    }
    return str;
  }
}

module.exports = WatchlogTracer;
