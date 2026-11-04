// Phase budget ledger and guarded model fetch for acceptance runs (#11).
// The guard wraps the fetcher handed to PiAgentAdapter, so every /api/model request made by an
// agent turn (first answer, tool follow-ups, quiz repairs, retries) is reserved before it is sent.
// Production agent scheduling and the server's daily budget are untouched.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type RequestStatus = 'settled' | 'rejected' | 'unknown_usage' | 'unsettled';
export type CaseOutcome = 'passed' | 'failed' | 'budget_stopped' | 'interrupted' | 'blocked' | 'error';
export type StopReason = 'completed' | 'budget_exhausted' | 'daily_quota' | 'preflight_failed' | 'interrupted' | 'error';
export type LedgerRecord =
  | { kind: 'phase'; phase: string; limit: number; at: string }
  | { kind: 'run'; runId: string; at: string }
  | { kind: 'reserve'; runId: string; caseId: string; requestId: string; sessionId: string; turnId: string; reserved: number; inputBound: number; outputBound: number; at: string }
  | { kind: 'settle'; requestId: string; status: Exclude<RequestStatus, 'unsettled'>; input?: number; output?: number; charged: number; note?: string; at: string }
  | { kind: 'case'; runId: string; caseId: string; outcome: CaseOutcome; failure?: string; at: string }
  | { kind: 'stop'; runId: string; reason: StopReason; detail?: string; at: string };
export type RequestRow = { requestId: string; runId: string; caseId: string; sessionId: string; turnId: string; reserved: number; inputBound: number; outputBound: number; status: RequestStatus; input?: number; output?: number; charged: number; note?: string };

// Conservative upper bounds. DeepSeek uses byte-level BPE, so prompt tokens never exceed the UTF-8
// bytes of the request body; 512 covers chat-template/tool-schema framing. Output is capped by the
// server's max_tokens (session.limits.maxOutputTokens).
export const TEMPLATE_OVERHEAD = 512;
export function reservationFor(bodyBytes: number, maxOutputTokens: number) {
  const inputBound = bodyBytes + TEMPLATE_OVERHEAD, outputBound = maxOutputTokens;
  return { inputBound, outputBound, reserved: inputBound + outputBound };
}
// Mirrors server/model.go: len(providerBody) + 4096 + maxOutput, plus slack for field differences.
export const serverReservationFor = (bodyBytes: number, maxOutputTokens: number) => bodyBytes + 4096 + 256 + maxOutputTokens;

export class BudgetLedger {
  readonly path: string; readonly phase: string; readonly limit: number;
  readonly records: LedgerRecord[];
  constructor(path: string, phase: string, limit: number, records: LedgerRecord[]) { this.path = path; this.phase = phase; this.limit = limit; this.records = records; }
  append(record: LedgerRecord) {
    // Durable before the request leaves: a hard kill still leaves the reservation on disk.
    const fd = openSync(this.path, 'a');
    try { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.records.push(record);
  }
  requests(): RequestRow[] {
    const rows = new Map<string, RequestRow>();
    for (const r of this.records) {
      if (r.kind === 'reserve') rows.set(r.requestId, { requestId: r.requestId, runId: r.runId, caseId: r.caseId, sessionId: r.sessionId, turnId: r.turnId, reserved: r.reserved, inputBound: r.inputBound, outputBound: r.outputBound, status: 'unsettled', charged: r.reserved, note: '没有结算记录（进程中断），保留保守预留' });
      if (r.kind === 'settle') { const row = rows.get(r.requestId); if (row) Object.assign(row, { status: r.status, input: r.input, output: r.output, charged: r.charged, note: r.note }); }
    }
    return [...rows.values()];
  }
  used() { return this.requests().reduce((n, r) => n + r.charged, 0); }
  remaining() { return this.limit - this.used(); }
  runs() { return this.records.filter(r => r.kind === 'run').map(r => r.runId); }
  lastOutcomes() {
    const out = new Map<string, CaseOutcome>();
    for (const r of this.records) if (r.kind === 'case') out.set(r.caseId, r.outcome);
    return out;
  }
  totals() {
    const rows = this.requests();
    const sum = (s: RequestStatus[]) => rows.filter(r => s.includes(r.status)).reduce((n, r) => n + r.charged, 0);
    return { limit: this.limit, used: this.used(), remaining: this.remaining(), requests: rows.length, settled: sum(['settled', 'rejected']), conservativelyHeld: sum(['unknown_usage', 'unsettled']) };
  }
}

export function openBudgetLedger(path: string, phase: { phase: string; limit: number }): BudgetLedger {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const ledger = new BudgetLedger(path, phase.phase, phase.limit, []);
    ledger.append({ kind: 'phase', phase: phase.phase, limit: phase.limit, at: new Date().toISOString() });
    return ledger;
  }
  const records = readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as LedgerRecord);
  const head = records[0];
  if (head?.kind !== 'phase') throw new Error('账本缺少阶段头：' + path);
  // Never silently reset or re-scope consumed budget.
  if (head.phase !== phase.phase || head.limit !== phase.limit) throw new Error(`账本属于阶段 ${head.phase}（额度 ${head.limit}），与本次 ${phase.phase}（额度 ${phase.limit}）不一致`);
  return new BudgetLedger(path, head.phase, head.limit, records);
}

export type BudgetStop = { reason: 'budget_exhausted' | 'daily_quota'; detail: string };
export type GuardOptions = {
  runId: string; maxOutputTokens: number;
  caseId: () => string;
  daily?: { remaining: number };
  onStop: (stop: BudgetStop) => void;
};
export const BUDGET_STOP_CODE = 'ACCEPTANCE_BUDGET_STOP';

function trustedUsage(e: any): { input: number; output: number } | undefined {
  const u = e?.usage;
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 0;
  return e?.type === 'usage' && ok(u?.input) && ok(u?.output) && u.total === u.input + u.output ? { input: u.input, output: u.output } : undefined;
}

export function guardModelFetch(upstream: typeof fetch, ledger: BudgetLedger, o: GuardOptions): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) !== '/api/model') return upstream(url, init);
    const text = typeof init?.body === 'string' ? init.body : '';
    const body = JSON.parse(text || '{}');
    const bytes = Buffer.byteLength(text, 'utf8');
    const bound = reservationFor(bytes, o.maxOutputTokens);
    const refuse = (stop: BudgetStop) => { o.onStop(stop); return Response.json({ error: { code: BUDGET_STOP_CODE, message: stop.detail } }, { status: 429 }); };
    const remaining = ledger.remaining();
    if (bound.reserved > remaining) return refuse({ reason: 'budget_exhausted', detail: `阶段剩余 ${remaining} token，不足以覆盖下一次请求预留 ${bound.reserved}` });
    const server = serverReservationFor(bytes, o.maxOutputTokens);
    if (o.daily && server > o.daily.remaining) return refuse({ reason: 'daily_quota', detail: `服务端当日剩余约 ${o.daily.remaining}，不足以覆盖服务端预留 ${server}` });
    const requestId = String(body.requestId);
    ledger.append({ kind: 'reserve', runId: o.runId, caseId: o.caseId(), requestId, sessionId: String(body.sessionId), turnId: String(body.turnId), ...bound, at: new Date().toISOString() });
    let closed = false;
    const settle = (status: 'settled' | 'rejected' | 'unknown_usage', usage?: { input: number; output: number }, note?: string) => {
      if (closed) return; closed = true;
      const charged = status === 'rejected' ? 0 : usage ? usage.input + usage.output : bound.reserved;
      if (usage && charged > bound.reserved) note = `实际用量 ${charged} 超过预留 ${bound.reserved}`;
      ledger.append({ kind: 'settle', requestId, status, ...(usage ?? {}), charged, ...(note ? { note } : {}), at: new Date().toISOString() });
      if (o.daily) o.daily.remaining -= status === 'unknown_usage' ? server : charged;
    };
    let response: Response;
    try { response = await upstream(url, init); }
    catch (error) { settle('unknown_usage', undefined, '请求发出后未收到响应（' + (error instanceof Error ? error.name : '失败') + '），保留保守预留'); throw error; }
    if (!response.ok) {
      // Our server answers 4xx only before reserving or on explicit upstream rejection (no completion).
      // 5xx may hide an upstream call that consumed tokens.
      if (response.status >= 400 && response.status < 500) settle('rejected', undefined, 'HTTP ' + response.status + '，服务端未产生模型用量');
      else settle('unknown_usage', undefined, 'HTTP ' + response.status + '，无法确认上游用量，保留保守预留');
      return response;
    }
    if (!response.body) { settle('unknown_usage', undefined, '空响应流，保留保守预留'); return response; }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '', usage: { input: number; output: number } | undefined;
    const scan = (chunk: string) => {
      pending += chunk;
      let i: number;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim(); pending = pending.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        try { usage = trustedUsage(JSON.parse(line.slice(5).trim())) ?? usage; } catch { /* protocol errors are the agent's concern */ }
      }
    };
    const end = (why: string) => usage ? settle('settled', usage) : settle('unknown_usage', undefined, why + '，未收到可信用量，保留保守预留');
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { scan(decoder.decode() + '\n'); end('流结束'); controller.close(); return; }
          scan(decoder.decode(value, { stream: true })); controller.enqueue(value);
        } catch (error) { end('流中断'); controller.error(error); }
      },
      cancel(reason) { end('流被取消'); return reader.cancel(reason); },
    });
    return new Response(stream, { status: response.status, headers: response.headers });
  }) as typeof fetch;
}
