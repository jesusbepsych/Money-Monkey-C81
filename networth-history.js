/* Stage 4: shared historical timeline and current scoped valuation. Read-only.
 * Stable 14-day Saturday grid anchored 2025-11-01; monthly = calendar month end.
 * Historical range-only values never get a fabricated midpoint; gaps are not zero.
 */
(function(root){
  'use strict';
  const req=typeof module==='object'&&module.exports;
  const Dates=root.MoneyBuddyDates||(req?require('./transaction-dates.js'):null);
  const Events=root.MoneyBuddyEvents||(req?require('./financial-events.js'):null);
  const Investment=root.MoneyBuddyInvestmentHistory||(req?require('./investment-history.js'):null);
  const Cash=root.MoneyBuddyCashHistory||(req?require('./cash-debt-history.js'):null);
  const DAY=86400000, GRID=Date.parse('2025-11-01T00:00:00Z'), EPS=1e-8;
  const names={morpho:'Morpho',sky:'SKY','venice-token':'VVV',syrup:'Syrup',mamo:'Mamo'};
  const ms=d=>Date.parse(d+'T00:00:00Z'), iso=t=>new Date(t).toISOString().slice(0,10);
  const finite=n=>typeof n==='number'&&Number.isFinite(n), positive=n=>finite(n)&&n>0;
  const round=n=>finite(n)?Math.round((n+Number.EPSILON)*100)/100:null;
  const usd=n=>finite(n)?n.toLocaleString('en-US',{style:'currency',currency:'USD'}):'Unavailable';
  const dateLabel=d=>new Date(ms(d)).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric',year:'numeric'});
  function timeline(first,today,mode){
    if(!Dates.validDay(first)||!Dates.validDay(today)||first>today)throw Error('Invalid timeline');
    const a=ms(first),b=ms(today), dates=[];
    if(mode==='monthly'){
      const d=new Date(a);let next=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-DAY;
      while(next<b){dates.push(iso(next));const p=new Date(next);next=Date.UTC(p.getUTCFullYear(),p.getUTCMonth()+2,1)-DAY;}
    }else if(mode==='biweekly'){
      for(let t=GRID+Math.ceil((a-GRID)/(14*DAY))*14*DAY;t<b;t+=14*DAY)dates.push(iso(t));
    }else throw Error('Invalid timeline interval');
    dates.push(today);return dates;
  }
  function readSpot(storage){try{return {prices:JSON.parse(storage.getItem('cg-spot')||'{}'),timestamp:storage.getItem('cg-ts')};}catch(_){return {prices:{},timestamp:null};}}
  // Live holdings = recorded transactions through today, including already entered month-only
  // records in current month. Future explicitly dated transactions and future months excluded.
  // Spot timestamps are retrieval timestamps, not exchange execution timestamps.
  function currentInvestments(core,evidence,spot,now){
    const today=Dates.calendarDay(now), n=Events.normalize(core), clock=+now;
    const bad=new Set(n.issues.filter(x=>['invalid-investment','invalid-investment-date','duplicate-investment-id','missing-investment-id'].includes(x.code)).map(x=>x.ref));
    const ts=typeof spot?.timestamp==='string'?Date.parse(spot.timestamp):NaN;
    const usableStamp=Number.isFinite(ts)&&ts<=clock;
    const assets=Object.entries(names).map(([id,name])=>{
      let quantity=0,invalid=false,monthOnly=0,inferred=0;
      for(const e of n.investments.filter(e=>e.coinGeckoId===id)){
        const d=e.dateEvidence;
        if(d.month&&d.month>today.slice(0,7))continue;
        if(d.day&&d.day>today)continue;
        if(bad.has(e.eventId)||!d.month||!finite(e.quantityDelta)){invalid=true;continue;}
        quantity+=e.quantityDelta;if(d.kind==='month-only'&&d.month===today.slice(0,7))monthOnly++;if(d.kind==='inferred'&&d.month===today.slice(0,7))inferred++;
      }
      if(Math.abs(quantity)<EPS)quantity=0;if(quantity<0)invalid=true;
      let price=null;
      if(!invalid&&quantity>0){
        if(usableStamp&&positive(spot.prices?.[id]))price={price:spot.prices[id],kind:clock-ts>DAY?'stale-spot':'spot',observedAt:new Date(ts).toISOString(),age:clock-ts};
        // If spot is stale/missing, prefer a more recent valid daily observation (up to 3 days).
        const observations=evidence.daily?.observations?.[id]||{};
        const day=Object.keys(observations).filter(d=>Dates.validDay(d)&&ms(d)<=clock&&clock-ms(d)<=3*DAY&&positive(observations[d]?.[0])&&observations[d][1]<=clock).sort().at(-1);
        if(day&&(!price||price.kind==='stale-spot'&&ms(day)>ts))price={price:observations[day][0],kind:'cached-daily',observedAt:new Date(ms(day)).toISOString(),age:clock-ms(day)};
      }
      return {id,name,quantity:invalid?null:quantity,value:invalid?null:quantity===0?0:price?round(quantity*price.price):null,price,monthOnly,inferred,invalid};
    });
    const total=assets.every(a=>a.value!==null)?round(assets.reduce((s,a)=>s+a.value,0)):null;
    return {day:today,total,minValue:total,maxValue:total,assets,knownSubtotal:round(assets.reduce((s,a)=>s+(a.value??0),0)),quality:total===null?'unavailable':assets.some(a=>a.price&&a.price.kind!=='spot'||a.monthOnly||a.inferred)?'estimated':'current',excluded:n.summary.investmentExcluded,unmapped:n.summary.investmentUnmapped};
  }
  function build(core,evidence,spot,{anchor=null,now=new Date()}={}){
    const today=Dates.calendarDay(now), inv=Investment.build(core,evidence,now), cash=Cash.build(core,{anchor,now});
    const first=[inv.first,cash.first].filter(d=>d&&d<=today).sort()[0]||today;
    const liveInv=currentInvestments(core,evidence,spot,now),liveBalances=cash.valueAt(today);
    const cache=new Map();
    function at(day){
      if(cache.has(day))return cache.get(day);
      if(!Dates.validDay(day)||day<first||day>today)throw Error('Date outside history');
      const live=day===today;
      const i=live?liveInv:inv.first&&day>=inv.first?inv.valueAt(day):{day,total:null,minValue:null,maxValue:null,quality:'unavailable',assets:[],knownSubtotal:0};
      const b=day>=cash.first?cash.valueAt(day):{day,cash:{value:null,knownSubtotal:0,covered:0,count:0},debt:{value:null,knownSubtotal:0,covered:0,count:0},netLiquid:null,quality:'unavailable',accounts:[]};
      const c=Cash.combine(i,b), range=c.minValue!==null&&c.maxValue!==null&&c.minValue!==c.maxValue;
      const quality=c.total===null?(range?'range':'unavailable'):live?(i.quality==='estimated'?'estimated-current':'current'):i.quality==='estimated'||range||b.negativeAccounts||b.cutoffDifferences?'estimated':'reconstructed';
      const row={...c,live,quality,range,day,stamp:ms(day)};cache.set(day,row);return row;
    }
    return {first,today,live:at(today),at,series:mode=>timeline(first,today,mode).map(at),scope:{excluded:liveInv.excluded,unmapped:liveInv.unmapped},latestFull:cash.latestFull};
  }
  const statuses={current:'Current saved balances · retrieved spot prices','estimated-current':'Current estimate · provisional holdings or cached prices',reconstructed:'Reconstructed from recorded activity',estimated:'Estimated · uncertain prices, dates or account activity',range:'Conditional valuation range',unavailable:'Incomplete evidence · no total'};
  const formatter=x=>x.total!==null?usd(x.total):x.range?usd(x.minValue)+' – '+usd(x.maxValue):'Unavailable';
  const asRange=(x,lo,hi)=>finite(x)?usd(x):finite(lo)&&finite(hi)?usd(lo)+' – '+usd(hi):'Unavailable';
  function Chart({rows,selected,onSelect,darkMode,full}){
    const h=root.React.createElement;
    const width=680,height=full?300:258,L=74,R=18,T=18,B=61, bottom=height-B;
    const vals=rows.flatMap(r=>[r.total,r.minValue,r.maxValue].filter(finite));
    let lo=vals.length?Math.min(...vals):0,hi=vals.length?Math.max(...vals):1;
    const span=Math.max(hi-lo,Math.abs(hi)*.08,100);lo-=span*.12;hi+=span*.12;
    const first=rows[0].stamp,last=rows.at(-1).stamp;
    const x=r=>first===last?(L+width-R)/2:L+(r.stamp-first)/(last-first)*(width-L-R);
    const y=n=>bottom-(n-lo)/(hi-lo)*(bottom-T);
    const muted=darkMode?'#9ca3af':'#6b6789',grid=darkMode?'#3D3A4E':'#E8E4EE';
    const color=r=>r.quality==='reconstructed'||r.quality==='current'?'#10b981':'#f59e0b';
    let runs=[],run=[];for(const r of rows){if(finite(r.total))run.push(r);else{if(run.length)runs.push(run);run=[];}}if(run.length)runs.push(run);
    const labels=[...new Set([0,Math.round((rows.length-1)/4),Math.round((rows.length-1)/2),Math.round((rows.length-1)*3/4),rows.length-1])];
    return h('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':'Net worth history. Gaps indicate unavailable totals. Select a date below for details.',style:{width:'100%',height:'auto',display:'block',touchAction:'pan-y'}},
      ...Array.from({length:5},(_,i)=>{const v=lo+(hi-lo)*i/4;return h('g',{key:'g'+i},h('line',{x1:L,x2:width-R,y1:y(v),y2:y(v),stroke:grid,strokeDasharray:'3 4'}),h('text',{x:L-8,y:y(v)+4,textAnchor:'end',fontSize:12,fill:muted},Math.abs(v)>=1000?'$'+(v/1000).toFixed(1)+'k':usd(v).split('.')[0]));}),
      ...runs.filter(r=>r.length>1).map((r,i)=>h('polyline',{key:'run'+i,points:r.map(p=>`${x(p)},${y(p.total)}`).join(' '),fill:'none',stroke:'#10b981',strokeWidth:2.5,strokeLinejoin:'round'})),
      ...rows.map((r,i)=>h('g',{key:r.day},r.day===selected&&h('line',{x1:x(r),x2:x(r),y1:T,y2:bottom+17,stroke:muted,strokeDasharray:'4 4'}),r.range&&h('g',{stroke:'#f59e0b',strokeWidth:2},h('line',{x1:x(r),x2:x(r),y1:y(r.minValue),y2:y(r.maxValue)}),...([r.minValue,r.maxValue].map((v,j)=>h('line',{key:j,x1:x(r)-4,x2:x(r)+4,y1:y(v),y2:y(v)})))),finite(r.total)?h('circle',{cx:x(r),cy:y(r.total),r:r.day===selected?6:r.live?5:3.5,fill:color(r),stroke:darkMode?'#1E1B2E':'#fff',strokeWidth:1.5}):!r.range?h('g',{stroke:muted,strokeWidth:r.day===selected?2.5:1.5},h('line',{x1:x(r)-3,x2:x(r)+3,y1:bottom+8,y2:bottom+14}),h('line',{x1:x(r)+3,x2:x(r)-3,y1:bottom+8,y2:bottom+14})):null,
      h('rect',{x:i===0?L-8:(x(rows[i-1])+x(r))/2,y:T,width:Math.max(1,(i===rows.length-1?width-R+8:(x(rows[i+1])+x(r))/2)-(i===0?L-8:(x(rows[i-1])+x(r))/2)),height:bottom-T+18,fill:'transparent',onClick:()=>onSelect(r.day),style:{cursor:'pointer'}}))),
      ...labels.map(i=>h('text',{key:'label'+i,x:x(rows[i]),y:height-15,fontSize:11,fill:muted,textAnchor:i===0?'start':i===rows.length-1?'end':'middle'},rows[i].live?'Now':new Date(rows[i].stamp).toLocaleDateString('en-US',{timeZone:'UTC',month:'short',day:'numeric'}))));
  }
  function Panel({core,storage,darkMode,mode,onMode,selected,onSelect,onRefresh,refreshing,refreshWarning,full=false,onFullscreen}){
    const React=root.React,h=React.createElement;
    const muted=darkMode?'text-gray-400':'text-gray-600', title=darkMode?'text-purple-300':'text-purple-700';
    const border=darkMode?'border-[#3D3A4E]':'border-gray-200',box=darkMode?'bg-purple-900/20':'bg-purple-50';
    let model,rows;try{model=build(core,Investment.readEvidence(storage),readSpot(storage),{anchor:Cash.readAnchor(storage)});rows=model.series(mode);}catch(_){return h('p',{className:'text-sm text-rose-500'},'Net worth history could not be reconstructed. Original records are unchanged.');}
    const live=model.live, pick=rows.find(r=>r.day===selected)||rows.at(-1), pi=rows.indexOf(pick);
    const count={points:rows.filter(r=>finite(r.total)).length,ranges:rows.filter(r=>r.total===null&&r.range).length,gaps:rows.filter(r=>r.quality==='unavailable').length};
    const button=(label,click,active,disabled)=>h('button',{type:'button',onClick:click,disabled:!!disabled,'aria-pressed':active===undefined?undefined:active,className:'px-3 py-2 text-xs rounded-lg font-bold '+(active?'bg-purple-600 text-white':darkMode?'bg-[#302940] text-purple-300':'bg-purple-100 text-purple-700'),style:{opacity:disabled?.5:1,minHeight:'36px',minWidth:'36px'}},label);
    const small=(label,val,col,tint)=>h('div',{className:'shimmer-card p-3 rounded-2xl border text-center '+border,style:{backgroundColor:tint+'0d',borderColor:tint+'40'}},h('p',{className:'text-xs '+muted},label),h('p',{className:'text-xl font-bold '+col},usd(val)));
    const row=(label,value)=>h('div',{className:'flex justify-between gap-3 text-sm'},h('span',{className:muted},label),h('span',{className:'font-semibold text-right'},value));
    const switchMode=m=>{onMode(m);onSelect(null);};
    const assetTotal=finite(live.balances.cash.value)&&finite(live.investment.total)?live.balances.cash.value+live.investment.total:null;
    return h('div',{className:'space-y-3',style:full?{maxHeight:'100%',overflowY:'auto',overscrollBehavior:'contain'}:undefined},
      !full&&h(React.Fragment,null,h('div',{className:'grid grid-cols-2 gap-3'},small('Checking / savings',live.balances.cash.value,'text-emerald-500','#10b981'),small('Investments',live.investment.total,'text-blue-500','#3b82f6'),small('Debt',live.balances.debt.value,'text-rose-500','#f43f5e'),small('Net Worth',live.total,live.total===null||live.quality==='estimated-current'?'text-amber-500':live.total<0?'text-rose-500':'text-emerald-500',live.total===null||live.quality==='estimated-current'?'#f59e0b':live.total<0?'#f43f5e':'#10b981')),
      h('div',{className:'flex justify-between gap-2 items-center'},h('p',{className:'text-xs '+muted},statuses[live.quality]+'. Only the five agreed assets. Balances not bank-verified.'),button(refreshing?'Refreshing…':'Refresh prices',onRefresh,undefined,refreshing)),refreshWarning&&h('p',{className:'text-xs text-amber-500'},'Price refresh incomplete. Check CoinGecko settings; saved observations retained.')),
      h('div',{className:'flex justify-between items-center gap-2 flex-wrap'},h('h3',{className:'text-sm font-bold '+title},'Net Worth Trend'),!full&&button('Fullscreen',onFullscreen)),
      h('div',{className:'flex gap-2'},button('Every 2 weeks',()=>switchMode('biweekly'),mode==='biweekly'),button('Monthly',()=>switchMode('monthly'),mode==='monthly')),
      h('p',{className:'text-xs '+muted},mode==='biweekly'?'Fixed 14-day Saturday intervals + current point.':'Calendar month ends + current point.'),
      h(Chart,{rows,selected:pick.day,onSelect,darkMode,full}),
      h('div',{className:'flex gap-3 flex-wrap text-xs '+muted},h('span',null,h('span',{style:{color:'#10b981'}},'● '),'Reconstructed / current'),h('span',{style:{color:'#f59e0b'}},'● Estimated · ↕ conditional range'),h('span',null,'× Missing total (not zero)')),
      h('p',{className:'text-xs '+muted},`${count.points} point values · ${count.ranges} range-only · ${count.gaps} incomplete. Historical cash/debt assumes recorded postings are complete. Earlier account gaps are not filled with invented balances.`),
      h('div',{className:'flex items-center gap-2'},button('‹',()=>onSelect(rows[pi-1].day),undefined,pi===0),h('select',{'aria-label':'Net worth valuation date',value:pick.day,onChange:e=>onSelect(e.target.value),style:{backgroundColor:darkMode?'#302940':'#fff',color:darkMode?'#e5e7eb':'#1f2937',minHeight:'40px'},className:'min-w-0 flex-1 p-2 rounded-lg text-sm border '+border+' '+(darkMode?'bg-gray-800 text-white':'bg-white text-gray-900')},...rows.map(r=>h('option',{key:r.day,value:r.day},dateLabel(r.day)+(r.live?' · Now':'')+(r.quality==='unavailable'?' · incomplete':r.range?' · range':'')))),button('›',()=>onSelect(rows[pi+1].day),undefined,pi===rows.length-1)),
      h('div',{className:'p-3 rounded-xl space-y-2 '+box},h('div',{className:'text-xs '+muted},dateLabel(pick.day)+(pick.live?' · Current':' · Historical')),h('p',{className:'text-xl font-black '+(pick.quality==='current'||pick.quality==='reconstructed'?'text-emerald-500':'text-amber-500')},formatter(pick)),h('p',{className:'text-xs '+muted},statuses[pick.quality]),pick.range&&pick.total!==null&&row('Conditional net worth range',usd(pick.minValue)+' – '+usd(pick.maxValue)),row('Investments',asRange(pick.investment.total,pick.investment.minValue,pick.investment.maxValue)),pick.live&&h('p',{className:'text-xs '+muted},'Stored spot timestamp: '+(readSpot(storage).timestamp||'not available')+'. Cached daily or older spot prices are labeled under Investment evidence.'),row('Checking / savings',usd(pick.balances.cash.value)),row('Credit card debt',usd(pick.balances.debt.value)),pick.balances.cash.value===null&&row('Represented cash subtotal (not total)',usd(pick.balances.cash.knownSubtotal)),pick.balances.debt.value===null&&row('Represented debt subtotal (not total)',usd(pick.balances.debt.knownSubtotal)),h('p',{className:'text-xs '+muted},`Account coverage: ${pick.balances.cash.covered}/${pick.balances.cash.count} cash · ${pick.balances.debt.covered}/${pick.balances.debt.count} debt.`),pick.balances.cutoffDifferences>0&&h('p',{className:'text-xs text-amber-500'},`${pick.balances.cutoffDifferences} linked posting date differences at this cutoff.`),pick.balances.negativeAccounts>0&&h('p',{className:'text-xs text-amber-500'},'Negative reconstructed account balances require review.'),pick.range&&h('p',{className:'text-xs '+muted},'Range varies uncertain month-only trades, holding other evidence fixed; not guaranteed bounds.'),h('details',null,h('summary',{className:'text-xs font-bold cursor-pointer '+title},'Investment evidence'),...pick.investment.assets.map(a=>h('div',{key:a.id,className:'py-2 border-b '+border},row(a.name,asRange(a.value,a.minValue,a.maxValue)),h('p',{className:'text-xs '+muted},'Quantity: '+(finite(a.quantity)?a.quantity.toLocaleString('en-US',{maximumFractionDigits:8}):'uncertain')+(a.price?' · $'+a.price.price.toPrecision(8)+' · '+a.price.kind+' · '+(a.price.observedAt||a.price.month||a.price.localDay||''):' · no price used')))),h('p',{className:'text-xs '+muted},'Historical daily prices use the UTC midnight within the California day, not local closing prices. Spot timestamps indicate retrieval.'))),
      !full&&finite(assetTotal)&&assetTotal>0&&live.balances.cash.value>=0&&live.investment.total>=0&&h('div',null,h('p',{className:'text-xs font-bold mb-2 '+muted},'Asset Breakdown'),h('div',{className:'flex h-4 rounded-full overflow-hidden'},h('div',{className:'bg-emerald-500',style:{width:100*live.balances.cash.value/assetTotal+'%'}}),h('div',{className:'bg-blue-500',style:{width:100*live.investment.total/assetTotal+'%'}})),h('p',{className:'text-xs mt-2 '+muted},`Checking (${Math.round(100*live.balances.cash.value/assetTotal)}%) · Investments (${Math.round(100*live.investment.total/assetTotal)}%)`)),
      h('p',{className:'text-xs '+muted},`${model.scope.excluded} excluded asset records preserved · ${model.scope.unmapped} unmapped records not valued. No undated manual prices, savings goals, loans, work earnings or inferred investment cash funding. Snapshots not yet active.`));
  }
  const api={timeline,readSpot,currentInvestments,build,Panel};if(req)module.exports=api;else root.MoneyBuddyNetWorth=api;
})(typeof window==='undefined'?globalThis:window);
