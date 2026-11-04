// Budgeted live teaching acceptance (#11). Uses only synthetic course content and never logs credentials.
//
//   node --experimental-strip-types scripts/acceptance-teaching.ts --status
//   node --experimental-strip-types scripts/acceptance-teaching.ts --live [--only id,id] [--skip-completed]
//
// Options (defaults in brackets):
//   --live                 required to send real (paid) model requests
//   --status               print the phase ledger totals and last case outcomes; no network
//   --phase <name>         [spec-4]   budget phase recorded in the ledger header
//   --limit <tokens>       [30000]    phase input+output token cap; must match the ledger header
//   --ledger <path>        [.preflight/acceptance-budget/<phase>.jsonl]  append-only phase ledger
//   --report <path>        [.preflight/teaching-acceptance-<phase>.json]  report of this run
//   --only <ids>           run only these case ids (dependencies are added)
//   --skip-completed       skip cases whose last ledger outcome is `passed`
//   --host <ssh>           [zzs]      SSH host serving the Go proxy on 127.0.0.1:18085
//   --port <local>         [18089]    local tunnel port
// Re-running with the same --ledger continues the same phase: consumed budget is never reset.
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { openBudgetLedger } from './acceptance/budget.ts';
import { runAcceptance } from './acceptance/runner.ts';
import { teachingCases } from './acceptance/teachingCases.ts';

const { values: a } = parseArgs({ options: {
  live: { type: 'boolean', default: false }, status: { type: 'boolean', default: false },
  phase: { type: 'string', default: 'spec-4' }, limit: { type: 'string', default: '30000' },
  ledger: { type: 'string' }, report: { type: 'string' }, only: { type: 'string' },
  'skip-completed': { type: 'boolean', default: false },
  host: { type: 'string', default: 'zzs' }, port: { type: 'string', default: '18089' },
} });
const phase = a.phase!, limit = Number(a.limit);
if (!Number.isInteger(limit) || limit <= 0) throw new Error('--limit must be a positive integer');
const ledgerPath = a.ledger ?? `.preflight/acceptance-budget/${phase}.jsonl`;
const reportPath = a.report ?? `.preflight/teaching-acceptance-${phase}.json`;

if (a.status) {
  const ledger = openBudgetLedger(ledgerPath, { phase, limit });
  console.log(JSON.stringify({ ledgerPath, ...ledger.totals(), runs: ledger.runs().length, lastOutcomes: Object.fromEntries(ledger.lastOutcomes()) }, null, 2));
  process.exit(0);
}
if (!a.live) throw new Error('Pass --live to opt into paid model calls (or --status to inspect the ledger)');

const host = a.host!, port = Number(a.port), base = 'http://127.0.0.1:' + port;
const tunnel = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-N', '-L', '127.0.0.1:' + port + ':127.0.0.1:18085', host], { windowsHide: true, stdio: 'ignore' });
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { console.error('中断：结束当前请求并写报告…'); controller.abort(); });
let cookie = '';
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch { /* tunnel not up yet */ } await delay(200); }
  const code = `import json,pathlib,urllib.request,http.cookiejar
cfg={}
for line in pathlib.Path('/home/ubuntu/cramameleon/.env.internal').read_text().splitlines():
 if line.strip() and not line.lstrip().startswith('#') and '=' in line:
  k,v=line.split('=',1);cfg[k]=v.strip().strip(chr(34)+chr(39))
jar=http.cookiejar.CookieJar();c=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
r=urllib.request.Request('http://127.0.0.1:18085/api/internal/session',data=json.dumps({'accessToken':cfg['APP_ACCESS_TOKEN']}).encode(),headers={'Content-Type':'application/json'})
session=json.load(c.open(r));print(json.dumps({'cookie':next(x.value for x in jar if x.name=='cram_session')}))
`;
  try { cookie = 'cram_session=' + JSON.parse(execFileSync('ssh', ['-o', 'BatchMode=yes', host, 'python3 -'], { input: code, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })).cookie; }
  catch { console.error('无法建立应用会话；预检将记录失败'); }
  const fetcher = (async (url: string, init?: RequestInit) => fetch(base + url, { ...init, headers: { ...init?.headers, ...(cookie ? { Cookie: cookie } : {}) } })) as typeof fetch;
  const report = await runAcceptance({ ledgerPath, reportPath, phase, limit, fetcher, cases: teachingCases, only: a.only?.split(',').map(s => s.trim()).filter(Boolean), skipCompleted: a['skip-completed'], signal: controller.signal, log: console.log });
  console.log(JSON.stringify({ runId: report.runId, stopReason: report.stopReason, stopDetail: report.stopDetail, thisRun: report.thisRun, phase: report.totals, notRun: report.notRun, reportPath, ledgerPath }));
  if (report.stopReason !== 'completed' || report.cases.some(c => c.outcome !== 'passed')) process.exitCode = 1;
} finally {
  if (cookie) await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } }).catch(() => undefined);
  tunnel.kill();
}
