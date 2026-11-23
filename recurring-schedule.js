/* Money Monkey Stage 6.4 — recurring expense cadence helpers.
 * Legacy recurring entries without a frequency continue to be monthly.
 * ISO calendar-day math uses UTC days to avoid DST off-by-one errors.
 * No records are migrated or rewritten by this module.
 */
(function(root){
 'use strict';
 const DAY=86400000;
 const valid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T12:00:00Z'))&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d;
 const parse=d=>Date.parse(d+'T00:00:00Z');
 const iso=ms=>new Date(ms).toISOString().slice(0,10);
 const freq=r=>['monthly','biweekly','yearly'].includes(r&&r.frequency)?r.frequency:'monthly';
 function monthlyDay(r){const n=Number(r&&r.dayOfMonth);return Number.isInteger(n)?Math.max(1,Math.min(31,n)):1;}
 function nthDay(y,m,d){return iso(Date.UTC(y,m,Math.min(d,new Date(Date.UTC(y,m+1,0)).getUTCDate())));}
 function occurrence(r,day){
   if(!valid(day)||!r)return false;
   const f=freq(r),today=new Date(day+'T12:00:00Z');
   if(f==='monthly')return day===nthDay(today.getUTCFullYear(),today.getUTCMonth(),monthlyDay(r));
   if(!valid(r.startDate)||day<r.startDate)return false;
   if(f==='biweekly')return (parse(day)-parse(r.startDate))/DAY%14===0;
   const anchor=new Date(r.startDate+'T12:00:00Z');
   return day===nthDay(today.getUTCFullYear(),anchor.getUTCMonth(),anchor.getUTCDate());
 }
 function nextDue(r,from){
   if(!valid(from)||!r)return null;
   const f=freq(r),start=new Date(from+'T12:00:00Z');
   if(f==='monthly'){
     let y=start.getUTCFullYear(),m=start.getUTCMonth(),date=nthDay(y,m,monthlyDay(r));
     return date>=from?date:nthDay(y,m+1,monthlyDay(r));
   }
   if(!valid(r.startDate))return null;
   if(f==='biweekly'){
     if(from<=r.startDate)return r.startDate;
     const n=Math.ceil((parse(from)-parse(r.startDate))/(14*DAY));
     return iso(parse(r.startDate)+n*14*DAY);
   }
   const anchor=new Date(r.startDate+'T12:00:00Z'),m=anchor.getUTCMonth(),d=anchor.getUTCDate();
   let y=Math.max(start.getUTCFullYear(),anchor.getUTCFullYear());
   let date=nthDay(y,m,d);
   if(date<from||date<r.startDate)date=nthDay(y+1,m,d);
   return date;
 }
 function inMonth(r,year,month){
   if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)return [];
   const first=nthDay(year,month-1,1),last=nthDay(year,month-1,31),dates=[];
   let current=nextDue(r,first),guard=0;
   while(current&&current<=last&&guard++<4){dates.push(current);current=nextDue(r,iso(parse(current)+DAY));}
   return dates;
 }
 function monthlyEquivalent(r){const amount=Number(r&&r.amount);if(!Number.isFinite(amount)||amount<0)return 0;
   return freq(r)==='biweekly'?amount*26/12:freq(r)==='yearly'?amount/12:amount;
 }
 function label(r){return freq(r)==='biweekly'?'Biweekly':freq(r)==='yearly'?'Yearly':'Monthly';}
 const api={valid,freq,occurrence,nextDue,inMonth,monthlyEquivalent,label};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.MoneyBuddyRecurring=api;
})(typeof window==='undefined'?globalThis:window);
