/** One bounded model-priced development cycle. No market orders or deployment. */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { freezeCampaign, decideRetention } from '../../plugins/helium-self/lib/evolution/campaign.js';
import { compareUtility, evaluateStop } from '../../plugins/helium-self/lib/evolution/utility.js';

const [argonArg, outputArg, snapshotArg] = process.argv.slice(2);
if (!argonArg || !outputArg || process.argv.length > 5) throw new Error('usage: node scripts/research/run-argon-m3-pilot.mjs ARGON_WORKTREE NEW_OUTPUT_DIR [SNAPSHOT]');
const argon = resolve(argonArg), output = resolve(outputArg);
mkdirSync(output);
const persist = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n', {flag:'wx'});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const events = (stage, details={}) => appendFileSync(join(output, 'events.jsonl'), JSON.stringify({stage, at:new Date().toISOString(), ...details})+'\n');
const policy = {constraint:{metric:'realizedDrawdown',minimum:0,upperBound:0.15},objectives:[
  {metric:'annualNetReturn',direction:'higher',epsilon:0.001},
  {metric:'realizedDrawdown',direction:'lower',epsilon:0.001},
]};
const budget = {maxCalls:9,maxElapsedMs:180000,stalledCandidates:3};
const engineFiles = ['scripts/research/vrp/m3_pilot.py','src/uw_scan/config.py','uv.lock',
  ...readdirSync(join(argon,'src/uw_scan/reports')).filter(f=>f.startsWith('vrp') && f.endsWith('.py')).sort().map(f=>'src/uw_scan/reports/'+f)];
const engineHashes = () => Object.fromEntries(engineFiles.map(f=>[f,hash(readFileSync(join(argon,f)))]));
const evaluatorHashes = () => Object.fromEntries(['campaign','utility'].map(f=>[f,hash(readFileSync(new URL('../../plugins/helium-self/lib/evolution/'+f+'.js',import.meta.url)))]));
const started = performance.now();
try {
  const engineBefore=engineHashes(), evaluatorBefore=evaluatorHashes();
  // Registration precedes the subprocess. This is an exposed development pilot.
  persist('registration.json', {phase:'development', primaryCostUsd:2, selection:'fixed candidate .10 vs baseline .20 and size-down .05; retain only if better than both at primary cost',
    constraintScope:'realized settlements only, not MTM or executable fills',policy,budget,
    callsUnit:'deterministic simulator evaluations (not LLM calls)',frameworkSha:spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim(),
    runnerSha256:hash(readFileSync(new URL(import.meta.url))),
    adapterSha256:hash(readFileSync(join(argon,'scripts/research/vrp/m3_pilot.py'))),
    targetConfirmation:'disabled: no sealed holdout or NBBO',
    engineHashes:engineBefore,evaluatorHashes:evaluatorBefore,
    resourceScope:'subprocess/evaluator only; development agent tokens, costs and human corrections unmeasured'});
  events('diagnose',{finding:'Prior record mixed drawdown definitions; no NBBO and no sealed OOS.'});
  events('propose',{candidate:'fixed 10% sizing; no entry-signal change',control:'5% sizing'});
  events('execute-intent');
  const args = ['run','python','scripts/research/vrp/m3_pilot.py','--output',join(output,'research')];
  if (snapshotArg) args.push('--snapshot',resolve(snapshotArg));
  const run = spawnSync('uv', args, {cwd:argon,encoding:'utf8',timeout:budget.maxElapsedMs,maxBuffer:2*1024*1024,
    env:{...process.env,UW_SCAN_DB_HOST:'127.0.0.1',UW_SCAN_DB_NAME:'option_wizard_local',UW_SCAN_DB_USER:process.env.USER,UW_SCAN_API_KEY:'model-only-unused',PGOPTIONS:'-c default_transaction_read_only=on'}});
  writeFileSync(join(output,'adapter.stdout'),run.stdout ?? '',{flag:'wx'});
  writeFileSync(join(output,'adapter.stderr'),run.stderr ?? '',{flag:'wx'});
  if (run.error || run.status !== 0) throw new Error(`adapter failed: ${run.error?.message ?? run.status}`);
  if (JSON.stringify(engineBefore)!==JSON.stringify(engineHashes()) || JSON.stringify(evaluatorBefore)!==JSON.stringify(evaluatorHashes())) throw new Error('engine/evaluator changed during execution');
  const summaryBytes = readFileSync(join(output,'research/summary.json'));
  const summary = JSON.parse(summaryBytes);
  for (const [arm,risk] of [['baseline',0.20],['size_down_control',0.05],['candidate',0.10]]) {
    const config=summary.arms?.[arm];
    if (!config || config.base_risk_pct!==risk || config.compounding!==true || config.capital_usd!==1000000 ||
        config.overlay_mult!==0 || config.names?.length!==1 || config.names[0]!=='SPX' ||
        typeof config.config_sha256!=='string' || !/^[a-f0-9]{64}$/.test(config.config_sha256)) throw new Error('unexpected arm config');
  }
  for (const [file,key] of [['protocol.json','protocol_sha256'],['source_snapshot.json','snapshot_sha256']]) {
    if (hash(readFileSync(join(output,'research',file))) !== summary[key]) throw new Error(`${file} hash mismatch`);
  }
  if (summary.metric_basis !== 'realized_settlements_only' || summary.primary_cost_usd !== 2 ||
      summary.oos_status !== 'development_corpus_exposed_no_sealed_oos') throw new Error('unexpected evaluation basis');
  if (!Array.isArray(summary.results) || summary.results.length !== 9) throw new Error('expected nine scenario results');
  for (const arm of ['baseline','size_down_control','candidate']) for (const cost of [0,2,5]) {
    const matching = summary.results.filter(r=>r.arm===arm && r.cost_usd===cost);
    if (matching.length!==1) throw new Error('missing or duplicate arm/cost');
    const r=matching[0];
    const files = [['trade_path','trade_sha256'],['settlement_equity_path','settlement_equity_sha256']];
    for (const [pathKey,hashKey] of files) {
      if (typeof r[pathKey] !== 'string' || r[pathKey].includes('..') || r[pathKey].startsWith('/')) throw new Error('invalid evidence path');
      if (hash(readFileSync(join(output,'research',r[pathKey]))) !== r[hashKey]) throw new Error('trade/equity hash mismatch');
    }
    const path=JSON.parse(readFileSync(join(output,'research',r.settlement_equity_path)));
    if (!Array.isArray(path) || path.length<2 || path[0].equity_usd!==1000000) throw new Error('invalid initial model equity');
    let peak=path[0].equity_usd, dd=0, equity=peak;
    for (const point of path.slice(1)) {
      if (!Number.isFinite(point.equity_usd) || !Number.isFinite(point.net_pnl_usd)) throw new Error('invalid equity point');
      equity+=point.net_pnl_usd;
      if (Math.abs(equity-point.equity_usd)>1e-6) throw new Error('equity path does not reconcile');
      peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak);
    }
    if (Math.abs(dd-r.max_drawdown)>1e-10 || Math.abs(equity-r.terminal_equity_usd)>1e-6) throw new Error('summary/path metric mismatch');
    if (!Number.isFinite(r.annual_net_return) || !Number.isFinite(r.max_drawdown) || r.max_drawdown<0 ||
        !Number.isSafeInteger(r.trade_count) || r.trade_count<=0 || !Number.isFinite(r.terminal_equity_usd) || r.terminal_equity_usd<=0) throw new Error('invalid or insolvent arm');
  }
  events('verify',{snapshotSha256:summary.snapshot_sha256,summarySha256:hash(summaryBytes),resultCount:9});
  const row = (arm,cost=2) => summary.results.find(r=>r.arm===arm && r.cost_usd===cost);
  const measures = r => ({realizedDrawdown:r.max_drawdown,annualNetReturn:r.annual_net_return});
  const revision = arm => summary.arms[arm].config_sha256;
  const contract = freezeCampaign({id:'argon-vrp-model-pilot-v1',version:'v1',goal:'Improve model-priced realized path under 15% research constraint',
    evaluatorVersion:'realized-net-equity-v1',rubricVersion:'utility-v1',holdoutVersion:'EXPOSED-DEVELOPMENT-ONLY',
    baseRevision:revision('baseline'),primaryMetric:'annualNetReturn',direction:'higher',utilityPolicy:policy});
  const candidate = {id:'candidate',parentRevision:contract.baseRevision,revision:revision('candidate'),contractVersion:contract.version,
    measures:measures(row('candidate')),checks:{routeResolved:true,outputValid:true,evidenceComplete:true}};
  const decision=decideRetention(contract,measures(row('baseline')),candidate);
  const versusControl=compareUtility(policy,measures(row('size_down_control')),candidate.measures);
  const elapsedMs=performance.now()-started;
  const withinBudget=elapsedMs<=budget.maxElapsedMs;
  const retained=withinBudget && decision.status==='retained' && versusControl.eligible && versusControl.improved;
  const stop=evaluateStop(budget,{targetVerified:false,callsUsed:9,elapsedMs,completed:[compareUtility(policy,measures(row('baseline')),candidate.measures)]});
  const result={status:'PILOT_COMPLETED',phase:'development',versusBaselineDecision:decision,versusControl,
    selected:retained?'candidate':'baseline',retained,withinBudget,stop,targetStatus:'UNVERIFIED',
    rationale:!withinBudget?'budget exceeded':retained?'candidate improved over both fixed references':'candidate not better than both fixed references; keep baseline',
    sensitivity:[0,2,5].map(cost=>({costUsd:cost,versusBaseline:compareUtility(policy,measures(row('baseline',cost)),measures(row('candidate',cost))),versusControl:compareUtility(policy,measures(row('size_down_control',cost)),measures(row('candidate',cost)))})),
    framework:{campaignId:contract.id,inputWorldHash:summary.snapshot_sha256,elapsedMs,evaluations:9,runtimeModelCalls:0,runtimeModelTokens:0,
      developmentAgentTokens:null,developmentAgentCostUsd:null,humanCorrections:null,comparison:'NOT_RUN: one framework version only'},
    limitations:summary.caveats};
  events('evaluate',{versusBaselineDecision:decision.status,controlImproved:versusControl.improved});
  persist('result.json',result);
  events(retained?'retain-development-config':'rollback-to-baseline',{revision:retained?revision('candidate'):contract.baseRevision});
  console.log(JSON.stringify({output,...result}));
} catch (error) {
  persist('failure.json',{status:'INCONCLUSIVE',error:String(error),elapsedMs:performance.now()-started,targetStatus:'UNVERIFIED'});
  events('failed',{reason:String(error)});
  console.error(String(error));process.exitCode=1;
}
