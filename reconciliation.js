/* Stage 5: dated, user-supplied account evidence and daily observed snapshots.
 * No network, no writes to original financial records, no retroactive snapshot creation.
 */
(function(root){'use strict';
 const req=typeof module==='object'&&module.exports, Dates=root.MoneyBuddyDates||(req?require('./transaction-dates.js'):null);
 const KEY='mm-stage5-reconciliation', DAY=86400000, MAX=1e12;
 const obj=x=>!!x&&typeof x==='object'&&!Array.isArray(x), num=x=>typeof x==='number'&&Number.isFinite(x)&&Math.abs(x)<=MAX;
 const id=x=>typeof x==='string'&&x.length>0&&x.length<=160, stamp=x=>typeof x==='string'&&Number.isFinite(Date.parse(x)), cents=x=>Math.round(x*100), dollars=x=>x/100;
 const dayms=d=>Date.parse(d+'T00:00:00Z'), distance=(a,b)=>Math.round((dayms(b)-dayms(a))/DAY);
 const empty=()=>({version:1,anchors:[],snapshots:[]});
 const validPreference=p=>only(p,['enabled','updatedAt'])&&typeof p.enabled==='boolean'&&stamp(p.updatedAt);
 const bridgeEnabled=data=>data.bridgePreference?.enabled===true;
 const key=a=>JSON.stringify([a.accountId,a.type,a.day]);
 const types=['debit','credit'], sources=['statement','confirmed','not-open','first-cycle-opening'];
 const only=(o,ks)=>obj(o)&&Object.keys(o).every(k=>ks.includes(k));
 function validAnchor(a){return only(a,['accountId','type','day','amount','source','bridge','updatedAt','deleted'])&&id(a.accountId)&&types.includes(a.type)&&Dates.validDay(a.day)&&num(a.amount)&&Math.abs(a.amount-cents(a.amount)/100)<1e-7&&sources.includes(a.source)&&typeof a.bridge==='boolean'&&stamp(a.updatedAt)&&typeof a.deleted==='boolean'&&a.day<Dates.calendarDay(a.updatedAt)&&(a.source!=='not-open'||a.amount===0);}
 const coinIds=['morpho','sky','venice-token','syrup','mamo'];
 function validSnapshot(s){
  if(!only(s,['day','capturedAt','cash','debt','investments','total','accounts','assets','estimated'])||!Dates.validDay(s.day)||!stamp(s.capturedAt)||Dates.calendarDay(s.capturedAt)!==s.day||![s.cash,s.debt,s.investments,s.total].every(num)||typeof s.estimated!=='boolean'||!Array.isArray(s.accounts)||!s.accounts.length||!Array.isArray(s.assets)||s.assets.length!==5)return false;
  if(!s.accounts.every(a=>only(a,['accountId','type','balance'])&&id(a.accountId)&&types.includes(a.type)&&num(a.balance))||new Set(s.accounts.map(a=>a.accountId)).size!==s.accounts.length)return false;
  if(!s.assets.every(a=>only(a,['id','name','quantity','value','price'])&&coinIds.includes(a.id)&&typeof a.name==='string'&&num(a.quantity)&&a.quantity>=0&&num(a.value)&&a.value>=0&&(a.quantity===0?a.value===0&&a.price===null:only(a.price,['price','kind','observedAt'])&&num(a.price.price)&&a.price.price>0&&a.price.kind==='spot'&&stamp(a.price.observedAt)&&Date.parse(a.price.observedAt)<=Date.parse(s.capturedAt)&&Date.parse(s.capturedAt)-Date.parse(a.price.observedAt)<=DAY&&cents(a.quantity*a.price.price)===cents(a.value)))||new Set(s.assets.map(a=>a.id)).size!==5)return false;
  return cents(s.cash)===s.accounts.filter(a=>a.type==='debit').reduce((v,a)=>v+cents(a.balance),0)&&cents(s.debt)===s.accounts.filter(a=>a.type==='credit').reduce((v,a)=>v+cents(a.balance),0)&&cents(s.investments)===s.assets.reduce((v,a)=>v+cents(a.value),0)&&cents(s.total)===cents(s.cash)+cents(s.investments)-cents(s.debt);
 }
 function parse(raw){if(raw===null||raw===undefined)return empty();const v=JSON.parse(raw);if(!only(v,['version','anchors','snapshots','bridgePreference'])||v.version!==1||('bridgePreference' in v&&!validPreference(v.bridgePreference))||!Array.isArray(v.anchors)||!Array.isArray(v.snapshots)||!v.anchors.every(validAnchor)||!v.snapshots.every(validSnapshot)||new Set(v.anchors.map(key)).size!==v.anchors.length||new Set(v.snapshots.map(s=>s.day)).size!==v.snapshots.length)throw Error('Invalid saved reconciliation evidence.');return v;}
 function read(storage){return parse(storage.getItem(KEY));}
 function mergeRaw(local,incoming){const a=parse(local),b=parse(incoming);function merge(x,y,k,t){const m=new Map(x.map(v=>[k(v),v]));for(const v of y){const old=m.get(k(v));if(!old||Date.parse(v[t])>Date.parse(old[t]))m.set(k(v),v);}return [...m.values()];}const pa=a.bridgePreference,pb=b.bridgePreference,pref=pb&&(!pa||Date.parse(pb.updatedAt)>Date.parse(pa.updatedAt))?pb:pa;return JSON.stringify({version:1,anchors:merge(a.anchors,b.anchors,key,'updatedAt'),snapshots:merge(a.snapshots,b.snapshots,s=>s.day,'capturedAt'),...(pref?{bridgePreference:pref}:{})});}
 function putAnchor(storage,a,now=new Date()){const entry={...a,updatedAt:now.toISOString(),deleted:!!a.deleted};if(!validAnchor(entry))throw Error('Use a completed date and a valid dollar balance.');const v=read(storage);const old=v.anchors.find(x=>key(x)===key(entry));if(old&&Date.parse(old.updatedAt)>+now)throw Error('Existing evidence has a later timestamp.');v.anchors=v.anchors.filter(x=>key(x)!==key(entry));v.anchors.push(entry);storage.setItem(KEY,JSON.stringify(v));return v;}
 function setBridgePreference(storage,enabled,now=new Date()){if(typeof enabled!=='boolean'||!Number.isFinite(+now))throw Error('Invalid estimate preference.');const v=read(storage);if(v.bridgePreference&&Date.parse(v.bridgePreference.updatedAt)>+now)throw Error('Existing preference has a later timestamp.');v.bridgePreference={enabled,updatedAt:now.toISOString()};storage.setItem(KEY,JSON.stringify(v));return v;}
 const active=(data,account,today)=>data.anchors.filter(x=>!x.deleted&&x.accountId===String(account.recordId)&&x.type===account.type&&x.day<today).sort((a,b)=>a.day.localeCompare(b.day));
 // Exact statement beats reconstruction. No backward projection of a first observed balance
 // into an unrepresented period. Optional interpolation is bounded by actual observations.
 function resolve(data,a,day,today){
  if(day>=today||a.recordId===null)return null;
  const rows=active(data,a,today), exact=rows.find(x=>x.day===day);
  // A billing-cycle opening amount is a START-of-day statement figure, not
  // an account opening date or an observed end-of-day balance. Do not project
  // the balance backwards beyond it without independent earlier evidence.
  const cycleStart=rows.filter(x=>x.source==='first-cycle-opening').map(x=>x.day).sort()[0];
  if(cycleStart&&day<cycleStart&&!rows.some(x=>x.day<=day&&x.source!=='not-open')){
   // ONLY on a documented FIRST statement with zero previous balance and no
   // recorded earlier activity, treat the preceding account balance as a
   // provisional zero. This is an inference, NOT an account-opening date.
   // It keeps prior history usable without converting a guess to a verified fact.
   const canInferZero=rows.some(x=>x.source==='first-cycle-opening'&&x.day===cycleStart&&x.amount===0)&&(!a.firstActivity||a.firstActivity>=cycleStart);
   return {balance:canInferZero?0:null,kind:canInferZero?'provisional-pre-first-statement-zero':'before-billing-cycle-evidence',source:canInferZero?'first-statement-inference':'unsupported-history',from:cycleStart};
  }
  if(exact?.source==='first-cycle-opening')return {balance:exact.amount,kind:'provisional-opening-day',source:'first-cycle-opening',from:exact.day};
  const contradictory=x=>x.source==='not-open'&&((a.firstActivity&&a.firstActivity<=x.day)||rows.some(r=>r.day<=x.day&&r.source!=='not-open'));
  if(exact&&!contradictory(exact))return {balance:exact.amount,kind:exact.source==='not-open'?'confirmed-not-open':'dated-balance',source:exact.source,from:exact.day};
  const notOpen=rows.find(x=>x.source==='not-open'&&x.day>=day&&!contradictory(x));
  if(notOpen)return {balance:0,kind:'confirmed-not-open',source:'not-open',from:notOpen.day};
  const known=rows.filter(x=>!contradictory(x)), left=known.filter(x=>x.day<day).at(-1), right=known.find(x=>x.day>day);
  const signed=(from,to)=>a.movements.filter(m=>m.postingDay>from&&m.postingDay<=to).reduce((s,m)=>s+cents(m.accountDelta),0);
  if(left&&right&&(left.bridge||bridgeEnabled(data))&&distance(left.day,right.day)<=45){
    // Use recorded postings if the interval is fully represented; allocate the remaining
    // endpoint discrepancy uniformly. Before representation only interpolate endpoints.
    const days=distance(left.day,right.day), fraction=distance(left.day,day)/days;
    const usePostings=a.valid&&a.first&&left.day>=a.first;
    const recorded=usePostings?signed(left.day,right.day):0, partial=usePostings?signed(left.day,day):0;
    const residual=cents(right.amount)-cents(left.amount)-recorded;
    const predicted=dollars(Math.round(cents(left.amount)+partial+residual*fraction));if(a.type==='credit'&&predicted<0&&left.amount>=0&&right.amount>=0)return {balance:null,kind:'unsupported-negative-credit',source:'conflicting-reconstruction',from:left.day,to:right.day};return {balance:predicted,kind:'statement-interpolation',source:'conditional-estimate',from:left.day,to:right.day,residual:dollars(residual),usedPostings:!!usePostings,openingUncertain:left.source==='not-open'};
  }
  // On already represented dates, use a nearby statement within the recorded interval
  // rather than extrapolating across months without recorded postings.
  if(a.valid&&a.first&&day>=a.first){const nearest=known.filter(x=>x.source!=='not-open'&&x.day>=a.first&&Math.abs(distance(x.day,day))<=45).sort((x,y)=>Math.abs(distance(x.day,day))-Math.abs(distance(y.day,day))||x.day.localeCompare(y.day))[0];
    if(nearest){const delta=nearest.day<day?signed(nearest.day,day):-signed(day,nearest.day);const predicted=dollars(cents(nearest.amount)+delta);if(a.type==='credit'&&predicted<0&&nearest.amount>=0)return {balance:null,kind:'unsupported-negative-credit',source:'conflicting-reconstruction',from:nearest.day};return {balance:predicted,kind:'statement-reconstructed',source:nearest.source,from:nearest.day};}
  }
  return null;
 }

 // A private, strictly scoped evidence correction can be applied without restoring
 // an old full-data backup. It never edits the original accounts, ledger or prices.
 function applyEvidencePatch(storage,core,patch,now=new Date()){
  const allowed=['format','accountId','accountName','type','changes','checks'];
  if(!only(patch,allowed)||patch.format!=='moneybuddy-evidence-patch-v1'||!id(patch.accountId)||typeof patch.accountName!=='string'||!types.includes(patch.type)||!Array.isArray(patch.changes)||patch.changes.length===0||patch.changes.length>12||!stamp(now.toISOString()))throw Error('Invalid evidence correction format.');
  const matching=(core.cards||[]).filter(c=>String(c.id)===patch.accountId&&c.type===patch.type&&c.name.trim()===patch.accountName.trim());
  if(matching.length!==1)throw Error('This correction is not for a matching saved account. Nothing changed.');
  const data=read(storage),next={...data,anchors:data.anchors.map(a=>({...a}))},moment=now.toISOString();
  if(patch.checks!==undefined){if(!Array.isArray(patch.checks)||!patch.checks.length||patch.checks.length>12)throw Error('Invalid statement checks. Nothing changed.');
   for(const check of patch.checks){if(!only(check,['day','amount','source'])||!Dates.validDay(check.day)||!num(check.amount)||!sources.includes(check.source)||!data.anchors.some(a=>!a.deleted&&a.accountId===patch.accountId&&a.type===patch.type&&a.day===check.day&&a.amount===check.amount&&a.source===check.source))throw Error('A verified statement balance has changed. Nothing changed.');}
  }
  const seen=new Set();let changed=0;
  for(const c of patch.changes){
   if(!only(c,['day','expect','set'])||!Dates.validDay(c.day)||c.day>=Dates.calendarDay(now)||seen.has(c.day)||!only(c.set,['action','amount','source','bridge'])||!['void','upsert'].includes(c.set.action))throw Error('Invalid or duplicate dated correction. Nothing changed.');
   seen.add(c.day);
   if(c.expect!==null&&(!only(c.expect,['amount','source'])||!num(c.expect.amount)||!sources.includes(c.expect.source)))throw Error('Invalid expected evidence. Nothing changed.');
   const old=next.anchors.find(a=>a.accountId===patch.accountId&&a.type===patch.type&&a.day===c.day);
   if(c.set.action==='void'){
    if(c.expect===null||!old||old.amount!==c.expect.amount||old.source!==c.expect.source){
     if(old?.deleted===true&&old.amount===c.expect?.amount&&old.source===c.expect?.source)continue;
     throw Error('Existing evidence changed on '+c.day+'. Correction stopped without modifying storage.');
    }
    if(old.deleted)continue;
    next.anchors=next.anchors.filter(a=>a!==old);next.anchors.push({...old,deleted:true,updatedAt:moment});changed++;
   }else{
    if(!num(c.set.amount)||!sources.includes(c.set.source)||typeof c.set.bridge!=='boolean'||c.set.source==='not-open'&&c.set.amount!==0)throw Error('Invalid replacement balance. Nothing changed.');
    if(old){if(!old.deleted&&old.amount===c.set.amount&&old.source===c.set.source&&old.bridge===c.set.bridge)continue;
      if(c.expect===null||old.amount!==c.expect.amount||old.source!==c.expect.source)throw Error('Existing evidence changed on '+c.day+'. Correction stopped without modifying storage.');
    }else if(c.expect!==null)throw Error('Expected prior evidence missing on '+c.day+'. Nothing changed.');
    next.anchors=next.anchors.filter(a=>a!==old);
    const incoming={accountId:patch.accountId,type:patch.type,day:c.day,amount:c.set.amount,source:c.set.source,bridge:c.set.bridge,deleted:false,updatedAt:moment};
    if(!validAnchor(incoming))throw Error('Invalid evidence date. Nothing changed.');
    next.anchors.push(incoming);changed++;
   }
  }
  const serialized=JSON.stringify(next);parse(serialized); // all-or-nothing validation
  if(changed)storage.setItem(KEY,serialized);
  return {changed,accountName:matching[0].name};
 }

 function capture(storage,core,live,now=new Date()){
  const day=Dates.calendarDay(now);if(!live||live.day!==day||!num(live.total)||live.range||!core.cards?.length||!live.balances?.accounts?.length||!live.investment?.assets?.length)return {status:'Waiting for complete balances and fresh spot prices.'};
  const s={day,capturedAt:now.toISOString(),cash:live.balances.cash.value,debt:live.balances.debt.value,investments:live.investment.total,total:live.total,estimated:live.quality!=='current',accounts:live.balances.accounts.map(a=>({accountId:String(core.cards[Number(a.accountRef.split(':')[1])]?.id??''),type:a.type,balance:a.balance})),assets:live.investment.assets.map(a=>({id:a.id,name:a.name,quantity:a.quantity,value:a.value,price:a.price?{price:a.price.price,kind:a.price.kind,observedAt:a.price.observedAt}:null}))};
  if(!validSnapshot(s))return {status:'Waiting for complete balances and fresh spot prices.'};
  const v=read(storage),old=v.snapshots.find(x=>x.day===day);if(old&&Date.parse(old.capturedAt)>=+now)return {status:'Daily observation already saved.'};
  const payload=x=>JSON.stringify({...x,capturedAt:''});if(old&&payload(old)===payload(s))return {status:'Daily observation already saved.'};
  v.snapshots=v.snapshots.filter(x=>x.day!==day);v.snapshots.push(s);storage.setItem(KEY,JSON.stringify(v));return {status:'Daily observation saved.'};
 }
 function snapshotRow(s){const group=type=>{const count=s.accounts.filter(a=>a.type===type).length,value=type==='debit'?s.cash:s.debt;return {value,knownSubtotal:value,covered:count,count};};return {day:s.day,stamp:dayms(s.day),live:false,range:false,quality:'snapshot',total:s.total,minValue:s.total,maxValue:s.total,snapshot:s,investment:{total:s.investments,minValue:s.investments,maxValue:s.investments,assets:s.assets},balances:{cash:group('debit'),debt:group('credit'),accounts:s.accounts,cutoffDifferences:0,negativeAccounts:s.accounts.filter(a=>a.balance<0).length}};}
 function Panel({core,storage,darkMode,onChange}){
  const R=root.React,h=R.createElement,[rev,update]=R.useState(0),[account,setAccount]=R.useState(''),[day,setDay]=R.useState(''),[amount,setAmount]=R.useState(''),[source,setSource]=R.useState('statement'),[bridge,setBridge]=R.useState(false),[msg,setMsg]=R.useState(''),[inspect,setInspect]=R.useState('');
  const cards=core.cards||[],today=Dates.today(),muted=darkMode?'text-gray-400':'text-gray-600',title=darkMode?'text-purple-300':'text-purple-700',style={backgroundColor:darkMode?'#302940':'#fff',color:darkMode?'#e5e7eb':'#1f2937',minHeight:40},input='block w-full p-2 rounded-lg border '+(darkMode?'border-gray-600':'border-gray-300');
  let v;try{v=read(storage);}catch(e){return h('p',{className:'text-sm text-rose-500'},e.message+' Keep your backup.');}
  const chosen=cards.find(c=>String(c.id)===account),anchors=v.anchors.filter(a=>!a.deleted),snap=v.snapshots.slice().sort((a,b)=>b.day.localeCompare(a.day)),s=snap.find(x=>x.day===inspect)||snap[0];
  const usd=x=>x.toLocaleString('en-US',{style:'currency',currency:'USD'}),btn=(label,fn)=>h('button',{type:'button',onClick:fn,className:'px-3 py-2 rounded-lg bg-purple-600 text-white text-sm font-bold'},label),field=(label,el)=>h('label',{className:'block text-xs '+muted},label,el);
  function coverage(enabled){try{const C=root.MoneyBuddyCashHistory,N=root.MoneyBuddyNetWorth;if(!C||!N)return null;const model=C.build(core,{anchor:C.readAnchor(storage),reconciliation:{...v,bridgePreference:{enabled,updatedAt:new Date().toISOString()}}});const results={};for(const mode of ['biweekly','monthly']){const dates=N.timeline(model.first,model.last,mode).filter(d=>d!==model.last),missing={};let complete=0;for(const d of dates){const r=model.valueAt(d);if(r.netLiquid!==null)complete++;else for(const a of r.accounts.filter(a=>a.balance===null)){if(!missing[a.accountRef])missing[a.accountRef]={name:a.name,dates:[]};missing[a.accountRef].dates.push(d);}}results[mode]={complete,total:dates.length,missing:Object.values(missing).sort((a,b)=>b.dates.length-a.dates.length)};}return results;}catch(_){return null;}}
  const on=bridgeEnabled(v),strictCoverage=coverage(false),estimatedCoverage=coverage(true),shownCoverage=on?estimatedCoverage:strictCoverage;
  function toggleBridge(){try{setBridgePreference(storage,!on);update(rev+1);onChange?.();setMsg(!on?'Bounded statement estimates enabled. Original evidence is unchanged.':'Global statement estimates disabled; individual permissions are unchanged.');}catch(e){setMsg(e.message);}}
  function save(){try{if(!chosen||!day||source!=='not-open'&&!amount.trim())throw Error('Choose account, date and balance.');const firstActivity=(chosen.transactions||chosen.payments||[]).map(x=>Dates.validDay(x.date)?x.date:Dates.calendarDay(x.date)).filter(Boolean).sort()[0];if(source==='not-open'&&firstActivity&&day>=firstActivity)throw Error('That date overlaps recorded account activity. Use a statement balance instead.');if(source==='not-open'&&anchors.some(a=>a.accountId===account&&a.type===chosen.type&&a.day<=day&&a.source!=='not-open'))throw Error('Earlier nonzero balance conflicts with not-open evidence.');if(anchors.some(a=>a.accountId===account&&a.type===chosen.type&&a.day===day)&&!root.confirm('Replace the existing dated evidence for this account and date?'))return;putAnchor(storage,{accountId:account,type:chosen.type,day,amount:source==='not-open'?0:Number(amount),source,bridge:source!=='not-open'&&bridge,deleted:false});update(rev+1);onChange?.();setMsg('Saved historical evidence. Current balances are unchanged.');}catch(e){setMsg(e.message);}}
  async function importCorrection(e){const file=e.target.files?.[0];if(!file)return;try{if(file.size>20000)throw Error('Correction file is unexpectedly large.');const patch=JSON.parse(await file.text());const result=applyEvidencePatch(storage,core,patch);update(rev+1);onChange?.();setMsg(result.changed?('Applied '+result.changed+' dated evidence changes to '+result.accountName+'. All original transactions and other accounts remain unchanged.'):'That evidence correction is already applied. No changes made.');}catch(error){setMsg(error.message+' No financial records were changed.');}finally{e.target.value='';}}
  function remove(a){if(!root.confirm('Remove this dated evidence? The original account records will stay unchanged.'))return;try{putAnchor(storage,{...a,deleted:true});update(rev+1);onChange?.();setMsg('Evidence removed.');}catch(e){setMsg(e.message);}}
  return h('details',null,h('summary',{className:'text-sm font-bold cursor-pointer '+title},'Historical reconciliation & snapshots'),h('div',{className:'space-y-3 mt-3'},h('p',{className:'text-xs '+muted},'Use actual statement closing dates and balances. Confirm not-open dates only if the account genuinely did not exist. A first statement opening balance is not proof of the account creation date; earlier zero balances are provisional assumptions only when no earlier activity is recorded. No bank credentials or statements are uploaded. Saved observations remain as recorded even if later evidence changes.'),h('details',{className:'rounded-lg border border-gray-500/30 p-3'},h('summary',{className:'text-sm font-bold cursor-pointer '+title},'Apply private evidence correction'),h('p',{className:'text-xs mt-2 '+muted},'Choose a private JSON evidence-correction file saved on this device. The file is read locally. Only the named account’s dated evidence can change; this does not restore an older full backup or upload data to the internet. Make a fresh backup first.'),h('input',{type:'file',accept:'.json,application/json','aria-label':'Choose private evidence correction JSON',className:'block text-sm mt-2',onChange:importCorrection})),field('Account',h('select',{'aria-label':'Account',className:input,style,value:account,onChange:e=>setAccount(e.target.value)},h('option',{value:''},'Choose account'),...cards.map(c=>h('option',{key:String(c.id),value:String(c.id)},c.name+' · '+c.type)))),field('Evidence date',h('input',{'aria-label':'Evidence date',type:'date',className:input,style,value:day,max: new Date(dayms(today)-DAY).toISOString().slice(0,10),onChange:e=>setDay(e.target.value)})),field('Evidence source',h('select',{'aria-label':'Evidence source',className:input,style,value:source,onChange:e=>setSource(e.target.value)},h('option',{value:'statement'},'Statement closing balance'),h('option',{value:'confirmed'},'Other confirmed balance'),h('option',{value:'first-cycle-opening'},'First statement cycle opening balance (start of day)'),h('option',{value:'not-open'},'Account not yet opened as of date'))),source==='first-cycle-opening'&&h('p',{className:'text-xs '+muted},'For the FIRST EVER statement only: use the first day of its period and the PREVIOUS balance. Pre-statement zero is a labeled inference if prior activity is absent; this is not proof of the account opening date.'),source!=='not-open'&&field('Balance USD (credit = amount owed; negative = credit balance)',h('input',{'aria-label':'Balance USD',className:input,style,type:'number',step:'0.01',value:amount,onChange:e=>setAmount(e.target.value)})),source!=='not-open'&&h('label',{className:'flex gap-2 text-xs '+muted},h('input',{type:'checkbox',checked:bridge,onChange:e=>setBridge(e.target.checked)}),'Allow estimated interpolation to next dated balance (max 45 days; assumes gradual change in unrecorded movements).'),btn('Save dated evidence',save),h('div',{className:'p-3 rounded-lg border border-gray-500/30 space-y-2'},h('p',{className:'font-bold text-sm '+title},'Recover dates between statements'),h('label',{className:'flex items-center gap-2 text-sm '+muted},h('input',{type:'checkbox',checked:on,onChange:toggleBridge,'aria-label':'Use bounded statement estimates for all accounts'}),'Use bounded statement estimates for all accounts'),h('p',{className:'text-xs '+muted},'Applies to your existing and future dated balances without editing any entries. Only between observations at most 45 days apart. Uses recorded postings where the interval is represented and distributes unexplained differences. Dates spanning account opening are estimates, not proof of when it opened. No extrapolation into unsupported periods. Unsupported negative credit-card estimates are treated as incomplete instead of inflating net worth.'),strictCoverage&&estimatedCoverage&&h('p',{className:'text-xs '+title},'Potential complete account coverage (historical dates only): every 2 weeks '+strictCoverage.biweekly.complete+' → '+estimatedCoverage.biweekly.complete+' / '+estimatedCoverage.biweekly.total+'; monthly '+strictCoverage.monthly.complete+' → '+estimatedCoverage.monthly.complete+' / '+estimatedCoverage.monthly.total+'. Investment evidence may still limit totals.'),shownCoverage&&h('details',null,h('summary',{className:'text-xs font-bold cursor-pointer '+title},'Remaining missing account dates · '+(on?'estimates enabled':'current permissions')), ...shownCoverage.biweekly.missing.map(a=>h('p',{key:a.name,className:'text-xs '+muted},a.name+' · '+a.dates.length+' biweekly dates: '+a.dates.join(', '))), ...shownCoverage.monthly.missing.map(a=>h('p',{key:'monthly-'+a.name,className:'text-xs '+muted},a.name+' · '+a.dates.length+' month ends: '+a.dates.join(', '))),h('p',{className:'text-xs '+muted},'If none are listed, all account components are represented. A remaining gap may be due to too-wide a statement interval or early missing evidence.'))),msg&&h('p',{role:'status',className:'text-xs '+title},msg),h('p',{className:'text-xs '+muted},`${anchors.length} dated entries · ${snap.length} saved daily observations. Exact balances take priority; optional interpolation is not a verified total.`),...anchors.sort((a,b)=>b.day.localeCompare(a.day)).map(a=>h('div',{key:key(a),className:'border-b border-gray-500/30 py-2 flex gap-2 justify-between'},h('div',{className:'text-xs'},(cards.find(c=>String(c.id)===a.accountId&&c.type===a.type)?.name||'Account not in active records')+' · '+a.day,h('p',{className:muted},a.source+' · '+usd(a.amount)+(a.bridge?' · estimate to next balance allowed':''))),h('div',{className:'flex gap-2'},btn('Edit',()=>{setAccount(a.accountId);setDay(a.day);setAmount(String(a.amount));setSource(a.source);setBridge(a.bridge);}),btn('Remove',()=>remove(a))))),h('p',{className:'text-xs '+muted},'Snapshots save the latest complete observation each local day while the app is open, using fresh retrieved spot prices. Missed days are not filled retroactively. Historical graph uses saved observations on matching dates. Preserve via JSON backup.'),snap.length>0&&h('div',{className:'space-y-1'},field('Inspect saved observation',h('select',{className:input,style,value:s.day,onChange:e=>setInspect(e.target.value)},...snap.map(x=>h('option',{key:x.day,value:x.day},x.day)))),h('p',{className:'font-bold '+title},usd(s.total)+' · saved observation'),h('p',{className:'text-xs '+muted},'Captured '+s.capturedAt+' · cash '+usd(s.cash)+' · investments '+usd(s.investments)+' · debt '+usd(s.debt)+'. Not bank verified.'))));
 }
 const api={KEY,empty,parse,read,mergeRaw,putAnchor,setBridgePreference,applyEvidencePatch,resolve,capture,snapshotRow,Panel};if(req)module.exports=api;else root.MoneyBuddyReconciliation=api;
})(typeof window==='undefined'?globalThis:window);
