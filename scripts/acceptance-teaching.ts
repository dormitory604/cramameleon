// Budgeted live teaching acceptance. See scripts/acceptance/README.md.
// Explicit --live opt-in is required; --status never accesses the network.
import { parseArgs } from 'node:util';
import { openBudgetLedger } from './acceptance/budget.ts';
import { runAcceptance } from './acceptance/runner.ts';
import { teachingCases } from './acceptance/teachingCases.ts';

const { values: a } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, status: { type: 'boolean', default: false },
  // Keep the existing ledger identity so cleanup cannot silently reset past consumption.
  phase: { type: 'string', default: 'spec-4' }, limit: { type: 'string', default: '30000' },
  ledger: { type: 'string' }, report: { type: 'string' }, only: { type: 'string' },
  'skip-completed': { type: 'boolean', default: false },
  'base-url': { type: 'string', default: process.env.CRAMAMELEON_BASE_URL ?? 'http://127.0.0.1:18085' },
  origin: { type: 'string', default: process.env.CRAMAMELEON_PUBLIC_ORIGIN },
} });
const phase = a.phase!, limit = Number(a.limit);
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(phase)) throw new Error('--phase must be a simple ledger name');
if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
const ledgerPath = a.ledger ?? '.preflight/acceptance-budget/' + phase + '.jsonl';
const reportPath = a.report ?? '.preflight/teaching-acceptance-' + phase + '.json';

if (a.status) {
  const ledger = openBudgetLedger(ledgerPath, { phase, limit });
  console.log(JSON.stringify({ ledgerPath, ...ledger.totals(), runs: ledger.runs().length, lastOutcomes: Object.fromEntries(ledger.lastOutcomes()) }, null, 2));
  process.exit(0);
}
if (!a.live) throw new Error('Pass --live to opt into paid model calls (or --status to inspect the ledger)');

const base = new URL(a['base-url']!);
if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('--base-url must be an HTTP(S) origin');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
if (base.protocol !== 'https:' && !local) throw new Error('Remote acceptance endpoints require HTTPS');
const origin = a.origin ? new URL(a.origin) : base;
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('--origin must be an HTTP(S) origin');
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { console.error('中断：结束当前请求并写报告…'); controller.abort(); });
// Supply only the application cookie; never a model key or old-site credential.
let cookie = process.env.CRAMAMELEON_SESSION_COOKIE ?? '';
if (cookie && !/^cram_session=[^;\s]+$/.test(cookie)) throw new Error('CRAMAMELEON_SESSION_COOKIE must contain only cram_session=<value>');
let ownsSession = false;
async function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (cookie) headers.set('Cookie', cookie);
  if (init?.method && init.method !== 'GET') headers.set('Origin', origin.origin);
  return fetch(new URL(path, base), { ...init, headers, redirect: 'error', signal: init?.signal ?? controller.signal });
}
try {
  const probe = await request('/api/session');
  // Internal opt-in is a local/test-server convenience, never a fallback for old-site mode.
  if (!probe.ok && !cookie && process.env.APP_ACCESS_TOKEN) {
    const config = await request('/api/auth/config');
    const entry = config.ok ? await config.json() : null;
    if (entry?.mode === 'internal') {
      const login = await request('/api/internal/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken: process.env.APP_ACCESS_TOKEN }) });
      if (!login.ok) throw new Error('内部验收授权失败（HTTP ' + login.status + '）');
      cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).find(value => value.startsWith('cram_session=')) ?? '';
      if (!cookie) throw new Error('内部验收未收到应用会话');
      ownsSession = true;
    }
  }
  const session = probe.ok ? probe : await request('/api/session');
  if (!session.ok) throw new Error('无有效应用会话；旧站模式请先正常授权，再通过私有环境变量 CRAMAMELEON_SESSION_COOKIE 提供应用 Cookie');
  const fetcher = ((path: string, init?: RequestInit) => request(path, init)) as typeof fetch;
  const report = await runAcceptance({ ledgerPath, reportPath, phase, limit, fetcher, cases: teachingCases, only: a.only?.split(',').map(s => s.trim()).filter(Boolean), skipCompleted: a['skip-completed'], signal: controller.signal, log: console.log });
  console.log(JSON.stringify({ runId: report.runId, stopReason: report.stopReason, stopDetail: report.stopDetail, thisRun: report.thisRun, phase: report.totals, notRun: report.notRun, reportPath, ledgerPath }));
  if (report.stopReason !== 'completed' || report.cases.some(c => c.outcome !== 'passed')) process.exitCode = 1;
} finally {
  // Never revoke a caller-supplied old-site session.
  if (ownsSession) await request('/api/logout', { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => undefined);
}
