const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ts=require('typescript');
const read=name=>fs.readFileSync(path.join(__dirname,'../src',name),'utf8');
const compiled=ts.transpileModule(read('services/workflowBudget.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const result={exports:{}};new Function('exports','module',compiled)(result.exports,result);
test('workflow totals include every priced item without rounding drift',()=>{
 const {workflowTotal}=result.exports;
 assert.equal(workflowTotal([{credits:4},{credits:2},{credits:4.5}]),10.5);
 assert.equal(workflowTotal([{credits:4},{credits:2},{credits:4},{credits:4.5}]),14.5);
 assert.equal(workflowTotal([{credits:.1},{credits:.2},{credits:.000001}]),.300001);
 assert.equal(workflowTotal([]),0);
});
test('automatic execution carries its approval and never opens model selection',()=>{
 const app=read('App.tsx');
 const runner=app.slice(app.indexOf('const runAutomaticWorkflow ='),app.indexOf('const stopAutomaticWorkflow ='));
 assert.doesNotMatch(runner,/requestMediaModel|window\.confirm/);
 assert.match(runner,/workflowCreditId/);
 assert.match(runner,/WORKFLOW_CREDIT_STOPPED/);
 assert.match(runner,/setWorkflowQuiet\(queryClient,workflowId,true\)/);
 assert.match(runner,/setWorkflowQuiet\(queryClient,workflowId,false\)/);
 assert.match(app,/workflow_credit_id: selection.workflowCreditId/);
 assert.ok(app.indexOf('<footer className="story-auto-footer">')>app.indexOf('className="story-page-layout"'));
});
test('both credit dialogs are suppressed while automatic production runs',()=>{
 assert.match(read('components/CreditConfirmationHost.tsx'),/if \(!items.length \|\| workflowQuiet\) return null/);
 assert.match(read('components/LowCreditReminderHost.tsx'),/if \(!userId \|\| workflowQuiet\) return null/);
});
