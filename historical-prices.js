/* Stage 1C — local CoinGecko daily USD observations. No financial records or keys in this library.
 * UTC midnight observations are not local end-of-day prices or execution prices.
 * Compact tuples: [price, retrievedAtEpochMs]; observation timestamp = UTC midnight of map key.
 */
(function(root){
  'use strict';
  const KEY='mm-stage1c-daily-prices', ATTEMPT='mm-stage1c-last-attempt', DAY=86400000;
  const IDS=Object.freeze(['morpho','sky','syrup','mamo','venice-token']);
  const BASE='https://api.coingecko.com/api/v3/';
  const obj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
  const iso=t=>new Date(t).toISOString().slice(0,10);
  const midnight=t=>Math.floor(t/DAY)*DAY;
  const dateMs=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&iso(Date.parse(d))===d?Date.parse(d):NaN;
  const empty=()=>({version:1,currency:'usd',source:'coingecko',granularity:'utc-midnight',observations:{}});
  function validate(data){
    if(!obj(data)||data.version!==1||data.currency!=='usd'||data.source!=='coingecko'||data.granularity!=='utc-midnight'||!obj(data.observations)||Object.keys(data).some(k=>!['version','currency','source','granularity','observations'].includes(k)))throw Error('Invalid daily price library');
    for(const [id,days] of Object.entries(data.observations)){
      if(!IDS.includes(id)||!obj(days))throw Error('Unsupported daily price asset');
      for(const [day,tuple] of Object.entries(days)){
        const t=dateMs(day);
        if(!Number.isFinite(t)||!Array.isArray(tuple)||tuple.length!==2||!positive(tuple[0])||!Number.isSafeInteger(tuple[1])||tuple[1]<t||tuple[1]>8640000000000000)throw Error('Invalid daily price observation');
      }
    }return data;
  }
  function parse(raw){return raw===null?empty():validate(JSON.parse(raw));}
  function read(storage){return parse(storage.getItem(KEY));}
  function merge(current,incoming){
    validate(current);validate(incoming);
    const result=JSON.parse(JSON.stringify(current));
    for(const [id,days] of Object.entries(incoming.observations)){
      const dest=result.observations[id]||(result.observations[id]={});
      for(const [day,tuple] of Object.entries(days)){
        // Never remove existing observations. Older observations are not replaced by older imports.
        if(!dest[day]||tuple[1]>dest[day][1])dest[day]=tuple.slice();
      }
    }return result;
  }
  function mergeRaw(oldRaw,newRaw){return JSON.stringify(merge(parse(oldRaw),parse(newRaw)));}
  function rangeFor(days,now){
    // Use a >90 day range even for incremental requests, so Demo auto-granularity is daily.
    // Keep a one-day margin inside the rolling 365-day limit.
    const today=midnight(now), floor=Math.ceil((now-364*DAY)/DAY)*DAY;
    // Provider says completed day's observation may not be ready until 00:35 UTC next day.
    const end=today-DAY-(now-today<35*60000?DAY:0);
    let missing=end;
    for(let t=floor;t<=end;t+=DAY)if(!days[iso(t)]){missing=t;break;}
    const start=Math.max(floor,Math.min(missing,end-92*DAY));
    return {from:start,to:now,end,floor};
  }
  function extract(id,payload,range,retrievedAt){
    if(!IDS.includes(id)||!obj(payload)||!Array.isArray(payload.prices)||!payload.prices.length)throw Error('Missing historical prices');
    const data=empty(), days=data.observations[id]={};let rejected=0;
    for(const pt of payload.prices){
      if(!Array.isArray(pt)||pt.length<2||!Number.isSafeInteger(pt[0])||!positive(pt[1])||pt[0]<range.from||pt[0]>range.end||pt[0]%DAY!==0||pt[0]>retrievedAt){rejected++;continue;}
      const day=iso(pt[0]);if(days[day]&&days[day][0]!==pt[1])throw Error('Conflicting daily observations');
      days[day]=[pt[1],retrievedAt];
    }
    if(!Object.keys(days).length)throw Error('No valid completed UTC-day observations');
    return {data:validate(data),rejected};
  }
  function lookup(data,id,day){
    validate(data);const tuple=data.observations[id]?.[day];
    return tuple?{assetId:id,price:tuple[0],currency:'usd',source:'coingecko',classification:'market-observation',observedAt:new Date(dateMs(day)).toISOString(),retrievedAt:new Date(tuple[1]).toISOString()}:null;
  }
  function summary(data){
    validate(data);const assets=IDS.map(id=>{const dates=Object.keys(data.observations[id]||{}).sort();return {id,count:dates.length,first:dates[0]||null,last:dates[dates.length-1]||null};});
    return {total:assets.reduce((s,a)=>s+a.count,0),assets};
  }
  function coverage(storage){try{return summary(read(storage));}catch(_){return {total:0,assets:[],invalid:true};}}
  function due(storage,now=Date.now()){
    try{const last=Number(storage.getItem(ATTEMPT)||0);return !last||now<last||now-last>=6*3600000;}catch(_){return true;}
  }
  function legacyMonthly(data,previous,now){
    // The old chart still consumes cg-hist. Keep every old monthly value except the current
    // month when coverage for all elapsed days exists. Fill missing completed months only
    // from complete daily series. A partial rolling response cannot replace old evidence.
    const next={...previous}, current=iso(now).slice(0,7);
    const end=midnight(now)-DAY-(now-midnight(now)<35*60000?DAY:0);
    for(const [id,days] of Object.entries(data.observations)){
      const months=new Set(Object.keys(days).map(d=>d.slice(0,7)));
      for(const month of months){
        const start=Date.parse(month+'-01'), d=new Date(start), stop=Math.min(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-DAY,end);
        if(stop<start)continue;
        let total=0,n=0,complete=true;
        for(let t=start;t<=stop;t+=DAY){const tuple=days[iso(t)];if(!tuple){complete=false;break;}total+=tuple[0];n++;}
        const key=id+'-'+d.getUTCFullYear()+'-'+d.getUTCMonth();
        if(complete&&n&&(month===current||!Object.prototype.hasOwnProperty.call(next,key)))next[key]=total/n;
      }
    }return next;
  }
  let busy=false;
  async function refresh({storage,fetcher,key,now=Date.now(),shouldStop=()=>false,onSpot=()=>{},writeBatch}){
    if(busy)return {busy:true};busy=true;
    const failures=[],successes=[];let spotOk=false,spotError='',monthly=null,stop=false;
    const get=async url=>{
      const controller=typeof AbortController==='function'?new AbortController():null;
      const timer=controller?setTimeout(()=>controller.abort(),25000):null;
      try{const response=await fetcher(url,{headers:key?{'x-cg-demo-api-key':key}:{},...(controller?{signal:controller.signal}:{})});if(!response.ok){const e=Error('HTTP '+response.status);e.status=response.status;throw e;}return await response.json();}finally{if(timer!==null)clearTimeout(timer);}
    };
    const blocked=e=>[401,403,429].includes(e.status);
    try{
      try{storage.setItem(ATTEMPT,String(now));}catch(_){}
      try{
        const raw=await get(BASE+'simple/price?ids='+IDS.join(',')+'&vs_currencies=usd');const values={};
        for(const id of IDS){if(!positive(raw?.[id]?.usd))throw Error('Invalid spot price');values[id]=raw[id].usd;}
        if(shouldStop())return {cancelled:true};
        const ts=new Date().toISOString();writeBatch(storage,[['cg-spot',JSON.stringify(values)],['cg-ts',ts]]);onSpot(values,ts);spotOk=true;
      }catch(e){spotError=e.name==='AbortError'?'Request timed out':e.message;stop=blocked(e);}
      if(shouldStop())return {cancelled:true};
      // Validate existing data before starting; corruption is NOT reset or overwritten.
      try{read(storage);}catch(_){return {spotOk,spotError,failures:[{id:'library',reason:'Saved daily price library is invalid; export recovery backup before repair.'}],successes};}
      for(const id of IDS){
        if(shouldStop())return {cancelled:true};
        if(stop){failures.push({id,reason:'Skipped after authentication or rate-limit error'});continue;}
        try{
          const range=rangeFor(read(storage).observations[id]||{},now);
          const payload=await get(BASE+'coins/'+id+'/market_chart/range?vs_currency=usd&from='+Math.floor(range.from/1000)+'&to='+Math.floor(range.to/1000));
          const acquired=extract(id,payload,range,Math.max(now,Date.now()));
          if(shouldStop())return {cancelled:true};
          // Re-read immediately before writing. Merge per token, not by replacing the entire response.
          const merged=merge(read(storage),acquired.data);storage.setItem(KEY,JSON.stringify(merged));
          const days=merged.observations[id]||{}; let gaps=0;
          for(let t=range.floor;t<=range.end;t+=DAY)if(!days[iso(t)])gaps++;
          successes.push({id,count:Object.keys(acquired.data.observations[id]).length,gaps,rejected:acquired.rejected});
        }catch(e){failures.push({id,reason:e.name==='AbortError'?'Request timed out':e.message});stop=blocked(e);}
      }
      if(shouldStop())return {cancelled:true};
      if(successes.length){try{const previous=JSON.parse(storage.getItem('cg-hist')||'{}');if(!obj(previous)||!Object.values(previous).every(positive))throw Error('Existing monthly cache is invalid');monthly=legacyMonthly(read(storage),previous,now);storage.setItem('cg-hist',JSON.stringify(monthly));}catch(e){monthly=null;failures.push({id:'monthly',reason:e.message});}}
      return {spotOk,spotError,successes,failures,monthly,coverage:coverage(storage)};
    }finally{busy=false;}
  }
  const api={KEY,IDS,DAY,empty,validate,parse,read,merge,mergeRaw,rangeFor,extract,lookup,summary,coverage,due,legacyMonthly,refresh,isBusy:()=>busy};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.MoneyBuddyPrices=api;
})(typeof window==='undefined'?globalThis:window);
