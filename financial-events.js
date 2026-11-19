/* Stage 1D: derived, read-only financial event normalization.
 * Input: original core data. No writes, no network, no valuation or invented movements.
 * Monetary amounts retain original precision. Account deltas are NOT income/expense totals.
 */
(function(root){
  'use strict';
  const Dates=root.MoneyBuddyDates||(typeof module==='object'&&module.exports?require('./transaction-dates.js'):null);
  const ASSETS=Object.freeze({morpho:'morpho',sky:'sky',vvv:'venice-token',syrup:'syrup',mamo:'mamo'});
  const EXCLUDED=new Set(['yolo','dot','retardio','catwifmask']);
  const list=x=>Array.isArray(x)?x:[];
  const validId=x=>typeof x==='string'?x.trim().length>0:typeof x==='number'&&Number.isFinite(x);
  const id=x=>String(x);
  const money=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
  const centsEqual=(a,b)=>money(a)&&money(b)&&Math.abs(a-b)<1e-8;
  const keyOf=s=>typeof s==='string'?s.trim().toLowerCase():'';
  const dateEvidence=value=>Dates.validDay(value)?{day:value,kind:'recorded-calendar-day'}:typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Dates.calendarDay(value)?{day:Dates.calendarDay(value),kind:'timestamp-inferred-day'}:{day:null,kind:'unavailable'};
  const dayDistance=(a,b)=>a&&b?Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000):null;
  function addIndex(map,key,value){if(!map.has(key))map.set(key,[]);map.get(key).push(value);}
  function normalize(core){
    if(!core||typeof core!=='object'||!Dates)throw new Error('Financial event data unavailable.');
    const issues=[],ledger=[],investments=[],ignoredInvestments=[],accounts=[],accountMovements=[],linkIndex=new Map(),eventIndex=new Map(),accountIds=new Map(),movementIds=new Map();
    function issue(code,ref,detail){issues.push({code,ref,detail});}
    function track(map,key,record){addIndex(map,key,record);}
    for(const [source,kind] of [['oneTimeIncomes','income'],['expenses','expense']]){
      list(core[source]).forEach((r,i)=>{
        r=r||{};const ref=source+':'+i,d=dateEvidence(r.date),e={eventId:ref,source,recordId:validId(r.id)?r.id:null,kind,amount:money(r.amount)?r.amount:null,effectiveDay:d.day,dateEvidence:d.kind,originalDate:r.date??null,accountMovementIds:[],linkStatus:'unlinked',category:kind==='expense'?(r.category??null):null,sourceName:kind==='income'?(r.name??null):null};
        if(!e.effectiveDay)issue('invalid-ledger-date',ref); if(e.amount===null)issue('invalid-ledger-amount',ref); if(!validId(r.id))issue('missing-ledger-id',ref);else track(eventIndex,id(r.id),e);
        ledger.push(e);
      });
    }
    for(const e of eventIndex.values())if(e.length>1)for(const row of e)issue('duplicate-ledger-id',row.eventId);
    const invRows=list(core.investments),batches=Dates.batchDays(invRows.filter(r=>r&&typeof r==='object'));
    const investmentIds=new Map();
    invRows.forEach((r,i)=>{
      r=r||{};const ref='investments:'+i,asset=keyOf(r.asset),d=Dates.evidence(r,batches),included=Object.prototype.hasOwnProperty.call(ASSETS,asset),excluded=EXCLUDED.has(asset),e={eventId:ref,recordId:validId(r.id)?r.id:null,asset:r.asset??null,coinGeckoId:included?ASSETS[asset]:null,kind:r.type==='buy'?'investment-buy':r.type==='sell'?'investment-sell':'unknown',amount:money(r.amount)?r.amount:null,quantity:money(r.quantity)?r.quantity:null,dateEvidence:d,bankCashDelta:null,scope:included?'included':excluded?'excluded-by-user':'unmapped'};
      e.quantityDelta=e.quantity!==null&&e.kind!=='unknown'?(e.kind==='investment-buy'?e.quantity:-e.quantity):null;
      e.executionPrice=e.quantity!==null&&e.amount!==null?e.amount/e.quantity:null;
      if(!validId(r.id))issue('missing-investment-id',ref);else track(investmentIds,id(r.id),e);
      if(included){if(e.quantityDelta===null||e.amount===null)issue('invalid-investment',ref);if(d.kind==='unavailable')issue('invalid-investment-date',ref);investments.push(e);}else{ignoredInvestments.push(e);if(!excluded)issue('unmapped-investment',ref);}
    });
    for(const rows of investmentIds.values())if(rows.length>1)for(const row of rows)issue('duplicate-investment-id',row.eventId);
    list(core.cards).forEach((c,i)=>{
      c=c||{};const ref='cards:'+i,validType=['credit','debit'].includes(c.type),a={accountRef:ref,recordId:validId(c.id)?c.id:null,type:validType?c.type:'unknown',balance:typeof c.balance==='number'&&Number.isFinite(c.balance)?c.balance:null,addedDay:dateEvidence(c.createdAt).day,balanceObservationDay:null,movementIds:[]};
      if(!validType||a.balance===null)issue('invalid-account',ref);if(!validId(c.id))issue('missing-account-id',ref);else track(accountIds,id(c.id),a);
      accounts.push(a);
      // The original app treats missing credit payment type as repayment; explicit unknown types are flagged.
      const field=c.type==='credit'?'payments':'transactions';
      if(list(c[field==='payments'?'transactions':'payments']).length)issue('unexpected-account-activity-field',ref);
      list(c[field]).forEach((r,j)=>{
        r=r||{};const mref=ref+':'+field+':'+j,d=dateEvidence(r.date),amount=money(r.amount)?r.amount:null;
        let kind='unknown',sign=0;
        if(c.type==='debit'&&r.type==='deposit'){kind='cash-deposit';sign=1;}
        if(c.type==='debit'&&r.type==='withdrawal'){kind='cash-withdrawal';sign=-1;}
        if(c.type==='credit'&&r.type==='spend'){kind='credit-spend';sign=1;}
        if(c.type==='credit'&&(r.type===undefined||r.type===null||r.type==='payment')){kind='credit-payment';sign=-1;}
        const m={movementId:mref,accountRef:ref,recordId:validId(r.id)?r.id:null,accountRecordId:a.recordId,kind,amount,accountDelta:amount!==null&&sign?sign*amount:null,postingDay:d.day,originalDate:r.date??null,postingDateEvidence:d.kind,effectiveDay:d.day,effectiveDateEvidence:d.kind,linkId:r.linkId??null,ledgerEventId:null,linkStatus:'unlinked',dateDifferenceDays:null};
        if(m.accountDelta===null)issue('invalid-account-movement',mref);if(!d.day)issue('invalid-posting-date',mref);
        if(!validId(r.id))issue('missing-movement-id',mref);else track(movementIds,id(r.id),m);
        if(r.linkId!=null){if(validId(r.linkId))track(linkIndex,id(r.linkId),m);else{m.linkStatus='conflict';issue('invalid-link-id',mref);}}
        a.movementIds.push(mref);accountMovements.push(m);
      });
    });
    for(const rows of accountIds.values())if(rows.length>1)for(const a of rows)issue('duplicate-account-id',a.accountRef);
    for(const rows of movementIds.values())if(rows.length>1)for(const m of rows)issue('duplicate-movement-id',m.movementId);
    const compatible=(e,m)=>e.kind==='income'?m.kind==='cash-deposit':m.kind==='cash-withdrawal'||m.kind==='credit-spend';
    for(const [link,ms] of linkIndex){
      const es=eventIndex.get(link)||[],e=es[0],m=ms[0];
      const uniqueMovement=m.recordId!==null&&movementIds.get(id(m.recordId))?.length===1;
      const uniqueAccount=m.accountRecordId!==null&&accountIds.get(id(m.accountRecordId))?.length===1;
      const valid=ms.length===1&&es.length===1&&uniqueMovement&&uniqueAccount&&e.effectiveDay&&m.postingDay&&compatible(e,m)&&centsEqual(e.amount,m.amount);
      if(!valid){for(const row of ms){row.linkStatus='conflict';issue(es.length===0?'orphan-link':'conflicting-link',row.movementId);}for(const row of es)row.linkStatus='conflict';continue;}
      m.ledgerEventId=e.eventId;m.linkStatus='verified';m.effectiveDay=e.effectiveDay;m.effectiveDateEvidence='linked-ledger-date';m.dateDifferenceDays=dayDistance(e.effectiveDay,m.postingDay);
      e.accountMovementIds.push(m.movementId);e.linkStatus='verified';
    }
    // Exact same-amount matches are suggestions only. No automatic pairing, no projection mutation.
    const candidates=[],eligible=accountMovements.filter(m=>m.linkId===null&&m.linkStatus==='unlinked'&&m.amount!==null&&m.postingDay&&m.accountDelta!==null);
    const availableLedger=ledger.filter(e=>e.linkStatus==='unlinked'&&e.amount!==null&&e.effectiveDay);
    const ledgerByAmount=new Map(),movementByAmount=new Map();
    for(const e of availableLedger)addIndex(ledgerByAmount,String(e.amount),e);
    for(const m of eligible)addIndex(movementByAmount,String(m.amount),m);
    for(const m of eligible){
      const matches=(ledgerByAmount.get(String(m.amount))||[]).filter(e=>compatible(e,m)&&Math.abs(dayDistance(e.effectiveDay,m.postingDay))<=5);
      if(matches.length)candidates.push({kind:'possible-ledger-match',movementId:m.movementId,candidateIds:matches.map(e=>e.eventId),status:'unconfirmed'});
      if(m.kind==='cash-withdrawal'){
        const others=(movementByAmount.get(String(m.amount))||[]).filter(n=>n.accountRef!==m.accountRef&&(n.kind==='cash-deposit'||n.kind==='credit-payment')&&Math.abs(dayDistance(m.postingDay,n.postingDay))<=3);
        if(others.length)candidates.push({kind:'possible-internal-transfer',movementId:m.movementId,candidateIds:others.map(n=>n.movementId),status:'unconfirmed'});
      }
    }
    const verified=accountMovements.filter(m=>m.linkStatus==='verified');
    const sum=(rows,field)=>rows.reduce((a,r)=>a+(r[field]??0),0);
    const summary={incomeRecords:ledger.filter(e=>e.kind==='income').length,expenseRecords:ledger.filter(e=>e.kind==='expense').length,investmentIncluded:investments.length,investmentExcluded:ignoredInvestments.filter(e=>e.scope==='excluded-by-user').length,investmentUnmapped:ignoredInvestments.filter(e=>e.scope==='unmapped').length,accounts:accounts.length,accountMovements:accountMovements.length,verifiedLinks:verified.length,shiftedLinks:verified.filter(m=>m.dateDifferenceDays!==0).length,unlinkedMovements:accountMovements.filter(m=>m.linkStatus==='unlinked').length,conflictedMovements:accountMovements.filter(m=>m.linkStatus==='conflict').length,unlinkedLedger:ledger.filter(e=>e.linkStatus==='unlinked').length,possibleLedgerMatches:candidates.filter(c=>c.kind==='possible-ledger-match').length,possibleTransfers:candidates.filter(c=>c.kind==='possible-internal-transfer').length,issues:issues.length,incomeTotal:sum(ledger.filter(e=>e.kind==='income'),'amount'),expenseTotal:sum(ledger.filter(e=>e.kind==='expense'),'amount'),confirmedInvestmentDates:investments.filter(e=>e.dateEvidence.kind==='confirmed').length,inferredInvestmentDates:investments.filter(e=>e.dateEvidence.kind==='inferred').length,monthOnlyInvestmentDates:investments.filter(e=>e.dateEvidence.kind==='month-only').length};
    return {version:1,scope:{assets:{...ASSETS},excludedAssets:[...EXCLUDED],incomeSource:'oneTimeIncomes',ignored:['cashFunded','workLogs','goals','archivedGoals','loans','annualIncomeCategories','recurringExpenseRules','manualSpotPrices','moonwell']},ledger,investments,ignoredInvestments,accounts,accountMovements,candidates,issues,summary};
  }
  const api={normalize};if(typeof module==='object'&&module.exports)module.exports=api;else root.MoneyBuddyEvents=api;
})(typeof window==='undefined'?globalThis:window);
