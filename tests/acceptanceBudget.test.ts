import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAcceptance } from '../scripts/acceptance/runner.ts';
import type { AcceptanceCase } from '../scripts/acceptance/runner.ts';
import { guardModelFetch, openBudgetLedger } from '../scripts/acceptance/budget.ts';
import type { AppSession } from '../src/contracts/index.ts';

const session = (over: Partial<AppSession> = {}): AppSession => ({ user: { id: 'u', name: 'u' }, mode: 'internal', modelReady: true, model: 'deepseek-flash', limits: { maxToolCalls: 6, timeoutSeconds: 120, maxOutputTokens: 512 }, budget: { day: '2026-11-04', limit: 1_000_000, used: 0 }, ...over });
type Step = { usage?: [number, number]; tool?: boolean; status?: number; cut?: boolean; text?: string };
// Controllable upstream at the existing /api/model boundary; never reaches a real model.
function upstream(steps: Step[], s: AppSession = session()) {
  const bodies: any[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (url === '/api/health') return Response.json({ ok: true });
    if (url === '/api/session') return Response.json(s);
    const body = JSON.parse(init!.body as string); bodies.push(body);
    const step = steps[bodies.length - 1] ?? { usage: [1, 1] };
    if (step.status) return Response.json({ error: { code: 'X', message: 'x' } }, { status: step.status });
    const events: object[] = [{ type: 'start', requestId: body.requestId }];
    if (step.tool) events.push({ type: 'tool_call', id: 'c' + bodies.length, name: 'read_skill', arguments: { name: 'concept' } });
    else events.push({ type: 'text_delta', delta: step.text ?? '好的。' });
    if (step.cut) return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
    if (step.usage) events.push({ type: 'usage', usage: { input: step.usage[0], output: step.usage[1], total: step.usage[0] + step.usage[1] } });
    events.push({ type: 'finish', stopReason: step.tool ? 'toolUse' : 'stop' });
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
  }) as typeof fetch;
  return { fetcher, bodies };
}
const ask = (id: string, text = '什么是机会成本？'): AcceptanceCase => ({ id, run: async t => { await t.turn(text); } });
async function paths() { const dir = await mkdtemp(join(tmpdir(), 'budget-')); return { ledgerPath: join(dir, 'ledger.jsonl'), reportPath: join(dir, 'report.json') }; }

test('sufficient budget: every model request in one agent turn is reserved then settled with trusted usage', async () => {
  const p = await paths();
  const up = upstream([{ tool: true, usage: [100, 20] }, { usage: [150, 30] }]);
  const report = await runAcceptance({ ...p, phase: 'spec-4', limit: 30000, fetcher: up.fetcher, cases: [ask('concept-opportunity')] });
  assert.equal(up.bodies.length, 2);
  assert.equal(report.stopReason, 'completed');
  assert.deepEqual(report.requests.map(r => [r.caseId, r.status, r.charged]), [['concept-opportunity', 'settled', 120], ['concept-opportunity', 'settled', 180]]);
  assert.ok(report.requests.every(r => r.reserved >= 512 && r.requestId === up.bodies[report.requests.indexOf(r)].requestId));
  assert.equal(report.totals.used, 300);
  assert.equal(report.totals.remaining, 29700);
  assert.deepEqual(report.cases.map(c => [c.id, c.outcome]), [['concept-opportunity', 'passed']]);
  assert.deepEqual(report.notRun, []);
  assert.deepEqual(JSON.parse(await readFile(p.reportPath, 'utf8')).totals, report.totals);
});

async function probeReservation() {
  const report = await runAcceptance({ ...(await paths()), phase: 'probe', limit: 1_000_000, fetcher: upstream([{ usage: [1, 1] }]).fetcher, cases: [ask('probe')] });
  return report.requests[0].reserved;
}

test('insufficient budget: stops before sending the request whose reservation no longer fits, mid-turn included', async () => {
  const reserved = await probeReservation();
  const p = await paths();
  // First request fits; after it settles at 1,000 the remainder cannot cover the tool follow-up.
  const up = upstream([{ tool: true, usage: [900, 100] }, { usage: [1, 1] }]);
  const report = await runAcceptance({ ...p, phase: 'spec-4', limit: reserved + 999, fetcher: up.fetcher, cases: [ask('concept-opportunity'), ask('concept-bayes')] });
  assert.equal(up.bodies.length, 1);
  assert.equal(report.stopReason, 'budget_exhausted');
  assert.match(report.stopDetail!, /不足以覆盖/);
  assert.deepEqual(report.cases.map(c => [c.id, c.outcome]), [['concept-opportunity', 'budget_stopped']]);
  assert.deepEqual(report.notRun, ['concept-bayes']);
  assert.equal(report.totals.used, 1000);
  assert.equal(JSON.parse(await readFile(p.reportPath, 'utf8')).stopReason, 'budget_exhausted');
});

test('unknown usage: interrupted stream and 5xx keep the conservative reservation and are flagged; 4xx is a trusted zero', async () => {
  const p = await paths();
  const up = upstream([{ cut: true }, { cut: true }, { cut: true }, { status: 502 }, { status: 429 }]);
  const report = await runAcceptance({ ...p, phase: 'spec-4', limit: 100000, fetcher: up.fetcher, cases: [ask('a'), ask('b'), ask('c')] });
  assert.deepEqual(report.requests.map(r => r.status), ['unknown_usage', 'unknown_usage', 'unknown_usage', 'unknown_usage', 'rejected']);
  const [cut, cutRetry1, cutRetry2, bad, rejected] = report.requests;
  assert.equal(cut.charged, cut.reserved); assert.match(cut.note!, /未收到可信用量/);
  assert.equal(bad.charged, bad.reserved); assert.match(bad.note!, /502/);
  assert.equal(rejected.charged, 0);
  assert.equal(report.totals.conservativelyHeld, cut.reserved + cutRetry1.reserved + cutRetry2.reserved + bad.reserved);
  assert.equal(report.totals.used, cut.reserved + cutRetry1.reserved + cutRetry2.reserved + bad.reserved);
  assert.deepEqual(report.cases.map(c => c.outcome), ['failed', 'failed', 'failed']);
  assert.equal(report.stopReason, 'completed');
});

test('cancellation mid-stream keeps the reservation, marks the case interrupted and reports unexecuted cases', async () => {
  const p = await paths();
  const controller = new AbortController();
  const hanging = (async (url: string, init?: RequestInit) => {
    if (url !== '/api/model') return upstream([]).fetcher(url, init);
    const body = JSON.parse(init!.body as string);
    const enc = new TextEncoder();
    // Like real fetch: aborting the request signal errors the response body.
    return new Response(new ReadableStream({ start(c) {
      c.enqueue(enc.encode('data: ' + JSON.stringify({ type: 'start', requestId: body.requestId }) + '\n\n'));
      init!.signal!.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')), { once: true });
      setTimeout(() => controller.abort(), 10);
    } }));
  }) as typeof fetch;
  const report = await runAcceptance({ ...p, phase: 'spec-4', limit: 30000, fetcher: hanging, signal: controller.signal, cases: [ask('a'), ask('b')] });
  assert.equal(report.stopReason, 'interrupted');
  assert.deepEqual(report.cases.map(c => [c.id, c.outcome]), [['a', 'interrupted']]);
  assert.deepEqual(report.notRun, ['b']);
  assert.equal(report.requests[0].status, 'unknown_usage');
  assert.equal(report.totals.used, report.requests[0].reserved);
});

test('repeated runs share the phase ledger: retries accumulate, completed cases can be skipped, dependencies rerun', async () => {
  const p = await paths();
  const base = { ...p, phase: 'spec-4', limit: 30000 };
  const scope: AcceptanceCase = { id: 'review-scope', run: t => t.turn('带我复习概率论') };
  const follow = (passes: boolean): AcceptanceCase => ({ id: 'review-followup', after: ['review-scope'], run: async t => {
    const prev = t.result('review-scope');
    const turn = await t.turn('我选条件概率', { sessionId: prev.input.sessionId, history: [{ role: 'user', text: prev.row.input }, { role: 'assistant', text: prev.row.output }] });
    assert.ok(passes, '内容检查未通过'); return turn;
  } });
  const first = await runAcceptance({ ...base, fetcher: upstream([{ usage: [100, 10] }, { usage: [200, 20] }, { usage: [300, 30] }]).fetcher, cases: [ask('simple-definition'), scope, follow(false)] });
  assert.deepEqual(first.cases.map(c => c.outcome), ['passed', 'passed', 'failed']);
  assert.equal(first.totals.used, 660);

  const up = upstream([{ usage: [400, 40] }, { usage: [500, 50] }]);
  const second = await runAcceptance({ ...base, fetcher: up.fetcher, skipCompleted: true, cases: [ask('simple-definition'), scope, follow(true)] });
  assert.deepEqual(second.skipped, ['simple-definition']);
  assert.deepEqual(second.cases.map(c => [c.id, c.outcome]), [['review-scope', 'passed'], ['review-followup', 'passed']]);
  assert.equal(up.bodies[1].sessionId, up.bodies[0].sessionId);
  assert.deepEqual(second.previousRuns, [first.runId]);
  assert.equal(second.thisRun.used, 990);
  assert.equal(second.totals.used, 1650);
  assert.equal(second.requests.length, 5);
  assert.deepEqual(second.requests.map(r => r.runId), [first.runId, first.runId, first.runId, second.runId, second.runId]);

  const wrong = await runAcceptance({ ...base, limit: 60000, fetcher: upstream([]).fetcher, cases: [ask('x')] });
  assert.equal(wrong.stopReason, 'error'); assert.match(wrong.stopDetail!, /账本属于阶段 spec-4（额度 30000）/);
  assert.deepEqual(wrong.notRun, ['x']);
});

test('preflight: unavailable model or exhausted daily quota stops before any model request, with a report', async () => {
  for (const [s, reason, detail] of [[session({ modelReady: false }), 'preflight_failed', /尚未配置真实模型/], [session({ budget: { day: '2026-11-04', limit: 100000, used: 99000 } }), 'daily_quota', /当日剩余 1000/]] as const) {
    const p = await paths();
    const up = upstream([], s);
    const report = await runAcceptance({ ...p, phase: 'spec-4', limit: 30000, fetcher: up.fetcher, cases: [ask('a')] });
    assert.equal(up.bodies.length, 0);
    assert.equal(report.stopReason, reason); assert.match(report.stopDetail!, detail);
    assert.deepEqual(report.notRun, ['a']);
    assert.equal(JSON.parse(await readFile(p.reportPath, 'utf8')).stopReason, reason);
  }
  const p = await paths();
  const dead = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const report = await runAcceptance({ ...p, phase: 'spec-4', limit: 30000, fetcher: dead, cases: [ask('a')] });
  assert.equal(report.stopReason, 'preflight_failed'); assert.equal(report.preflight?.health, false);
});

test('daily quota tracked during the run stops before the server would reject the reservation', async () => {
  // Server reserves body + 4096 + maxOutput (+256 slack here) vs. our phase bound body + 512 + maxOutput: 3840 more.
  // Daily remainder fits the first server reservation by 50 tokens; after 110 are charged the second cannot fit.
  const reserved = await probeReservation();
  const up = upstream([{ usage: [100, 10] }, { usage: [100, 10] }], session({ budget: { day: '2026-11-04', limit: 1_000_000, used: 1_000_000 - (reserved + 3840 + 50) } }));
  const report = await runAcceptance({ ...(await paths()), phase: 'spec-4', limit: 30000, fetcher: up.fetcher, cases: [ask('a'), ask('b')] });
  assert.equal(up.bodies.length, 1);
  assert.equal(report.stopReason, 'daily_quota');
  assert.deepEqual(report.cases.map(c => c.outcome), ['passed', 'budget_stopped']);
});

test('a hard-killed run leaves its reservation in the ledger; the next run counts it as unsettled', async () => {
  const p = await paths();
  const ledger = openBudgetLedger(p.ledgerPath, { phase: 'spec-4', limit: 30000 });
  const guarded = guardModelFetch((() => new Promise<Response>(() => undefined)) as typeof fetch, ledger, { runId: 'killed', maxOutputTokens: 512, caseId: () => 'exam-first', onStop: () => undefined });
  void guarded('/api/model', { method: 'POST', body: JSON.stringify({ requestId: 'r-killed', sessionId: 's', turnId: 't', messages: [] }) });
  const report = await runAcceptance({ ...p, fetcher: upstream([{ usage: [10, 1] }]).fetcher, phase: 'spec-4', limit: 30000, cases: [ask('a')] });
  const killed = report.requests.find(r => r.requestId === 'r-killed')!;
  assert.equal(killed.status, 'unsettled'); assert.equal(killed.caseId, 'exam-first');
  assert.ok(killed.charged > 512);
  assert.equal(report.totals.used, killed.charged + 11);
  assert.equal(report.totals.conservativelyHeld, killed.charged);
});

test('unexpected runner failure still writes a report naming every unexecuted case', async () => {
  const p = await paths();
  const report = await runAcceptance({ ...p, phase: 'spec-4', limit: 30000, fetcher: upstream([]).fetcher, cases: [ask('a'), ask('b')], createAgent: () => { throw new Error('boom'); } });
  assert.equal(report.stopReason, 'error'); assert.equal(report.stopDetail, 'boom');
  assert.deepEqual(report.notRun, ['a', 'b']);
  assert.equal(JSON.parse(await readFile(p.reportPath, 'utf8')).stopDetail, 'boom');
});

test('the 12 historical teaching cases run through the budgeted runner and every id is accounted for', async () => {
  const { teachingCases } = await import('../scripts/acceptance/teachingCases.ts');
  const history = JSON.parse(await readFile(new URL('../docs/evidence/teaching-acceptance-2026-11-04.json', import.meta.url), 'utf8'));
  assert.deepEqual(teachingCases.map(c => c.id), history.cases.map((c: any) => c.name));
  const up = upstream(Array.from({ length: 20 }, () => ({ usage: [2500, 300] as [number, number], text: '没有资料，无法据资料回答。' })));
  const report = await runAcceptance({ ...(await paths()), phase: 'spec-4', limit: 30000, fetcher: up.fetcher, cases: teachingCases });
  assert.equal(report.stopReason, 'budget_exhausted');
  assert.equal(up.bodies.length, report.requests.length);
  assert.equal(report.totals.used, 2800 * report.requests.length);
  assert.ok(report.notRun.length > 0);
  assert.deepEqual([...report.cases.map(c => c.id), ...report.notRun].sort(), history.cases.map((c: any) => c.name).sort());
  assert.ok(report.cases.find(c => c.id === 'missing-material')?.outcome === 'passed' || report.notRun.includes('missing-material'));
});

test('review-followup live check rejects the historical "only dependent events need conditional probability" error (#12)', async () => {
  const { contentChecks } = await import('../scripts/acceptance/teachingCases.ts');
  const history = JSON.parse(await readFile(new URL('../docs/evidence/teaching-acceptance-2026-11-04.json', import.meta.url), 'utf8'));
  const old = history.cases.find((c: any) => c.name === 'review-followup').output as string;
  assert.throws(() => contentChecks.conditionalProbabilityAppliesWhenIndependent(old), /独立/);
  assert.doesNotThrow(() => contentChecks.conditionalProbabilityAppliesWhenIndependent(old.replace('不独立才需用条件概率', '条件概率对独立与否都适用')));
});
