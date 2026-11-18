/* Money Buddy Stage 1A: versioned, local-only preservation and backup.
 * Original application records remain at the existing top-level backup keys.
 * No API credentials or wallet address are collected by this module.
 */
(function (root) {
  'use strict';
  const VERSION = 1;
  const ARCHIVE = 'mm-stage1a-legacy-price-cache';
  const PRICE_KEYS = ['cg-spot', 'cg-hist', 'cg-ts'];
  const SETTINGS = {
    'cg-spot': 'prices', 'cg-hist': 'prices', 'cg-ts': 'timestamp',
    'nw-anchor': 'number', 'financial-darkmode': 'boolean',
    'def-exp-card': 'text', 'def-inc-card': 'text',
    'cat-limits': 'object', 'cat-limit-ov': 'object',
    'task-group-1': 'text', 'task-group-2': 'text', 'task-group-3': 'text',
    'hidden-income': 'array', 'hidden-holdings': 'array',
    'financial-autorecur-log': 'object', [ARCHIVE]: 'archive'
  };
  const ARRAYS = ['investments','expenses','workLogs','todos','oneTimeIncomes','annualIncomeCategories','archivedTodos','recurringExpenses','unlockedAchievements','cards','quickAssets','quickSources','quickJobs','goals','archivedGoals','loans'];
  const OBJECTS = ['categoryNotes','jobRates','currentValues','jobLastPaidDates','settings'];
  const RECORDS = ARRAYS.filter(k => !['unlockedAchievements','quickAssets','quickSources','quickJobs','archivedTodos'].includes(k));
  const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validDate = v => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v));
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const fail = message => { throw new Error(message); };
  const copy = v => JSON.parse(JSON.stringify(v));
  const priceMap = v => object(v) && Object.values(v).every(n => finite(n) && n > 0);
  const plainText = v => typeof v === 'string';
  let restoring = false;
  function safeTree(v) {
    if (v && typeof v === 'object') for (const k of Object.keys(v)) {
      if (['__proto__','constructor','prototype'].includes(k)) fail('Unsupported property in backup: ' + k);
      safeTree(v[k]);
    }
  }
  function validateAux(key, raw) {
    if (raw === null) return;
    if (typeof raw !== 'string') fail('Invalid saved setting: ' + key);
    const kind = SETTINGS[key];
    if (kind === 'text') return;
    if (kind === 'timestamp') { if (raw !== '' && !validDate(raw)) fail('Invalid saved price timestamp'); return; }
    if (kind === 'number') { if (!raw.trim() || !Number.isFinite(Number(raw))) fail('Invalid saved cash anchor'); return; }
    let v; try { v = JSON.parse(raw); } catch (_) { fail('Invalid JSON in saved setting: ' + key); }
    safeTree(v);
    if (kind === 'prices' && !priceMap(v)) fail('Invalid saved price map: ' + key);
    if (kind === 'boolean' && typeof v !== 'boolean') fail('Invalid saved theme');
    if (kind === 'object' && !object(v)) fail('Invalid saved setting: ' + key);
    if (kind === 'array' && (!Array.isArray(v) || !v.every(plainText))) fail('Invalid saved list: ' + key);
    if (kind === 'archive' && (!object(v) || v.version !== 1 || !validDate(v.capturedAt) || !object(v.values) || !PRICE_KEYS.every(k => own(v.values,k) && (v.values[k] === null || typeof v.values[k] === 'string')) || Object.keys(v.values).some(k => !PRICE_KEYS.includes(k)))) fail('Invalid preserved legacy price cache');
  }
  // Capture exactly what the old app had, including a missing key or stale timestamp.
  // Archive is evidence only: it is not used as a daily price series or a live valuation.
  function preserveLegacy(storage) {
    if (storage.getItem(ARCHIVE) !== null) return;
    const values = Object.fromEntries(PRICE_KEYS.map(k => [k, storage.getItem(k)]));
    if (Object.values(values).some(v => v !== null)) {
      storage.setItem(ARCHIVE, JSON.stringify({version:1, capturedAt:new Date().toISOString(), values}));
    }
  }
  function create(core, storage) {
    // Export remains possible even when local storage is too full for another archive.
    try { preserveLegacy(storage); } catch (_) {}
    const auxiliary = Object.fromEntries(Object.keys(SETTINGS).map(k => [k, storage.getItem(k)]));
    if (auxiliary[ARCHIVE] === null && PRICE_KEYS.some(k => auxiliary[k] !== null)) {
      auxiliary[ARCHIVE] = JSON.stringify({version:1,capturedAt:new Date().toISOString(),values:Object.fromEntries(PRICE_KEYS.map(k=>[k,auxiliary[k]]))});
    }
    // Deliberately allow export of raw legacy values even if a prior app wrote invalid data.
    // Restore validates active settings; the original preserved archive is inert evidence.
    return JSON.stringify({...core, exportDate:new Date().toISOString(),
      moneyBuddyBackup:{version:VERSION, stage:'1A', auxiliary}});
  }
  function validateCore(k,v) {
    if (ARRAYS.includes(k)) {
      if (!Array.isArray(v)) fail('Expected a list for ' + k);
      if (RECORDS.includes(k) && !v.every(object)) fail('Invalid record in ' + k);
      if (['quickAssets','quickSources','quickJobs','unlockedAchievements'].includes(k) && !v.every(plainText)) fail('Invalid text entry in ' + k);
    } else if (OBJECTS.includes(k) && !object(v)) fail('Expected an object for ' + k);
    if (k === 'investments') for (const r of v) {
      if (!validDate(r.date) || typeof r.asset !== 'string' || !finite(r.amount) || !['buy','sell'].includes(r.type) || !Number.isInteger(r.month) || r.month < 0 || r.month > 11 || !Number.isInteger(r.year) || (r.quantity != null && !finite(r.quantity))) fail('Invalid investment record; check dates, amounts and quantities.');
    }
    if (k === 'expenses' || k === 'oneTimeIncomes') for (const r of v) {
      if (!validDate(r.date) || !finite(r.amount)) fail('Invalid amount or date in ' + k);
    }
    if (k === 'cards') for (const r of v) {
      if (!['credit','debit'].includes(r.type) || !finite(r.balance) || typeof r.name !== 'string') fail('Invalid account record.');
      for (const field of ['payments','transactions']) if (own(r,field) && (!Array.isArray(r[field]) || !r[field].every(q => object(q) && finite(q.amount) && validDate(q.date)))) fail('Invalid account activity.');
    }
    if (k === 'archivedTodos' && !v.every(r => object(r) && (!own(r,'todos') || (Array.isArray(r.todos) && r.todos.every(object))))) fail('Invalid archived tasks.');
    if (k === 'settings' && own(v,'viewMode') && typeof v.viewMode !== 'string') fail('Invalid view setting.');
  }
  function prepareRestore(text, current, storage) {
    const input = JSON.parse(text);
    if (!object(input)) fail('Backup must be a JSON object.');
    safeTree(input);
    const keys = [...ARRAYS,...OBJECTS];
    if (!keys.some(k => own(input,k)) && !own(input,'creditCards') && !own(input,'debitCards')) fail('No recognized Money Buddy data found.');
    const core = copy(current);
    delete core.moneyBuddyBackup; delete core.exportDate;
    for (const k of keys) if (own(input,k)) {
      validateCore(k,input[k]);
      core[k] = input[k];
    }
    if (!own(input,'cards') && (own(input,'creditCards') || own(input,'debitCards'))) {
      const existing = core.cards || [];
      const convert = (key,type) => {
        if (!own(input,key)) return existing.filter(c=>c.type===type);
        if (!Array.isArray(input[key]) || !input[key].every(object)) fail('Invalid legacy account list.');
        return input[key].map(c=>({...c,type}));
      };
      core.cards = [...convert('creditCards','credit'),...convert('debitCards','debit')];
      validateCore('cards',core.cards);
    }
    const writes = [];
    const enhanced = own(input,'moneyBuddyBackup');
    if (enhanced) {
      const meta = input.moneyBuddyBackup;
      if (!object(meta) || meta.version !== VERSION || !object(meta.auxiliary)) fail('Unsupported enhanced backup version. No changes made.');
      for (const k of Object.keys(SETTINGS)) if (own(meta.auxiliary,k)) {
        const raw = meta.auxiliary[k];
        validateAux(k,raw);
        // A backup with no archive must not destroy locally preserved evidence.
        if (k === ARCHIVE && raw === null && storage.getItem(k) !== null) continue;
        writes.push([k,raw]);
      }
    }
    core.savedAt = new Date().toISOString();
    writes.push(['financial-loans',JSON.stringify(core.loans || [])], ['financial-app-data', JSON.stringify(core)]);
    const counts = ['investments','expenses','oneTimeIncomes','cards'].filter(k=>own(input,k)).map(k=>`${input[k].length} ${k==='oneTimeIncomes'?'income entries':k==='cards'?'accounts':k}`);
    return {writes, enhanced, counts};
  }
  function writeBatch(storage,writes) {
    const old = writes.map(([key])=>[key,storage.getItem(key)]);
    let done=0;
    try {
      for (const [key,value] of writes) { if (value===null) storage.removeItem(key); else storage.setItem(key,value); done++; }
    } catch (error) {
      let rollbackFailed=false;
      for (let i=done-1;i>=0;i--) {
        const [key,value]=old[i];
        try { if (value===null) storage.removeItem(key); else storage.setItem(key,value); } catch (_) {rollbackFailed=true;}
      }
      if (rollbackFailed) fail('Storage write and rollback failed. Do not reload; retain your backup and contact support.');
      fail('Storage write failed. Completed writes were rolled back. Free storage space and try again.');
    }
  }
  function restore(plan,storage) { writeBatch(storage,plan.writes); restoring=true; }
  function download(text, prefix='money-buddy-backup') {
    const url=URL.createObjectURL(new Blob([text],{type:'application/json'}));
    const a=document.createElement('a');
    a.href=url; a.download=prefix+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); alert('Copied!'); }
    catch (_) { alert('Clipboard unavailable. Use Download JSON or select and copy the text manually.'); }
  }
  function readPriceMap(storage,key) {
    try { const v=JSON.parse(storage.getItem(key)||'{}'); return priceMap(v)?v:{}; } catch (_) {return {};}
  }
  const api={create,prepareRestore,restore,download,copyText,preserveLegacy,readPriceMap,writeBatch,isRestoring:()=>restoring};
  if (typeof module==='object' && module.exports) module.exports=api;
  else {
    root.MoneyBuddyBackup=api;
    // This runs before the app's automatic CoinGecko refresh on mount.
    try {preserveLegacy(root.localStorage);} catch (error) {console.warn('Legacy price preservation unavailable:',error.message);}
  }
})(typeof window==='undefined'?globalThis:window);
