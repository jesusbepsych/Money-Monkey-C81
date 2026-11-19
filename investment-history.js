/* Stage 2: read-only historical investment valuation. No storage writes or network.
 * California calendar day holdings; latest UTC midnight within day is next UTC date.
 * Inferred entry dates are provisional. Month-only records are never assigned a fake date.
 * Range is conditional on inferred dates and chosen price; not a statistical confidence interval.
 */
(function(root){
  'use strict';
  const req=typeof module==='object'&&module.exports;
  const Dates=root.MoneyBuddyDates||(req?require('./transaction-dates.js'):null);
  const Events=root.MoneyBuddyEvents||(req?require('./financial-events.js'):null);
  const Prices=root.MoneyBuddyPrices||(req?require('./historical-prices.js'):null);
  const DAY=86400000, EPS=1e-8;
  const assetNames=Object.freeze({morpho:'Morpho',sky:'SKY','venice-token':'VVV',syrup:'Syrup',mamo:'Mamo'});
  const positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
  const ms=d=>Date.parse(d+'T00:00:00Z');
  const iso=t=>new Date(t).toISOString().slice(0,10);
  const nextDay=(d,n=1)=>iso(ms(d)+n*DAY);
  const lastDay=m=>{const d=new Date(ms(m+'-01'));d.setUTCMonth(d.getUTCMonth()+1);return iso(d.getTime()-DAY);};
  const clean=n=>Math.abs(n)<EPS?0:n;
  const round=n=>n===null?null:Math.round((n+Number.EPSILON)*100)/100;
  function readObject(storage,key){try{const a=JSON.parse(storage.getItem(key));return a&&typeof a==='object'&&!Array.isArray(a)?a:{};}catch(_){return {};}}
  function readEvidence(storage){
    let daily=null,dailyInvalid=false;try{daily=Prices.read(storage);}catch(_){dailyInvalid=true;}
    const archived=readObject(storage,'mm-stage1a-legacy-price-cache');let old={};try{if(archived.version===1)old=JSON.parse(archived.values['cg-hist'])||{};}catch(_){}
    return {daily,dailyInvalid,monthly:readObject(storage,'cg-hist'),archivedMonthly:old};
  }
  function validLibrary(d){if(!d)return {};Prices.validate(d);return d.observations;}
  function dayPrice(obs,id,day){const utcDay=nextDay(day);const tuple=obs[id]?.[utcDay];return positive(tuple?.[0])?{price:tuple[0],observedAt:utcDay+'T00:00:00.000Z',retrievedAt:new Date(tuple[1]).toISOString(),source:'coingecko',kind:'daily',localDay:day}:null;}
  // Strict matching heuristic: all days of the recorded month must have data; best price
  // within 3%, all candidates within 5%, narrow 3-day span. Only a suggestion, never confirmation.
  function matchExecution(e,obs,today){
    const m=e.dateEvidence.month;if(!m||!positive(e.executionPrice)||lastDay(m)>=today)return null;
    const candidates=[];let best=null;
    for(let day=m+'-01';day<=lastDay(m);day=nextDay(day)){
      const p=dayPrice(obs,e.coinGeckoId,day);if(!p)return null;
      const error=Math.abs(p.price-e.executionPrice)/e.executionPrice;
      if(!best||error<best.error)best={day,error};if(error<=.05)candidates.push(day);
    }
    if(!best||best.error>.03||!candidates.length||ms(candidates.at(-1))-ms(candidates[0])>2*DAY)return null;
    return {first:candidates[0],last:candidates.at(-1),best:best.day,relativeError:best.error,kind:'price-match-suggestion'};
  }
  function priceFor(id,day,obs,evidence,events,today){
    const exact=dayPrice(obs,id,day);if(exact)return exact;
    for(let i=1;i<=3;i++){const p=dayPrice(obs,id,nextDay(day,-i));if(p)return {...p,kind:'nearby-daily',daysOld:i};}
    const m=day.slice(0,7),d=new Date(ms(day)),key=id+'-'+d.getUTCFullYear()+'-'+d.getUTCMonth();
    if(lastDay(m)<today){
      for(const [cache,source] of [[evidence.monthly,'legacy-monthly-cache'],[evidence.archivedMonthly,'preserved-monthly-archive']]){
        if(positive(cache?.[key]))return {kind:'monthly-average',price:cache[key],source,month:m,observedAt:null};
      }
    }
    // Execution price is not a market quote. Only dated observations at or before target;
    // use median on the freshest available day and mark the result estimated.
    const eligible=events.filter(e=>['confirmed','inferred'].includes(e.dateEvidence.kind)&&e.dateEvidence.day<=day&&ms(day)-ms(e.dateEvidence.day)<=3*DAY&&positive(e.executionPrice));
    if(eligible.length){const recent=eligible.map(e=>e.dateEvidence.day).sort().at(-1);const rows=eligible.filter(e=>e.dateEvidence.day===recent);const values=rows.map(e=>e.executionPrice).sort((a,b)=>a-b);const i=Math.floor(values.length/2);const price=values.length%2?values[i]:(values[i-1]+values[i])/2;return {kind:'execution-estimate',price,source:'recorded-trades',localDay:recent,observedAt:null,recordIds:rows.map(e=>e.recordId),inferredTradeDates:rows.some(e=>e.dateEvidence.kind==='inferred')};}
    return null;
  }
  function build(core,evidence={},now=new Date()){
    const today=Dates.calendarDay(now);if(!today)throw Error('Invalid valuation clock');
    const normalized=Events.normalize(core), obs=validLibrary(evidence.daily);
    const events=normalized.investments.map(e=>({...e,match:e.dateEvidence.kind==='month-only'?matchExecution(e,obs,today):null}));
    const months=events.map(e=>e.dateEvidence.month).filter(Boolean).sort();
    const first=months.length?months[0]+'-01':null;
    const invalidRefs=new Set(normalized.issues.filter(i=>['invalid-investment','invalid-investment-date','duplicate-investment-id','missing-investment-id'].includes(i.code)).map(i=>i.ref));
    const scopedIssues=events.filter(e=>invalidRefs.has(e.eventId));
    function valueAt(day){
      if(!Dates.validDay(day)||day>=today||!first||day<first)throw Error('Select a completed California date within recorded investment history.');
      const rows=[];
      for(const [id,name] of Object.entries(assetNames)){
        const trades=events.filter(e=>e.coinGeckoId===id);let fixed=0, minDelta=0,maxDelta=0, matchedDelta=0, unresolved=0, inferred=0, uncertain=0, matched=0, monthOnlyIncluded=0;
        const invalid=scopedIssues.filter(e=>e.coinGeckoId===id&&(!e.dateEvidence.month||e.dateEvidence.month<=day.slice(0,7)));
        for(const e of trades){
          const d=e.dateEvidence;if(invalidRefs.has(e.eventId)||!d.month||d.month>day.slice(0,7))continue;
          if(d.kind==='confirmed'||d.kind==='inferred'){
            // An inferred date on either side of an intra-month cutoff is material evidence,
            // even if the transaction isn't included in the provisional holding.
            if(d.kind==='inferred'&&(d.day<=day||d.month===day.slice(0,7)))inferred++;
            if(d.day<=day)fixed+=e.quantityDelta;
          }else if(d.kind==='month-only'){
            if(lastDay(d.month)<=day){fixed+=e.quantityDelta;monthOnlyIncluded++;}
            else{uncertain++;minDelta+=Math.min(0,e.quantityDelta);maxDelta+=Math.max(0,e.quantityDelta);
              if(e.match&&e.match.last<=day){matchedDelta+=e.quantityDelta;matched++;}
              else if(e.match&&e.match.first>day){matched++;}
              else unresolved++;
            }
          }
        }
        let lo=clean(fixed+minDelta),hi=clean(fixed+maxDelta),q=unresolved?null:clean(fixed+matchedDelta);
        const reasons=[];if(invalid.length)reasons.push('Invalid or duplicate included records');
        if(hi<0){reasons.push('Recorded quantities are negative at this date');lo=hi=q=null;}
        else if(lo<0){lo=0;reasons.push('Some month-only ordering scenarios would imply negative holdings');}
        if(q!==null&&q<0){q=null;reasons.push('Provisional dates imply negative holdings');}
        if(invalid.length)lo=hi=q=null;
        const price=hi===0?null:priceFor(id,day,obs,evidence,trades.filter(e=>!invalidRefs.has(e.eventId)),today);
        if(hi!==null&&hi>0&&!price)reasons.push('No supported price for this date');
        const val=n=>n===null?null:n===0?0:price&&Number.isFinite(n*price.price)?n*price.price:null;
        const v=val(q), low=val(lo), high=val(hi);
        const quality=v===null?'unavailable':uncertain||reasons.length||(price&&price.kind!=='daily')?'estimated':inferred?'reconstructed':'supported';
        rows.push({id,name,quantity:q,minQuantity:lo,maxQuantity:hi,value:round(v),minValue:round(low),maxValue:round(high),rawValue:v,rawMinValue:low,rawMaxValue:high,price,quality,inferred,uncertain,matched,unresolved,monthOnlyIncluded,reasons});
      }
      const sum=key=>rows.every(r=>r[key]!==null)?round(rows.reduce((s,r)=>s+r[key],0)):null;
      const total=sum('rawValue'),minValue=sum('rawMinValue'),maxValue=sum('rawMaxValue');
      return {day,total,minValue,maxValue,quality:total===null?'unavailable':rows.some(r=>r.quality==='estimated')?'estimated':rows.some(r=>r.quality==='reconstructed')?'reconstructed':'supported',assets:rows,missingAssets:rows.filter(r=>r.value===null).map(r=>r.name),knownSubtotal:round(rows.reduce((s,r)=>s+(r.rawValue??0),0))};
    }
    return {first,last:nextDay(today,-1),events,summary:{included:events.length,excluded:normalized.summary.investmentExcluded,unmapped:normalized.summary.investmentUnmapped,confirmed:normalized.summary.confirmedInvestmentDates,inferred:normalized.summary.inferredInvestmentDates,monthOnly:normalized.summary.monthOnlyInvestmentDates,priceMatchSuggestions:events.filter(e=>e.match).length,invalid:scopedIssues.length,dailyInvalid:!!evidence.dailyInvalid},valueAt};
  }
  // React diagnostic component. No data mutation and no API calls.
  function Preview({core,darkMode,storage}){
    const React=root.React,h=React.createElement;
    const [chosen,setChosen]=React.useState('');const [open,setOpen]=React.useState(false);
    const muted=darkMode?'text-gray-400':'text-gray-600', title=darkMode?'text-purple-300':'text-purple-700';
    const usd=x=>x===null?'Unavailable':x.toLocaleString('en-US',{style:'currency',currency:'USD'});
    const qty=x=>x===null?'—':x.toLocaleString('en-US',{maximumFractionDigits:8});
    function render(){try{
      const model=build(core,readEvidence(storage));if(!model.first||model.first>model.last)return h('p',{className:'text-xs mt-2 '+muted},'No completed historical investment dates available.');
      const day=chosen&&chosen>=model.first&&chosen<=model.last?chosen:model.last, x=model.valueAt(day);
      const status={supported:'Supported by recorded dates',reconstructed:'Reconstructed · provisional dates',estimated:'Estimated · some evidence is uncertain',unavailable:'Complete estimate unavailable'};
      const range=x.minValue!==null&&x.maxValue!==null&&x.minValue!==x.maxValue?usd(x.minValue)+' – '+usd(x.maxValue):null;
      return h('div',{className:'mt-3 space-y-3'},
        h('p',{className:'text-xs '+muted},'Investment-only preview · California calendar dates · no cash, debt or changes to the net worth chart.'),
        h('label',{className:'block text-xs '+muted},'Historical valuation date',h('input',{type:'date',min:model.first,max:model.last,value:day,onChange:e=>setChosen(e.target.value),className:'block w-full mt-1 p-2 rounded-lg border '+(darkMode?'bg-gray-800 border-gray-600 text-white':'bg-white border-gray-300 text-gray-900')})),
        h('div',{className:'p-3 rounded-xl '+(darkMode?'bg-purple-900/20':'bg-purple-50')},h('p',{className:'text-xs '+muted},'Historical portfolio value'),h('p',{className:'text-xl font-bold '+(x.total===null?'text-amber-500':'text-emerald-500')},usd(x.total)),h('p',{className:'text-xs '+muted},status[x.quality]),range&&h('p',{className:'text-xs mt-1 text-amber-500'},'Conditional quantity range: '+range),x.total===null&&h('p',{className:'text-xs mt-1 '+muted},'Priced point-estimate subtotal only: '+usd(x.knownSubtotal)+' (not total).')),
        ...x.assets.map(a=>h('div',{key:a.id,className:'border-b pb-2 '+(darkMode?'border-gray-700':'border-gray-200')},h('div',{className:'flex justify-between gap-2 text-sm font-semibold '+title},h('span',null,a.name),h('span',null,usd(a.value))),h('p',{className:'text-xs '+muted},'Quantity: '+qty(a.quantity)+(a.minQuantity!==null&&a.maxQuantity!==null&&a.minQuantity!==a.maxQuantity?' · possible '+qty(a.minQuantity)+' – '+qty(a.maxQuantity):'')),h('p',{className:'text-xs '+muted},a.price?('Price: $'+a.price.price.toLocaleString('en-US',{maximumFractionDigits:10})+' · '+({daily:'CoinGecko observation', 'nearby-daily':'Earlier CoinGecko observation','monthly-average':'Estimated monthly average','execution-estimate':'Estimated execution price'}[a.price.kind])+' · '+(a.price.observedAt||a.price.month||a.price.localDay||'')):a.maxQuantity===0?'No recorded holding; no price needed.':'Price unavailable'),(a.inferred||a.uncertain)?h('p',{className:'text-xs text-amber-500'},a.inferred+' provisional date(s); '+a.uncertain+' month-only crossing cutoff; '+a.matched+' price-matched suggestions.'):null,...a.reasons.map(r=>h('p',{key:r,className:'text-xs text-amber-500'},r)))),
        h('p',{className:'text-xs '+muted},model.summary.included+' included trades · '+model.summary.excluded+' excluded and preserved · '+model.summary.unmapped+' unmapped · '+model.summary.priceMatchSuggestions+' price-match suggestions across history.'),
        model.summary.dailyInvalid&&h('p',{className:'text-xs text-amber-500'},'Daily library could not be validated; fallback prices may be used.'),
        h('p',{className:'text-xs '+muted},'A local-day observation uses the UTC midnight within that California day, not its closing price. Ranges vary month-only timing while holding inferred entry dates and selected prices fixed; they are not guaranteed bounds. No dates are rewritten. Only the five agreed assets are valued.'));
    }catch(_){return h('p',{className:'text-xs text-rose-400 mt-2'},'Historical portfolio preview unavailable. Original records are unchanged.');}}
    return h('details',{open,onToggle:e=>setOpen(e.currentTarget.open)},h('summary',{className:'text-sm font-bold cursor-pointer '+title},'Historical investment preview'),open?render():null);
  }
  const api={build,readEvidence,Preview,matchExecution};if(req)module.exports=api;else root.MoneyBuddyInvestmentHistory=api;
})(typeof window==='undefined'?globalThis:window);
