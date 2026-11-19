/* Stage 1B — Date evidence, not a historical valuation engine.
 * Legacy month/year and date (entry timestamp) remain intact, and inference is read-only.
 */
(function(root){
  'use strict';
  const TIME_ZONE='America/Los_Angeles';
  const fmt=new Intl.DateTimeFormat('en-US',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit'});
  function calendarDay(value){
    if(value==null || value==='') return null;
    const d=value instanceof Date?value:new Date(value);
    if(!Number.isFinite(d.getTime())) return null;
    const p=Object.fromEntries(fmt.formatToParts(d).map(x=>[x.type,x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  function validDay(v){
    if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))return false;
    const d=new Date(v+'T00:00:00Z');
    return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;
  }
  function monthKey(year,month){return Number.isInteger(year)&&year>=1000&&year<=9999&&Number.isInteger(month)&&month>=0&&month<12?`${year}-${String(month+1).padStart(2,'0')}`:null;}
  function batchDays(records){
    const counts=new Map();
    for(const r of records){
      const day=calendarDay(r.date), m=monthKey(r.year,r.month);
      if(!day||!m)continue;
      const c=counts.get(day)||{total:0,mismatch:0}; c.total++; if(day.slice(0,7)!==m)c.mismatch++; counts.set(day,c);
    }
    // Conservative generic heuristic: large entry session containing backdated records.
    return new Set([...counts].filter(([,c])=>c.total>=20&&c.mismatch>0).map(([day])=>day));
  }
  function evidence(r,batches=new Set()){
    const month=monthKey(r.year,r.month), enteredDay=calendarDay(r.date);
    const base={month,enteredDay,timeZone:TIME_ZONE};
    if(r.transactionDatePrecision==='day'&&validDay(r.transactionDate)&&r.transactionDate.slice(0,7)===month)
      return {...base,kind:'confirmed',day:r.transactionDate,reason:'user-entered-date'};
    if(!month)return {...base,kind:'unavailable',day:null,reason:'invalid-month'};
    if(r.transactionDatePrecision==='month')return {...base,kind:'month-only',day:null,reason:'explicit-month-only'};
    if(r.transactionDatePrecision!==undefined||r.transactionDate!==undefined)return {...base,kind:'month-only',day:null,reason:'invalid-date-metadata'};
    if(!enteredDay||enteredDay.slice(0,7)!==month)return {...base,kind:'month-only',day:null,reason:'entry-month-mismatch'};
    if(batches.has(enteredDay))return {...base,kind:'month-only',day:null,reason:'retrospective-entry-batch'};
    return {...base,kind:'inferred',day:enteredDay,reason:'entry-day-matches-month'};
  }
  const today=()=>calendarDay(new Date());
  function fields(day,year,month){
    const key=monthKey(year,month);
    if(!key)throw new Error('Choose a valid month and year.');
    if(day){if(!validDay(day)||day.slice(0,7)!==key||day>today())throw new Error('Choose a valid transaction date in the selected month, no later than today.');return {transactionDate:day,transactionDatePrecision:'day'};}
    return {transactionDate:null,transactionDatePrecision:'month'};
  }
  function validate(r){
    if(r.transactionDatePrecision===undefined&&r.transactionDate===undefined)return true;
    if(r.transactionDatePrecision==='month')return r.transactionDate===null;
    return r.transactionDatePrecision==='day'&&validDay(r.transactionDate)&&r.transactionDate.slice(0,7)===monthKey(r.year,r.month);
  }
  function saveRecord(old,values,day,dateTouched,now=new Date()){
    const monthChanged=old&&(old.month!==values.month||old.year!==values.year);
    const metadata=!old||dateTouched||monthChanged?fields(day,values.year,values.month):{};
    return {...(old||{id:now.getTime(),date:now}),...values,...metadata};
  }
  function duplicate(r,now=new Date()){
    const day=calendarDay(now);
    return {...r,id:now.getTime(),date:now,month:Number(day.slice(5,7))-1,year:Number(day.slice(0,4)),transactionDate:null,transactionDatePrecision:'month'};
  }
  const api={TIME_ZONE,calendarDay,validDay,monthKey,batchDays,evidence,today,fields,validate,saveRecord,duplicate};
  if(typeof module==='object'&&module.exports)module.exports=api; else root.MoneyBuddyDates=api;
})(typeof window==='undefined'?globalThis:window);
