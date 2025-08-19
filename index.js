/**
 * WatchlogTracer — High-rate, crash-safe tracer for Watchlog AI monitoring
 * - Append-only enqueue under file lock (micro-batched)  ➜ حداقل رقابت لاک
 * - Safe flush: read+truncate under lock, HTTP send outside lock
 * - TTL و rotation در flush (نه enqueue)
 * - تحمل ENOENT و صفر شدن unhandled rejection
 * - backoff برای لاک و HTTP
 * - deep redact فیلدهای حساس
 * - Exit hooks خودکار: beforeExit (flush با timeout)، SIGINT/SIGTERM (send + destroy)
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

async function isRunningInK8s() {
  if (fs.existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token")) return true;
  try { if (fs.readFileSync("/proc/1/cgroup", "utf8").includes("kubepods")) return true; } catch {}
  try { await lookup("kubernetes.default.svc.cluster.local"); return true; } catch { return false; }
}

let _cachedURL = null;
async function getAgentURL(override) {
  if (override) return override;
  if (_cachedURL) return _cachedURL;
  _cachedURL = (await isRunningInK8s())
    ? "http://watchlog-node-agent.monitoring.svc.cluster.local:3774"
    : "http://127.0.0.1:3774";
  return _cachedURL;
}

async function ensureQueueFile(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try { await fs.promises.access(filePath, fs.constants.FOK); }
  catch { await fs.promises.writeFile(filePath, "", "utf8"); }
}
fs.constants.FOK = fs.constants.F_OK; // تسهیل استفاده بالا

async function safeReadFile(filePath, enc = "utf8") {
  try { return await fs.promises.readFile(filePath, enc); }
  catch (e) { if (e && e.code === "ENOENT") return ""; throw e; }
}

function deepRedact(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => deepRedact(v, keys));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) continue;
    out[k] = typeof v === "object" ? deepRedact(v, keys) : v;
  }
  return out;
}

/**
 * @typedef {Object} TracerConfig
 * @property {string} app
 * @property {string} [agentURL]
 * @property {number} [batchSize=400]
 * @property {number} [flushOnSpanCount=400]
 * @property {number} [maxRetries=3]
 * @property {number} [maxQueueSize=200000]
 * @property {number} [maxFieldLength=256]
 * @property {string[]} [sensitiveFields]
 * @property {number} [autoFlushInterval=2000]
 * @property {number} [maxInMemorySpans=20000]
 * @property {number} [requestTimeout=8000]
 * @property {number} [queueItemTTL=600000]
 * @property {number} [statusTimeoutMs=10000]
 * @property {number} [enqueueCoalesceMs=20]
 * @property {number} [maxPendingBuffer=10000]
 * @property {boolean} [autoInstallExitHooks=true]  // نصب خودکار هوک‌ها
 * @property {boolean} [handleSignals=true]         // SIGINT/SIGTERM
 * @property {boolean} [handleBeforeExit=true]      // beforeExit
 * @property {number}  [exitHookTimeoutMs=1500]     // سقف انتظار برای flush در beforeExit
 */
const DEFAULT_CONFIG = {
  app: "",
  agentURL: null,
  batchSize: 400,
  flushOnSpanCount: 400,
  maxRetries: 3,
  maxQueueSize: 200000,
  maxFieldLength: 256,
  sensitiveFields: ["password", "api_key", "token", "authorization", "secret"],
  autoFlushInterval: 2000,
  maxInMemorySpans: 20000,
  requestTimeout: 8000,
  queueItemTTL: 10 * 60 * 1000,
  statusTimeoutMs: 10000,
  enqueueCoalesceMs: 20,
  maxPendingBuffer: 10000,
  autoInstallExitHooks: true,
  handleSignals: true,
  handleBeforeExit: true,
  exitHookTimeoutMs: 1500,
};

// مجموعه‌ی همه‌ی اینستنس‌ها برای بستن خودکار
const _instances = new Set();
let _hooksInstalled = false;
let _closingAll = false; // جلوگیری از re-entry در سیگنال‌ها

class WatchlogTracer {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (!this.config.app || !this.config.app.trim()) {
      throw new Error("WatchlogTracer: required `app` option missing or empty");
    }

    this.queueFile = path.join(os.tmpdir(), `watchlog-queue-${this.config.app}.jsonl`);
    this.traceId = null;
    this.activeSpans = [];
    this.completedSpans = [];

    this._lockOpts = {
      retries: { retries: 8, factor: 1.6, minTimeout: 25, maxTimeout: 400, randomize: true },
      stale: 30_000,
      realpath: false,
      onCompromised: (err) => console.error("lock compromised:", err && err.message),
    };

    this._enqueueBuffer = [];
    this._enqueueScheduled = false;
    this._enqueueBackoffMs = 25;

    this._flushing = false;

    if (this.config.autoFlushInterval > 0) {
      this._timer = setInterval(() => {
        this.flushQueue().catch((err) => console.error("flush error:", err && err.message));
      }, this.config.autoFlushInterval);
    }

    _instances.add(this);

    if (this.config.autoInstallExitHooks !== false && process.env.WATCHLOG_EXIT_HOOKS !== "0") {
      WatchlogTracer._installGlobalExitHooks({
        handleSignals: this.config.handleSignals,
        handleBeforeExit: this.config.handleBeforeExit,
        exitHookTimeoutMs: this.config.exitHookTimeoutMs,
      });
    }
  }

  destroy() {
    if (this._timer) clearInterval(this._timer);
    _instances.delete(this);
  }

  // ————— API: tracing —————
  startTrace() {
    this.traceId = `trace-${uuidv4()}`;
    return this.traceId;
  }

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

    if (this.completedSpans.length > this.config.maxInMemorySpans) {
      const overflow = this.completedSpans.splice(
        0,
        this.completedSpans.length - this.config.maxInMemorySpans
      );
      this._enqueue(overflow);
    }
    return spanId;
  }

  childSpan(parentSpanId, name, metadata = {}) {
    return this.startSpan(name, { ...metadata, parentId: parentSpanId });
  }

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

    const sanitizeValue = (value) => {
      let serialized;
      if (value && typeof value === "object") {
        const red = deepRedact(value, this.config.sensitiveFields || []);
        serialized = JSON.stringify(red);
      } else {
        serialized = JSON.stringify(value || "");
      }
      if (serialized.length > this.config.maxFieldLength) {
        serialized = serialized.slice(0, this.config.maxFieldLength) + "...[TRUNCATED]";
      }
      return serialized;
    };

    span.input = sanitizeValue(data.input);
    span.output = sanitizeValue(data.output);

    span.status = this._determineStatus(span);

    this.completedSpans.push(span);

    if (this.completedSpans.length >= this.config.flushOnSpanCount) {
      const batch = this.completedSpans.splice(0, this.config.flushOnSpanCount);
      this._enqueue(batch);
    }
  }

  send() {
    while (this.activeSpans.length) {
      this.endSpan(this.activeSpans[0].spanId);
    }
    if (this.completedSpans.length) {
      const all = this.completedSpans.splice(0, this.completedSpans.length);
      this._enqueue(all);
      // flushQueue به‌صورت پس‌زمینه هم طبق autoFlushInterval انجام می‌شود
    }
  }

  // ————— enqueue (append-only + micro-batch) —————
  _enqueue(spans) {
    if (!Array.isArray(spans) || spans.length === 0) return;
    this._enqueueBuffer.push(...spans);
    if (this._enqueueBuffer.length > this.config.maxPendingBuffer) {
      this._flushEnqueueBuffer().catch((err) => this._handleEnqueueError(err, spans.length));
      return;
    }
    if (!this._enqueueScheduled) {
      this._enqueueScheduled = true;
      setTimeout(() => {
        this._flushEnqueueBuffer().catch((err) => this._handleEnqueueError(err, this._enqueueBuffer.length));
      }, this.config.enqueueCoalesceMs);
    }
  }

  _handleEnqueueError(err, count) {
    const msg = (err && err.message) || String(err);
    if (/already being held|ELOCKED/i.test(msg)) {
      const delay = Math.min(500, this._enqueueBackoffMs);
      setTimeout(() => {
        this._flushEnqueueBuffer().catch((e) => this._handleEnqueueError(e, count));
      }, delay);
      this._enqueueBackoffMs = Math.min(500, Math.floor(this._enqueueBackoffMs * 1.6));
      return;
    }
    console.error(`enqueue error (${count}):`, msg);
  }

  async _flushEnqueueBuffer() {
    if (!this._enqueueScheduled && this._enqueueBuffer.length === 0) return;
    this._enqueueScheduled = false;

    const batch = this._enqueueBuffer.splice(0, this._enqueueBuffer.length);
    if (batch.length === 0) return;

    this._enqueueBackoffMs = 25;

    await this._withFileLock(async () => {
      const payload = batch.map((s) => JSON.stringify(s)).join("\n") + "\n";
      await fs.promises.appendFile(this.queueFile, payload, "utf8");
    });
  }

  async _withFileLock(fn) {
    await ensureQueueFile(this.queueFile);
    const release = await lockfile.lock(this.queueFile, this._lockOpts);
    try { return await fn(); }
    finally { try { await release(); } catch {} }
  }

  // ————— flush (read+truncate under lock, HTTP send outside) —————
  async flushQueue() {
    if (this._flushing) return;
    this._flushing = true;

    let toSend = [];
    try {
      await this._withFileLock(async () => {
        const content = await safeReadFile(this.queueFile, "utf8");
        if (!content) {
          await fs.promises.truncate(this.queueFile, 0);
          return;
        }
        const lines = content.split("\n").filter(Boolean);
        const now = Date.now();
        const ttl = this.config.queueItemTTL;
        const maxQ = this.config.maxQueueSize;

        let spans = [];
        for (const l of lines) {
          try {
            const s = JSON.parse(l);
            if (!ttl || now - Date.parse(s.startTime) <= ttl) spans.push(s);
          } catch { /* ignore bad line */ }
        }
        if (spans.length > maxQ) spans = spans.slice(-maxQ);

        toSend = spans;
        await fs.promises.truncate(this.queueFile, 0);
      });
    } catch {
      this._flushing = false;
      return;
    }

    if (!toSend.length) {
      this._flushing = false;
      return;
    }

    const base = await getAgentURL(this.config.agentURL);
    const url = `${base}/ai-tracer`;

    try {
      for (let i = 0; i < toSend.length; i += this.config.batchSize) {
        const chunk = toSend.slice(i, i + this.config.batchSize);
        await this._retryPost(url, chunk);
      }
    } catch (err) {
      try {
        const remaining = toSend; // برای اطمینان همه را برگردان
        await this._withFileLock(async () => {
          if (!remaining.length) return;
          const payload = remaining.map((s) => JSON.stringify(s)).join("\n") + "\n";
          await fs.promises.appendFile(this.queueFile, payload, "utf8");
        });
      } catch {}
      console.error("flush http error:", (err && err.message) || String(err));
    } finally {
      this._flushing = false;
    }
  }

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
        const backoff = Math.min(1000, Math.pow(2, i) * 100);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  _determineStatus(span) {
    if (!span.output || span.output === '""') return "Error";
    if (span.duration > this.config.statusTimeoutMs) return "Timeout";
    return "Success";
  }

  // ————— graceful close (برای استفاده‌ی دستی/داخلی) —————
  async close() {
    return this._closeWithTimeout(this.config.exitHookTimeoutMs, "manual");
  }

  async _closeWithTimeout(timeoutMs = 1500, reason = "unknown") {
    try {
      this.send(); // اسپن‌های باز را ببند و به دیسک برسان
      await Promise.race([
        this.flushQueue(),
        new Promise((res) => setTimeout(res, timeoutMs)),
      ]);
    } finally {
      this.destroy();
    }
  }

  // ————— static: نصب هوک‌های خروج —————
  static _installGlobalExitHooks(opts) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;

    const { handleSignals = true, handleBeforeExit = true, exitHookTimeoutMs = 1500 } = opts || {};

    // 1) beforeExit: فرصت برای flush شبکه (با timeout)
    if (handleBeforeExit) {
      process.once("beforeExit", async () => {
        if (_closingAll) return;
        _closingAll = true;
        try {
          const tasks = [];
          for (const inst of _instances) {
            tasks.push(inst._closeWithTimeout(exitHookTimeoutMs, "beforeExit"));
          }
          await Promise.allSettled(tasks);
        } finally {
          _closingAll = false;
        }
      });
    }

    // 2) SIGINT/SIGTERM: فقط send()+destroy()، سپس اجازه‌ی خروج پیش‌فرض
    if (handleSignals) {
      const onSignal = (sig) => {
        return () => {
          if (_closingAll) return;
          _closingAll = true;
          try {
            for (const inst of _instances) {
              try {
                inst.send();     // دیسک تضمین شود
                inst.destroy();  // تایمرها بسته شوند
              } catch {}
            }
          } finally {
            // اجازه ده رفتار پیش‌فرض Node اجرا شود
            setImmediate(() => {
              try { process.kill(process.pid, sig); } catch {}
            });
          }
        };
      };
      process.once("SIGINT", onSignal("SIGINT"));
      process.once("SIGTERM", onSignal("SIGTERM"));
    }

    // توجه: عمداً روی 'uncaughtException'/'unhandledRejection' هندلر نصب نمی‌کنیم
    // تا رفتار پیش‌فرض Node مختل نشود. (در صورت نیاز می‌توان با گزینه‌ها اضافه کرد.)
  }
}

module.exports = WatchlogTracer;
