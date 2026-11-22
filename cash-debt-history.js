/* Stage 3: read-only account reconstruction from recorded current balances and signed account activity.
 * Ledger activity is evidence, not an automatic second cash flow. No inferred investment funding.
 * No account is assumed to have existed (or held zero) before it was first represented in the app.
 */
(function(root){
  'use strict';
  const req=typeof module==='object'&&module.exports;
  const Dates=root.MoneyBuddyDates||(req?require('./transaction-dates.js'):null);
  const Events=root.MoneyBuddyEvents||(req?require('./financial-events.js'):null);
  const Investments=root.MoneyBuddyInvestmentHistory||(req?require('./investment-history.js'):null);
  const Recon=root.MoneyBuddyReconciliation||(req?require('./reconciliation.js'):null);
  const ANCHOR='mm-stage3-cash-anchor';
  const money=n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=Number.MAX_SAFE_INTEGER/100;
  const cents=n=>Math.round(n*100);
  const dollars=n=>n===null?null:n/100;
  const add=(rows,key)=>rows.reduce((s,r)=>s+r[key],0);
  function validAnchor(a){return !!a&&a.version===1&&Dates.validDay(a.day)&&money(a.amount)&&Object.keys(a).every(k=>['version','day','amount'].includes(k));}
  function readAnchor(storage){try{const a=JSON.parse(storage.getItem(ANCHOR));return validAnchor(a)?a:null;}catch(_){return null;}}
  function build(core,{anchor=null,reconciliation=Recon.empty(),now=new Date()}={}){
    const today=Dates.calendarDay(now);if(!today)throw Error('Invalid observation date');
    const n=Events.normalize(core), raw=Array.isArray(core.cards)?core.cards:[];
    if(!validAnchor(anchor)||anchor.day>=today)anchor=null;
    const issueRefs=new Set(n.issues.filter(i=>['invalid-account','missing-account-id','duplicate-account-id','unexpected-account-activity-field','invalid-account-movement','invalid-posting-date','missing-movement-id','duplicate-movement-id'].includes(i.code)).map(i=>i.ref));
    const ledger=n.ledger.filter(e=>e.effectiveDay&&money(e.amount)&&e.amount>0);
    const ledgerIssues=new Set(n.issues.filter(i=>['invalid-ledger-date','invalid-ledger-amount','missing-ledger-id','duplicate-ledger-id'].includes(i.code)).map(i=>i.ref));
    const accounts=n.accounts.map((a,i)=>{
      const ms=n.accountMovements.filter(m=>m.accountRef===a.accountRef);
      const valid=money(a.balance)&&a.type!=='unknown'&&!issueRefs.has(a.accountRef)&&ms.every(m=>!issueRefs.has(m.movementId)&&money(m.accountDelta)&&m.postingDay);
      const firstActivity=ms.map(m=>m.postingDay).filter(Boolean).sort()[0]||null;
      // Added date is a lower bound on coverage, not the actual bank opening date.
      const first=[a.addedDay,firstActivity].filter(Boolean).sort()[0]||null;
      return {...a,name:typeof raw[i]?.name==='string'?raw[i].name:'Recorded account',valid,first,firstActivity,movements:ms,base:money(a.balance)?cents(a.balance):null};
    });
    const first=[...n.investments.map(e=>e.dateEvidence.month?e.dateEvidence.month+'-01':null),...ledger.map(e=>e.effectiveDay),...accounts.map(a=>a.first),anchor?.day,...reconciliation.anchors.filter(x=>!x.deleted).map(x=>x.day)].filter(d=>d&&d<=today).sort()[0]||today;
    const latestFull=accounts.length&&accounts.every(a=>a.valid&&a.first)?accounts.map(a=>a.first).sort().at(-1):null;
    function accountAt(a,day){
      const observed=day===today;
      const covered=observed||!!a.first&&day>=a.first;
      // Current saved balance already reflects all recorded movements, including a posting
      // dated tomorrow because the legacy app records UTC dates. Undo every later posting.
      const later=a.movements.filter(m=>m.postingDay&&m.postingDay>day);
      const altLater=a.movements.filter(m=>(m.linkStatus==='verified'?m.effectiveDay:m.postingDay)>day);
      const signed=rows=>rows.reduce((s,m)=>s+cents(m.accountDelta),0);
      const computable=a.valid&&covered;
      const evidence=!observed&&a.recordId!==null&&a.type!=='unknown'&&!issueRefs.has(a.accountRef)?Recon.resolve(reconciliation,a,day,today):null;
      const balance=evidence?(evidence.balance===null?null:cents(evidence.balance)):observed&&a.base!==null&&a.type!=='unknown'&&!issueRefs.has(a.accountRef)?a.base:computable?a.base-signed(later):null;
      const alternate=evidence?balance:observed?balance:computable?a.base-signed(altLater):null;
      const preCoverage=!!a.first&&day<a.first;
      return {accountRef:a.accountRef,name:a.name,type:a.type,first:a.first,firstActivity:a.firstActivity,quality:balance===null?'unavailable':observed?'recorded':evidence?evidence.kind:'reconstructed',evidence,balance:dollars(balance),effectiveAlternative:dollars(alternate),laterMovements:observed?0:later.length,cutoffDifferences:observed?0:a.movements.filter(m=>m.linkStatus==='verified'&&((m.postingDay>day)!==(m.effectiveDay>day))).length,preCoverage:preCoverage&&!evidence,invalid:!a.valid,negative:balance!==null&&balance<0};
    }
    function group(rows,type){
      const r=rows.filter(a=>a.type===type),known=r.filter(a=>a.balance!==null);
      const complete=r.length>0&&known.length===r.length&&!rows.some(a=>a.type==='unknown');
      return {value:complete?dollars(known.reduce((s,a)=>s+cents(a.balance),0)):null,knownSubtotal:dollars(known.reduce((s,a)=>s+cents(a.balance),0)),effectiveAlternative:complete?dollars(known.reduce((s,a)=>s+cents(a.effectiveAlternative),0)):null,covered:known.length,count:r.length};
    }
    function anchorScenario(day){
      if(!anchor||day<anchor.day||day>=today)return null;
      if(day!==anchor.day&&n.ledger.some(e=>ledgerIssues.has(e.eventId)&&(!e.effectiveDay||e.effectiveDay>anchor.day&&e.effectiveDay<=day)))return null;
      const period=ledger.filter(e=>e.effectiveDay>anchor.day&&e.effectiveDay<=day);
      const confirmedCredit=new Set(n.accountMovements.filter(m=>m.linkStatus==='verified'&&m.kind==='credit-spend').map(m=>m.ledgerEventId));
      let income=0,cashExpenses=0,unallocated=0,creditExpenses=0;
      for(const e of period){if(e.kind==='income')income+=cents(e.amount);else if(confirmedCredit.has(e.eventId))creditExpenses+=cents(e.amount);else if(e.linkStatus==='verified')cashExpenses+=cents(e.amount);else unallocated+=cents(e.amount);}
      // Explicitly separate conditional ledger scenario from the actual account estimate.
      // It ignores non-ledger transfers, card repayments, unlogged activity and uncertainty about receipt.
      const base=cents(anchor.amount)+income-cashExpenses;
      return {day:anchor.day,amount:anchor.amount,atAnchor:day===anchor.day,value:dollars(base-unallocated),withoutUnallocatedExpenses:dollars(base),income:dollars(income),linkedCashExpenses:dollars(cashExpenses),unallocatedExpenses:dollars(unallocated),linkedCreditExpenses:dollars(creditExpenses),quality:day===anchor.day?'user-confirmed-anchor':'ledger-scenario'};
    }
    function valueAt(day){
      if(!Dates.validDay(day)||day<first||day>today)throw Error('Choose a date in the recorded timeline.');
      const rows=accounts.map(a=>accountAt(a,day)),cash=group(rows,'debit'),debt=group(rows,'credit'),scenario=anchorScenario(day);
      // A confirmed cash anchor is an independent aggregate observation on its exact date.
      // No scaling, automatic interpolation, or assumed opening debt.
      if(scenario?.atAnchor){cash.accountReconstruction=cash.value;cash.value=anchor.amount;cash.effectiveAlternative=anchor.amount;cash.anchorOverride=true;}
      const complete=cash.value!==null&&debt.value!==null;
      return {day,accounts:rows,cash,debt,netLiquid:complete?dollars(cents(cash.value)-cents(debt.value)):null,effectiveAlternative:complete?dollars(cents(cash.effectiveAlternative)-cents(debt.effectiveAlternative)):null,quality:complete?(day===today?'recorded':rows.some(a=>a.evidence)?'reconciled':'reconstructed'):'unavailable',reconciledAccounts:rows.filter(a=>a.evidence).length,interpolatedAccounts:rows.filter(a=>a.evidence?.kind==='statement-interpolation').length,scenario,cutoffDifferences:rows.reduce((s,a)=>s+a.cutoffDifferences,0),negativeAccounts:rows.filter(a=>a.negative).length,unlinkedLedgerCount:ledger.filter(e=>e.linkStatus!=='verified'&&e.effectiveDay>day&&e.effectiveDay<=today).length};
    }
    return {first,last:today,latestFull,summary:{accounts:accounts.length,activity:n.summary.accountMovements,verifiedLinks:n.summary.verifiedLinks,possibleTransfers:n.summary.possibleTransfers,possibleLedgerMatches:n.summary.possibleLedgerMatches,invalidAccounts:accounts.filter(a=>!a.valid).length},valueAt};
  }
  function combine(investment,balances){
    const base=balances.netLiquid;
    const plus=x=>base===null||x===null?null:dollars(cents(base)+cents(x));
    return {day:balances.day,total:plus(investment.total),minValue:plus(investment.minValue),maxValue:plus(investment.maxValue),quality:base===null?'unavailable':investment.total===null?(investment.minValue!==null&&investment.maxValue!==null?'conditional-range':'unavailable'):(investment.quality==='estimated'?'estimated':'reconstructed'),investment,balances};
  }
  function Preview({core,darkMode,storage}){
    const React=root.React,h=React.createElement,[chosen,setChosen]=React.useState(''),[open,setOpen]=React.useState(false),[anchor,setAnchor]=React.useState(()=>readAnchor(storage)),[ad,setAd]=React.useState(()=>readAnchor(storage)?.day||''),[av,setAv]=React.useState(()=>String(readAnchor(storage)?.amount??storage.getItem('nw-anchor')??'')),[message,setMessage]=React.useState('');
    const muted=darkMode?'text-gray-400':'text-gray-600',title=darkMode?'text-purple-300':'text-purple-700',input='block w-full mt-1 p-2 rounded-lg border '+(darkMode?'bg-gray-800 border-gray-600 text-white':'bg-white border-gray-300 text-gray-900');
    const usd=x=>x===null?'Unavailable':x.toLocaleString('en-US',{style:'currency',currency:'USD'});
    const row=(label,value)=>h('div',{key:label,className:'flex justify-between gap-2 text-sm'},h('span',{className:muted},label),h('span',{className:'font-medium'},value));
    function save(){try{const a={version:1,day:ad,amount:Number(av)};if(!av.trim()||!validAnchor(a)||ad>=Dates.today())throw Error('Enter a valid completed date and actual cash balance.');storage.setItem(ANCHOR,JSON.stringify(a));setAnchor(a);setMessage('Dated cash anchor saved; original records unchanged.');}catch(e){setMessage(e.message||'Could not save the anchor.');}}
    function clear(){try{storage.removeItem(ANCHOR);setAnchor(null);setAd('');setMessage('Dated cash anchor removed. Legacy starting cash remains unchanged.');}catch(e){setMessage('Could not remove the dated anchor.');}}
    function render(){try{
      const m=build(core,{anchor,reconciliation:Recon.read(storage)}),day=chosen&&chosen>=m.first&&chosen<=m.last?chosen:m.last,b=m.valueAt(day);let combined=null;try{const im=Investments.build(core,Investments.readEvidence(storage));if(im.first&&day>=im.first&&day<=im.last)combined=combine(im.valueAt(day),b);}catch(_){}
      return h('div',{className:'mt-3 space-y-3'},
        h('p',{className:'text-xs '+muted},'Account-only reconstruction from current saved balances and later recorded postings. Manual balance changes and unrecorded movements may make past estimates incomplete. Dated evidence also informs the chart; original records are unchanged.'),
        h('label',{className:'block text-xs '+muted},'Historical balance date',h('input',{type:'date',min:m.first,max:m.last,value:day,onChange:e=>setChosen(e.target.value),className:input})),
        h('div',{className:'p-3 rounded-xl space-y-2 '+(darkMode?'bg-purple-900/20':'bg-purple-50')},row('Checking / savings',usd(b.cash.value)),row('Credit card debt',usd(b.debt.value)),row('Cash minus debt',usd(b.netLiquid)),h('p',{className:'text-xs '+muted},b.quality==='recorded'?'Current saved balances · not bank-verified':b.quality==='reconciled'?'Reconciled · inspect dated evidence and estimated intervals':b.quality==='reconstructed'?'Reconstructed · assumes recorded account activity is complete':'Account coverage incomplete · no invented opening balance'),h('p',{className:'text-xs '+muted},'Cash coverage '+b.cash.covered+'/'+b.cash.count+' · debt coverage '+b.debt.covered+'/'+b.debt.count+(m.latestFull?' · all accounts represented from '+m.latestFull:'')),b.cash.anchorOverride&&h('p',{className:'text-xs '+muted},'Cash uses your dated aggregate observation, not the account subtotal.'),b.cash.value===null&&row('Known cash subtotal only',usd(b.cash.knownSubtotal)),b.debt.value===null&&row('Known debt subtotal only',usd(b.debt.knownSubtotal)),b.cutoffDifferences>0&&h('p',{className:'text-xs text-amber-500'},b.cutoffDifferences+' verified posting date(s) cross this cutoff. Alternate ledger-date cash minus debt: '+usd(b.effectiveAlternative))),
        ...b.accounts.map(a=>h('div',{key:a.accountRef,className:'border-b pb-2 '+(darkMode?'border-gray-700':'border-gray-200')},row(a.name+' · '+a.type,usd(a.balance)),h('p',{className:'text-xs '+muted},a.evidence?a.evidence.kind+' · '+a.evidence.from+(a.evidence.to?' to '+a.evidence.to+' · unrecorded change '+usd(a.evidence.residual):''):a.preCoverage?'Before account was represented in the app; earlier balance unknown.':a.invalid?'Account activity requires review.':a.quality==='recorded'?'Current saved amount':a.laterMovements+' later postings reversed · represented from '+(a.first||'unknown')),a.negative&&h('p',{className:'text-xs text-amber-500'},'Negative reconstructed balance; review for missing activity, overdraft or credit.'))),
        combined&&h('div',{className:'p-3 rounded-xl '+(darkMode?'bg-purple-900/20':'bg-purple-50')},h('p',{className:'text-xs '+muted},'Combined historical net worth preview'),h('p',{className:'text-xl font-bold '+(combined.total===null?'text-amber-500':'text-emerald-500')},combined.total!==null?usd(combined.total):combined.minValue!==null&&combined.maxValue!==null?usd(combined.minValue)+' – '+usd(combined.maxValue):'Unavailable'),h('p',{className:'text-xs '+muted},'Diagnostic only · investment and account uncertainties remain.')),
        h('p',{className:'text-xs '+muted},b.unlinkedLedgerCount+' later ledger entries lack a verified account posting. They are not added again; incomes/expenses may overlap existing activity.'),
        h('div',{className:'p-3 rounded-xl space-y-2 '+(darkMode?'bg-purple-900/20':'bg-purple-50')},h('p',{className:'text-sm font-semibold '+title},'Optional dated starting cash anchor'),h('p',{className:'text-xs '+muted},'Only save if you know the actual aggregate cash balance at the end of that date. The prefilled legacy amount is not confirmation. No date is assumed.'),h('label',{className:'block text-xs '+muted},'Cash balance date',h('input',{type:'date',max:Dates.calendarDay(new Date(Date.now()-86400000)),value:ad,onChange:e=>setAd(e.target.value),className:input})),h('label',{className:'block text-xs '+muted},'Total cash balance (USD)',h('input',{type:'number',step:'0.01',value:av,onChange:e=>setAv(e.target.value),className:input})),h('div',{className:'flex flex-wrap gap-2'},h('button',{type:'button',onClick:save,className:'px-3 py-2 rounded-lg bg-purple-600 text-white text-sm'},'Save dated cash anchor'),anchor&&h('button',{type:'button',onClick:clear,className:'px-3 py-2 rounded-lg text-sm '+muted},'Remove')),anchor&&h('p',{className:'text-xs '+muted},'Saved: '+anchor.day+' · '+usd(anchor.amount)),message&&h('p',{role:'status',className:'text-xs '+muted},message),b.scenario&&!b.scenario.atAnchor&&h('div',{className:'space-y-1'},h('p',{className:'text-xs text-amber-500'},'Separate ledger-only cash scenario (not used in net worth):'),row('If all unallocated expenses used cash',usd(b.scenario.value)),row('If no unallocated expenses used cash',usd(b.scenario.withoutUnallocatedExpenses)),h('p',{className:'text-xs '+muted},'Uses recorded income and expenses only, assumes receipts entered cash, excludes verified credit spending. Does not account for transfers, repayments or unlogged movements; scenarios are not guaranteed bounds.'))),
        h('p',{className:'text-xs '+muted},'No use of investment cash-funded flags, work logs, savings goals, loan records or manual spot prices. Internal transfer suggestions remain unconfirmed.'));
    }catch(e){return h('p',{className:'text-xs text-rose-400 mt-2'},'Historical balance preview unavailable; original records unchanged.');}}
    return h('details',{open,onToggle:e=>setOpen(e.currentTarget.open)},h('summary',{className:'text-sm font-bold cursor-pointer '+title},'Historical cash & debt preview'),open?render():null);
  }
  const api={ANCHOR,validAnchor,readAnchor,build,combine,Preview};if(req)module.exports=api;else root.MoneyBuddyCashHistory=api;
})(typeof window==='undefined'?globalThis:window);
