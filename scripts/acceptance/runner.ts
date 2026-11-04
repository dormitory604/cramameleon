// Budgeted acceptance runner (#11). Drives real PiAgentAdapter turns through a guarded fetcher,
// persists every reservation/settlement to the phase ledger and always writes a report.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PiAgentAdapter } from '../../src/agent/PiAgentAdapter.ts';
import type { AgentEvent, AgentInput, AgentRunner, AppSession } from '../../src/contracts/index.ts';
import { guardModelFetch, openBudgetLedger, reservationFor, serverReservationFor } from './budget.ts';
import type { BudgetLedger, BudgetStop, CaseOutcome, RequestRow, StopReason } from './budget.ts';

export type TurnRow = { input: string; output: string; tools: string[]; state: any; quiz?: any; sources: any[]; usage: number; requestIds: string[]; terminal?: AgentEvent; errors: AgentEvent[] };
export type Turn = { row: TurnRow; input: AgentInput };
export type CaseContext = {
  turn(text: string, options?: Partial<AgentInput>): Promise<Turn>;
  /** Result of an earlier case in this run (declared in `after`). */
  result(caseId: string): Turn;
};
export type AcceptanceCase = { id: string; after?: string[]; run(ctx: CaseContext): Promise<Turn | void> };
export type CaseReport = { id: string; outcome: CaseOutcome; failure?: string; turns: TurnRow[]; tokens: number };
export type AcceptanceReport = {
  phase: string; ledgerPath: string; runId: string; startedAt: string; finishedAt?: string;
  stopReason: StopReason; stopDetail?: string;
  preflight?: { health: boolean; modelReady?: boolean; model?: string; maxOutputTokens?: number; daily?: { day: string; limit: number; used: number; remaining: number } };
  totals: { limit: number; used: number; remaining: number; requests: number; settled: number; conservativelyHeld: number };
  thisRun: { used: number; requests: number };
  previousRuns: string[];
  requests: RequestRow[];
  cases: CaseReport[];
  skipped: string[]; notRun: string[];
};
export type RunOptions = {
  ledgerPath: string; reportPath: string; phase: string; limit: number;
  /** Authenticated fetcher for /api/health, /api/session and /api/model (cookie already applied). */
  fetcher: typeof fetch;
  cases: AcceptanceCase[];
  only?: string[]; skipCompleted?: boolean;
  signal?: AbortSignal;
  createAgent?: (session: AppSession, fetcher: typeof fetch) => AgentRunner;
  log?: (line: string) => void;
};

class Stopped extends Error {}

export async function runAcceptance(o: RunOptions): Promise<AcceptanceReport> {
  const log = o.log ?? (() => undefined);
  const runId = 'run-' + new Date().toISOString().replace(/[:.]/g, '') + '-' + crypto.randomUUID().slice(0, 8);
  const report: AcceptanceReport = { phase: o.phase, ledgerPath: o.ledgerPath, runId, startedAt: new Date().toISOString(), stopReason: 'error', totals: { limit: o.limit, used: 0, remaining: o.limit, requests: 0, settled: 0, conservativelyHeld: 0 }, thisRun: { used: 0, requests: 0 }, previousRuns: [], requests: [], cases: [], skipped: [], notRun: [] };
  let ledger: BudgetLedger | undefined;
  let stop: { reason: StopReason; detail?: string } | undefined;
  let plan = o.cases;
  try {
    plan = planCases(o.cases, o.only);
    ledger = openBudgetLedger(o.ledgerPath, { phase: o.phase, limit: o.limit });
    report.previousRuns = ledger.runs();
    ledger.append({ kind: 'run', runId, at: report.startedAt });
    const done = ledger.lastOutcomes();
    let selected = plan;
    if (o.skipCompleted) {
      const need = new Set(plan.filter(c => done.get(c.id) !== 'passed').map(c => c.id));
      // Dependencies of a case that still runs must run again in this run (their output feeds it).
      for (const c of [...plan].reverse()) if (need.has(c.id)) for (const d of c.after ?? []) need.add(d);
      selected = plan.filter(c => need.has(c.id));
      report.skipped = plan.filter(c => !need.has(c.id)).map(c => c.id);
    }

    // Preflight: service, application session and daily quota before any model request.
    const health = await o.fetcher('/api/health').then(r => r.ok, () => false);
    report.preflight = { health };
    if (!health) throw new Stopped('服务健康检查失败');
    const res = await o.fetcher('/api/session');
    if (!res.ok) throw new Stopped('应用会话无效（HTTP ' + res.status + '）');
    const session = await res.json() as AppSession;
    const daily = { day: session.budget.day, limit: session.budget.limit, used: session.budget.used, remaining: session.budget.limit - session.budget.used };
    Object.assign(report.preflight, { modelReady: session.modelReady, model: session.model, maxOutputTokens: session.limits.maxOutputTokens, daily });
    if (!session.modelReady) throw new Stopped('服务器尚未配置真实模型');
    const maxOut = session.limits.maxOutputTokens;
    if (daily.remaining < serverReservationFor(0, maxOut)) { stop = { reason: 'daily_quota', detail: `服务端当日剩余 ${daily.remaining}，不足以发起任何请求` }; }
    else if (ledger.remaining() < reservationFor(0, maxOut).reserved) { stop = { reason: 'budget_exhausted', detail: `阶段剩余 ${ledger.remaining()} token，不足以发起任何请求` }; }

    let current = '';
    const guardStop: { value?: BudgetStop } = {};
    const fetcher = guardModelFetch(o.fetcher, ledger, { runId, maxOutputTokens: maxOut, caseId: () => current, daily: { remaining: daily.remaining }, onStop: s => { guardStop.value = s; } });
    const agent = (o.createAgent ?? ((s, f) => new PiAgentAdapter(s, f)))(session, fetcher);
    const results = new Map<string, Turn>();
    const outcomes = new Map<string, CaseOutcome>();
    for (const c of selected) {
      if (stop || o.signal?.aborted) { report.notRun.push(c.id); continue; }
      current = c.id;
      const entry: CaseReport = { id: c.id, outcome: 'error', turns: [], tokens: 0 };
      report.cases.push(entry);
      let lastTurn: Turn | undefined;
      const blocked = (c.after ?? []).find(d => outcomes.get(d) !== 'passed');
      try {
        if (blocked) { entry.outcome = 'blocked'; entry.failure = '前置用例 ' + blocked + ' 未通过'; }
        else {
          const ctx: CaseContext = {
            turn: async (text, options = {}) => {
              const turn = await runTurn(agent, text, options, o.signal);
              turn.row.requestIds = ledger!.requests().filter(r => r.turnId === turn.input.turnId).map(r => r.requestId);
              entry.turns.push(turn.row); lastTurn = turn;
              if (turn.row.errors.length) throw new Error(JSON.stringify(turn.row.errors));
              if (!['completed', 'waiting'].includes((turn.row.terminal as any)?.status)) throw new Error('终态 ' + JSON.stringify(turn.row.terminal));
              return turn;
            },
            result: id => { const r = results.get(id); if (!r) throw new Error('缺少前置用例结果 ' + id); return r; },
          };
          const last = await c.run(ctx);
          const kept = last ?? lastTurn; if (kept) results.set(c.id, kept);
          entry.outcome = 'passed';
        }
      } catch (error) {
        entry.failure = error instanceof Error ? error.message : String(error);
        entry.outcome = guardStop.value ? 'budget_stopped' : o.signal?.aborted ? 'interrupted' : 'failed';
      }
      const ids = new Set(entry.turns.flatMap(t => t.requestIds));
      entry.tokens = ledger.requests().filter(r => ids.has(r.requestId)).reduce((n, r) => n + r.charged, 0);
      outcomes.set(c.id, entry.outcome);
      ledger.append({ kind: 'case', runId, caseId: c.id, outcome: entry.outcome, ...(entry.failure ? { failure: entry.failure.slice(0, 500) } : {}), at: new Date().toISOString() });
      log(`${entry.outcome.toUpperCase()} ${c.id} tokens=${entry.tokens} phaseUsed=${ledger.used()}/${ledger.limit}`);
      if (guardStop.value) stop = guardStop.value;
      else if (o.signal?.aborted) stop = { reason: 'interrupted', detail: '收到中断信号' };
    }
    stop ??= { reason: 'completed' };
  } catch (error) {
    if (error instanceof Stopped) stop = { reason: 'preflight_failed', detail: error.message };
    else stop = { reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    const ran = new Set([...report.cases.map(c => c.id), ...report.notRun, ...report.skipped]);
    for (const c of plan) if (!ran.has(c.id)) report.notRun.push(c.id);
    report.stopReason = stop?.reason ?? 'error'; report.stopDetail = stop?.detail;
    if (ledger) {
      try { ledger.append({ kind: 'stop', runId, reason: report.stopReason, ...(stop?.detail ? { detail: stop.detail } : {}), at: new Date().toISOString() }); } catch { /* report still written */ }
      report.totals = ledger.totals();
      report.requests = ledger.requests();
      const mine = report.requests.filter(r => r.runId === runId);
      report.thisRun = { used: mine.reduce((n, r) => n + r.charged, 0), requests: mine.length };
    }
    report.finishedAt = new Date().toISOString();
    await mkdir(dirname(o.reportPath), { recursive: true });
    await writeFile(o.reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

function planCases(cases: AcceptanceCase[], only?: string[]) {
  if (!only?.length) return cases;
  const unknown = only.filter(id => !cases.some(c => c.id === id));
  if (unknown.length) throw new Error('未知用例：' + unknown.join(','));
  const need = new Set(only);
  for (const c of [...cases].reverse()) if (need.has(c.id)) for (const d of c.after ?? []) need.add(d);
  return cases.filter(c => need.has(c.id));
}

async function runTurn(agent: AgentRunner, text: string, options: Partial<AgentInput>, outer?: AbortSignal): Promise<Turn> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outer?.addEventListener('abort', abort, { once: true });
  if (outer?.aborted) controller.abort();
  const input: AgentInput = { sessionId: 'teaching-' + crypto.randomUUID(), turnId: crypto.randomUUID(), action: { type: 'send', text }, history: [], state: { preferences: '回答简短', progress: '' }, documents: [], ...options, signal: controller.signal };
  try {
    const events = await Array.fromAsync(agent.run(input));
    const stateEvent = events.find(e => e.type === 'state_update');
    const row: TurnRow = {
      input: text,
      output: events.filter(e => e.type === 'text_delta').map(e => (e as any).delta).join(''),
      tools: events.filter(e => e.type === 'tool_status' && e.category === 'tool' && e.status === 'started').map(e => (e as any).message),
      state: stateEvent?.type === 'state_update' ? stateEvent.state : input.state,
      quiz: events.find(e => e.type === 'quiz_ready'),
      sources: events.filter(e => e.type === 'sources_ready'),
      usage: events.filter(e => e.type === 'usage').reduce((n, e) => n + (e.type === 'usage' ? e.usage.total : 0), 0),
      requestIds: [], terminal: events.at(-1), errors: events.filter(e => e.type === 'error'),
    };
    return { row, input };
  } finally { outer?.removeEventListener('abort', abort); }
}
