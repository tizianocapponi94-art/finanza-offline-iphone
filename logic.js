/* Finanze Offline v1: single local financial ledger, no server or network calls. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const asCents=x=>Math.round((Number(x)||0)*100);
const euro=c=>Math.round(c)/100;
const money=x=>Number(x||0).toLocaleString('it-IT',{style:'currency',currency:'EUR'});
const escapeHTML=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dayLocal=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
const monthTitle=m=>new Date(m+'-01T12:00:00').toLocaleDateString('it-IT',{month:'long',year:'numeric'});
const dayTitle=m=>new Date(m+'T12:00:00').toLocaleDateString('it-IT',{day:'numeric',month:'short',year:'numeric'});
const categoryTitle={svago:'Svago',alimentari:'Alimentari',carburante:'Benzina',bollette:'Bollette',condominio:'Condominio',extra:'Altra spesa'};
let S=null;
let messageTimer=null;
function notify(s,bad=false){const el=$('message');el.textContent=s;el.hidden=false;el.classList.toggle('error',bad);clearTimeout(messageTimer);messageTimer=setTimeout(()=>el.hidden=true,4500)}
function validate(s){
  if(!s || s.schema!=='finanze-offline-v1'||!s.baseline||!s.months||!Array.isArray(s.transactions))throw Error('Formato archivio non riconosciuto');
  if(!s.baseline.snapshotMonth || !Number.isFinite(Number(s.baseline.opening)))throw Error('Dati di apertura incompleti');
  const keys=Object.keys(s.months);
  if(keys.length<6 || keys.some(k=>!/^20\d\d-\d\d$/.test(k)))throw Error('Mesi della pianificazione non validi');
  for(const month of keys){
    const obj=s.months[month];
    if(['income','fixed','variable'].some(k=>!Number.isFinite(Number(obj[k])) || Number(obj[k])<0))throw Error('Importo non valido nel mese '+month);
  }
  for(const row of s.transactions){
    if(!row.id || !/^20\d\d-\d\d-\d\d$/.test(row.date) || !Number.isFinite(Number(row.amount))||Number(row.amount)<=0 || !categoryTitle[row.category])throw Error('Movimento non valido');
    if(!['Isybank','Intesa','Revolut','Cash'].includes(row.account))throw Error('Conto sconosciuto');
  }
  if(s.policyVersion===4){
    if(!s.revolutPockets || ['food','free'].some(x=>
        !Number.isFinite(Number(s.revolutPockets[x]))||Number(s.revolutPockets[x])<0))
      throw Error('Ripartizione Revolut non valida');
    if(!Array.isArray(s.transferHistory)||!Array.isArray(s.pocketHistory))
      throw Error('Registri dei conti non validi');
  }
  if(s.bankStatement!==undefined){
    if(!Array.isArray(s.bankStatement)||s.bankStatement.length>1000)throw Error('Archivio movimenti bancari non valido');
    const ids=new Set();
    for(const x of s.bankStatement){
      if(!x.id||ids.has(x.id)||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(x.date)||
         !Number.isFinite(Number(x.amount))||!['pending','matched_existing','applied_extra','settled'].includes(x.reviewStatus||'pending'))
        throw Error('Movimento estratto non valido o duplicato');
      ids.add(x.id);
    }
  }
  return s;
}
function persist(){
 const json=JSON.stringify(S);
 if(window.FinanzeAndroid){
   if(!FinanzeAndroid.saveState(json))throw Error('Impossibile salvare nel telefono');
 }else{
   localStorage.setItem('finanze_offline_iphone_firststart',json);
 }
}
async function load(){
 let raw;
 if(window.FinanzeAndroid)raw=FinanzeAndroid.readState();
 else raw=localStorage.getItem('finanze_offline_iphone_firststart')||await (await fetch('./seed.json')).text();
 S=validate(JSON.parse(raw));
 // iPhone first start intentionally reads NO statements or snapshots from a server.
 // Only the empty first-start seed or a backup explicitly imported by the user.
  try{
    const next=upgradeV4(S);
    if(next!==S){
      const old=S;S=next;
      try{persist()}catch(err){S=old;notify('Impossibile salvare il nuovo piano V4: '+err.message,true)}
    }
  }catch(err){notify('Errore migrazione V4: '+err.message,true)}
  const now=dayLocal();
  $('date').value=now; $('date').max=now;
  $('account').value='Revolut';
  render();
}
function capBudget(base,category){
 const words={alimentari:'alimentar',bollette:'bollett',condominio:'condomini'};
 if(!words[category])return 0;
 const line=(base.details?.fixed||[]).find(x=>
     x.type==='BUDGET_VITA' && x.name.toLocaleLowerCase('it-IT').includes(words[category]));
 return asCents(line?.amount);
}
function futureBaseMonth(month){return S.months[month]}
function forecast(){
 let prev=asCents(S.baseline.opening);
 const ordered=Object.keys(S.months).sort();
 const result=[];
  for(const month of ordered){
   if(month<S.baseline.snapshotMonth)continue;
   const base=futureBaseMonth(month);
   const allRows=S.transactions.filter(t=>t.date.startsWith(month));
   const newRows=allRows.filter(t=>!t.includedInBaseline);
   let spent=0,covered=0;
   const bycat={};
   for(const x of newRows)spent+=asCents(x.amount);
   // Budgets already consumed must remain consumed even when the purchase
   // was reconciled into a fresh bank balance.
   for(const x of allRows)bycat[x.category]=(bycat[x.category]||0)+asCents(x.amount);
   const absorbed={};
   for(const cat of ['alimentari','bollette','condominio']){
     absorbed[cat]=Math.min(bycat[cat]||0,capBudget(base,cat));
     covered+=absorbed[cat];
   }
   const settled=(S.bankStatement||[]).filter(x=>x.reviewStatus==='settled'&&x.matchPlan?.month===month);
   let settledPaid=0,settledFixed=0,settledVariable=0;
   const settledNames={fixed:[],variable:[]};
   for(const line of settled){
     const group=line.matchPlan.group;
     const matched=(base.details?.[group]||[]).find(x=>x.name.toLocaleLowerCase('it-IT')===line.matchPlan.name.toLocaleLowerCase('it-IT'));
     if(!matched)continue;
     const due=Math.min(asCents(matched.amount),asCents(line.matchPlan.expected));
     if(!line.reconciledBySnapshot)settledPaid+=asCents(-line.amount);
     if(group==='fixed'){settledFixed+=due;settledNames.fixed.push(matched.name)}
     if(group==='variable'){settledVariable+=due;settledNames.variable.push(matched.name)}
   }
   const opening=prev-spent-settledPaid;
   const fixed=asCents(base.fixed)-covered-settledFixed;
   const income=asCents(base.income);
   const variable=asCents(base.variable)-settledVariable;
   const goals=asCents(base.goals?.casa||0)+asCents(base.goals?.viaggi||0);
   const ending=opening+income-fixed-variable-goals;
   const item={month,opening,income,fixed,variable,ending,spent,covered,absorbed,base,newRows,
      settledPaid,settledFixed,settledVariable,settledNames,plannedSavings:goals};
   item.protected=protectedFundsFor(item);
   result.push(item);
   prev=ending;
 }
 return result;
}
function visibleMonth(){const today=dayLocal().slice(0,7);const first=S.baseline.snapshotMonth;return today<first?first:today}
function estimateAccounts(){
 const result={...S.baseline.accounts};
 for(const entry of S.transactions){
   if(entry.includedInBaseline)continue;
   result[entry.account]=euro(asCents(result[entry.account])-asCents(entry.amount));
 }
 for(const row of S.bankStatement||[]){
   if(row.reviewStatus!=='settled' || !row.selectedAccount || row.reconciledBySnapshot)continue;
   result[row.selectedAccount]=euro(asCents(result[row.selectedAccount])+asCents(row.amount));
 }
 return result;
}
function getStats(){
 const date=dayLocal(),month=date.slice(0,7);
 return {
   today:S.transactions.filter(x=>x.date===date).reduce((n,x)=>n+asCents(x.amount),0),
   month:S.transactions.filter(x=>x.date.startsWith(month)).reduce((n,x)=>n+asCents(x.amount),0),
   svago:S.transactions.filter(x=>x.date.startsWith(month)&&x.category==='svago').reduce((n,x)=>n+asCents(x.amount),0)
 };
}
function detailRows(rows,adjusted={},alreadyPaid=[]){
 const stillOpen=rows.filter(x=>!alreadyPaid.includes(x.name));
 if(!stillOpen.length)return '<div class="month-detail-row"><span>Nessuna voce ancora aperta</span></div>';
 return stillOpen.map(x=>{
    const k=Object.keys(adjusted).find(key=>({alimentari:'alimentar',bollette:'bollett',condominio:'condomini'}[key]||'@') &&
            x.type==='BUDGET_VITA' && x.name.toLowerCase().includes(({alimentari:'alimentar',bollette:'bollett',condominio:'condomini'}[key]||'@')));
    const rest=asCents(x.amount)-(k?adjusted[k]:0);
    if(rest<=0)return '';
    return '<div class="month-detail-row"><span>'+escapeHTML(x.name)+'</span><strong>'+money(euro(rest))+'</strong></div>';
 }).join('');
}
function breakdown(label,value,detail,cls=''){
 return '<details class="month-line '+cls+'"><summary><span>'+escapeHTML(label)+'</span><strong>'+money(euro(value))+'</strong></summary><div class="month-detail">'+detail+
     '<div class="month-detail-total"><span>Totale</span><strong>'+money(euro(value))+'</strong></div></div></details>';
}
function cardMonth(m,idx){
 const rows=[];
 const a=idx===0?'Patrimonio iniziale rettificato':'Riporto e spese già registrate nel mese';
 rows.push(breakdown(a,m.opening,
    '<div class="month-detail-row"><span>Dal mese precedente, meno spese già registrate</span><strong>'+money(euro(m.opening))+'</strong></div>'));
 rows.push(breakdown('Entrate ancora attese',m.income,detailRows(m.base.details?.income||[])));
 const protectedWithoutGoals=m.protected.total-m.plannedSavings;
 const fixedCommitments=m.fixed-protectedWithoutGoals;
 const isFund=x=>['BUDGET_VITA','FONDO_TASSE'].includes(x.type);
 const fixedDetails=(m.base.details?.fixed||[]).filter(x=>!isFund(x));
 const protectedDetails=m.protected.descriptions.filter(x=>!['Casa futura','Viaggi'].includes(x.name));
 rows.push(breakdown('Impegni fissi ancora da saldare',fixedCommitments,
   detailRows(fixedDetails,{},m.settledNames.fixed)));
 rows.push(breakdown('Fondi da proteggere',protectedWithoutGoals,
   detailRows(protectedDetails)));
 rows.push(breakdown('Spese variabili ancora previste',m.variable,
   detailRows(m.base.details?.variable||[],{},m.settledNames.variable)));
 rows.push(breakdown('NETTO LIBERO A FINE MESE',m.ending,[
    ['+ Apertura',m.opening],['+ Entrate da ricevere',m.income],
    ['? Impegni fissi',-fixedCommitments],['? Fondi protetti',-protectedWithoutGoals],
    ['? Spese variabili',-m.variable],['? Casa e viaggi',-m.plannedSavings]
  ].map(([name,n])=>'<div class="month-detail-row"><span>'+escapeHTML(name)+'</span><strong>'+money(euro(n))+'</strong></div>').join(''),'net'));
 return '<article class="month-card"><header class="month-header"><div><small>'+escapeHTML(idx===0?'MESE ATTUALE':'PREVISIONE')+'</small><h3>'+escapeHTML(monthTitle(m.month))+'</h3></div>'+
    '<div class="month-net"><small>Netto libero previsto</small><strong class="'+(m.ending<0?'negative':'')+'">'+money(euro(m.ending))+'</strong></div></header>'+
    '<div class="month-lines">'+rows.join('')+'</div><p class="month-foot">Il netto esclude spese previste, alimentari e fondi. Benzina e svago entrano solo quando vengono spesi. Non è liquidità già incassata.</p></article>';
}
function mergeBankReviews(state,payload){
  if(payload?.schema!=='finanze-bank-review-v1')throw Error('Aggiornamento bancario non riconosciuto');
  if(payload.baselineHash!==state.baseline.sourceStateHash)throw Error('L’estratto non corrisponde alla base di questa app: importazione bloccata');
  if(!Array.isArray(payload.entries)||payload.entries.length>2000)throw Error('Estratto privo di operazioni valide');
  const next=JSON.parse(JSON.stringify(state));
  const existing=new Set((next.bankStatement||[]).map(x=>x.id));
  if(!Array.isArray(next.bankStatement))next.bankStatement=[];
  for(const row of payload.entries){
    if(!row.id||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(row.date)||
       !Number.isFinite(Number(row.amount))||typeof row.name!=='string')throw Error('Voce dell’estratto non valida');
    if(existing.has(row.id))continue;
    next.bankStatement.push({...row,reviewStatus:'pending'});
    existing.add(row.id);
  }
  next.importedBankFiles=[...new Set([...(next.importedBankFiles||[]),payload.sourceHash])];
  return validate(next);
}
function displayBankName(row){
 if(row.matchPlan?.name==='Agos')return 'Agos ? rata finanziamento';
 if(row.matchPlan?.group==='variable')return 'Saldo carta di credito';
 if(row.kind==='transfer')return 'Giroconto tra conti personali';
 if(row.kind==='withdrawal')return 'Prelievo contanti';
 const label=String(row.name||'Operazione');
 return label.length>58?label.slice(0,57).trimEnd()+'?':label;
}
function bankReviewRow(row,old=false){
 const summary={pending:'DA RIVEDERE',settled:'PAGAMENTO REGISTRATO',
                applied_extra:'SPESA AGGIUNTA',matched_existing:'GIÀ GESTITA'};
 const note=row.suspectedDuplicate?
    '<p class="bank-entry-note">Possibile corrispondenza con i 40 € inseriti sul telefono (14 € + 26 €). Controlla prima di aggiungere di nuovo.</p>':'';
 const status=row.reviewStatus||'pending';
 const included=!!(row.reconciledBySnapshot||row.includedInSnapshot);
 const badges=[
   '<span class="bank-flag '+(row.posted?'ok':'warn')+'">'+(row.posted?'CONTABILIZZATO':'NON CONTABILIZZATO')+'</span>',
   '<span class="bank-flag '+(status==='pending'?'':'ok')+'">'+(included?'GIÀ NEL SALDO CONFERMATO':old?'ANTERIORE AL SALDO':summary[status])+'</span>'
 ];
 if(row.matchPlan)badges.push('<span class="bank-flag">GIÀ PREVISTO NEL PIANO</span>');
 else if(row.kind==='transfer')badges.push('<span class="bank-flag">GIROCONTO / TRASFERIMENTO</span>');
 else if(row.kind==='withdrawal')badges.push('<span class="bank-flag">PRELIEVO, NON SPESA</span>');
 let buttons='';
 if(!old&&row.reviewStatus==='pending'&&row.posted){
   if(row.kind==='planned'&&row.matchPlan)
     buttons='<button class="apply" type="button" data-bank-action="settle" data-bank-id="'+escapeHTML(row.id)+'">Conferma pagamento</button>';
   else if(row.kind==='expense'&&row.amount<0)
     buttons='<button class="apply" type="button" data-bank-action="spend" data-bank-id="'+escapeHTML(row.id)+'">Registra nuova spesa</button>';
   buttons+='<button type="button" data-bank-action="done" data-bank-id="'+escapeHTML(row.id)+'">Già gestita / non duplicare</button>';
 }else if(!old&&row.reviewStatus!=='pending'&&!included){
   buttons='<button type="button" data-bank-action="reset" data-bank-id="'+escapeHTML(row.id)+'">Annulla verifica</button>';
 }
 return '<div class="bank-entry"><div class="bank-entry-top"><div class="bank-entry-name"><b>'+
      escapeHTML(displayBankName(row))+'</b><small>'+escapeHTML(dayTitle(row.date)+' · '+row.sourceCategory)+
      '</small></div><strong class="bank-entry-amount '+(row.amount>0?'bank-credit':'')+'">'+
      (row.amount>0?'+':'')+money(row.amount)+'</strong></div>'+
      '<div class="bank-review-flags">'+badges.join('')+'</div>'+note+
      (buttons?'<div class="bank-action-row">'+buttons+'</div>':'')+'</div>';
}
function renderBankReview(){
 const rows=S.bankStatement||[];
 const panel=$('bankReviewPanel');
 if(!panel)return;
 panel.hidden=!rows.length;
 if(!rows.length)return;
 const after=rows.filter(x=>x.date>S.baseline.snapshotDate);
 const older=rows.filter(x=>x.date<=S.baseline.snapshotDate);
 const open=after.filter(x=>x.reviewStatus==='pending');
 $('bankReviewCount').textContent=open.length+' da verificare';
 $('bankRecent').innerHTML=after.map(x=>bankReviewRow(x,false)).join('')||
   '<p class="small-hint">Nessuna operazione dopo il saldo iniziale.</p>';
 $('bankHistoricCount').textContent='('+older.length+')';
 $('bankHistoric').innerHTML=older.map(x=>bankReviewRow(x,true)).join('');
}
function promptBankAccount(){
 const str=prompt('Da quale conto è uscita questa somma? Scrivi esattamente Isybank, Intesa o Revolut.','');
 if(str===null)return null;
 const account=str.trim();
 if(!['Isybank','Intesa','Revolut'].includes(account)){
   notify('Conto non valido. Usa Isybank, Intesa oppure Revolut.',true);
   return null;
 }
 return account;
}
function actOnBankReview(id,action){
 const row=S.bankStatement?.find(x=>x.id===id);
 if(!row||!['pending','settled','applied_extra','matched_existing'].includes(row.reviewStatus))return;
 if(row.reconciledBySnapshot||row.includedInSnapshot){
   notify('Movimento già incluso nel saldo disponibile verificato. Non può essere addebitato di nuovo.',true);
   return;
 }
 if(action!=='reset'&&row.reviewStatus!=='pending')return;
 if(action!=='reset'&&row.date<=S.baseline.snapshotDate){
   notify('Questa operazione precede il saldo iniziale: non registrarla di nuovo.',true);return;
 }
 const next=JSON.parse(JSON.stringify(S));
 const item=next.bankStatement.find(x=>x.id===id);
 const entryId='stmt_'+row.id;
 if(action==='reset'){
   if(!confirm('Annullare la verifica di '+row.name+'?'))return;
   const charged=next.transactions.find(x=>x.id===entryId);
   if(charged?.account==='Revolut'&&charged.pocketAccounted===true){
     const pocket=charged.category==='alimentari'?'food':'free';
     next.revolutPockets[pocket]=euro(asCents(next.revolutPockets[pocket])+asCents(charged.amount));
   }
   next.transactions=next.transactions.filter(x=>x.id!==entryId);
   item.reviewStatus='pending';
   delete item.selectedAccount;
 }else if(action==='done'){
   if(!confirm('Segnare come già gestita o non-spesa? Questa scelta non cambia il saldo.'))return;
   item.reviewStatus='matched_existing';
 }else if(action==='settle'){
   if(!row.posted||row.kind!=='planned'||!row.matchPlan)return;
   const scheduled=S.months[row.matchPlan.month]?.details?.[row.matchPlan.group]?.find(x=>
       x.name.toLocaleLowerCase('it-IT')===row.matchPlan.name.toLocaleLowerCase('it-IT'));
   if(!scheduled){notify('Scadenza non trovata nel piano; non registro il pagamento.',true);return}
   if((S.bankStatement||[]).some(x=>x.id!==row.id&&x.reviewStatus==='settled'&&x.matchPlan?.name===row.matchPlan.name&&x.matchPlan?.month===row.matchPlan.month)){
     notify('Questo pagamento risulta già confermato.',true);return;
   }
   const account=promptBankAccount();if(!account)return;
   const variance=asCents(scheduled.amount)+asCents(row.amount);
   if(!confirm('Confermi l’addebito '+money(-row.amount)+' da '+account+'?\n'+
       'La spesa prevista '+money(scheduled.amount)+' passerà tra quelle già pagate. '+
       (variance?'Differenza rispetto alla previsione: '+money(euro(variance))+'.':'Il netto previsto non sarà addebitato due volte.')))return;
   item.reviewStatus='settled';
   item.selectedAccount=account;
 }else if(action==='spend'){
   if(!row.posted||row.kind!=='expense'||row.amount>=0)return;
   if(next.transactions.some(x=>x.id===entryId)){notify('Spesa già presente.',true);return}
   const account=promptBankAccount();if(!account)return;
   const defaultCat=row.sourceCategory==='Ristoranti e bar'?'svago':
          row.sourceCategory==='Carburanti'?'carburante':
          row.sourceCategory==='Generi alimentari e supermercato'?'alimentari':'extra';
   const category=prompt('Categoria: svago, alimentari, carburante, bollette, condominio oppure extra.',defaultCat);
   if(category===null)return;
   if(!categoryTitle[category.trim()]){notify('Categoria non valida.',true);return}
   if(account==='Revolut'){
     const pocket=category.trim()==='alimentari'?'food':'free';
     if(asCents(-row.amount)>estimateRevolutPockets()[pocket]){
       notify('Conto Revolut '+(pocket==='food'?'Spesa':'Libero')+
         ' insufficiente. Verifica la ripartizione prima di importare.',true);return;
     }
     next.revolutPockets[pocket]=euro(asCents(next.revolutPockets[pocket])-asCents(-row.amount));
   }
   if(!confirm('Aggiungere davvero '+money(-row.amount)+' ai movimenti giornalieri da '+account+'?\n'+
     'Se li avevi già registrati, premi invece “Già gestita / non duplicare”.'))return;
   next.transactions.push({id:entryId,date:row.date,amount:Math.round(-row.amount*100)/100,
     account,category:category.trim(),note:row.name,
     created_at:new Date().toISOString(),includedInBaseline:false,
     pocketAccounted:account==='Revolut'});
   item.reviewStatus='applied_extra';
   item.selectedAccount=account;
 }else return;
 if(safeSave(next))notify('Verifica estratto salvata sul telefono.');
}

/* Un saldo disponibile reale prevale su tutte le vecchie stime del conto.
   Le transazioni già comprese nel saldo vengono marcate riconciliate. */
function applyBankBalanceSnapshot(state,patch){
 if(patch?.schema!=='finanze-balance-snapshot-v1')throw Error('Aggiornamento saldo non valido');
 if(patch.baseHash!==state.baseline.sourceStateHash)throw Error('Il saldo non corrisponde a questa base finanziaria');
 if(!['Isybank','Intesa','Revolut','Cash'].includes(patch.account))throw Error('Conto non riconosciuto');
 if(!Number.isFinite(Number(patch.available))||Number(patch.available)<0||Number(patch.available)>99999999)
   throw Error('Saldo disponibile non valido');
 if(!/^20\d\d-\d\d-\d\d$/.test(patch.date)||!SmonthsHas(state,patch.date.slice(0,7)))
   throw Error('Data del saldo non presente nella pianificazione');
 if(!Number.isFinite(Date.parse(patch.recordedAt)))throw Error('Data aggiornamento saldo non valida');
 if((state.appliedBalanceUpdates||[]).includes(patch.id))return state;
 const result=JSON.parse(JSON.stringify(state));
 const capturedAt=Date.parse(patch.recordedAt);
 const account=patch.account;
 // Comprende le transazioni di questo conto inserite fino alla fotografia bancaria.
 // Quelle registrate DOPO la fotografia continuano invece a diminuire il patrimonio.
 for(const expense of result.transactions){
   if(expense.account!==account||expense.includedInBaseline)continue;
   const stamped=Date.parse(expense.created_at||'');
   if(Number.isFinite(stamped)&&stamped<=capturedAt){
     expense.includedInBaseline=true;
     expense.reconciledAt=patch.recordedAt;
   }
 }
 for(const item of result.bankStatement||[]){
   if(item.date>patch.date)continue;
   if(item.reviewStatus==='settled'&&item.selectedAccount===account){
     item.reconciledBySnapshot=true;
   }else if(item.reviewStatus==='applied_extra'&&item.selectedAccount===account){
     const entry=result.transactions.find(x=>x.id==='stmt_'+item.id);
     if(entry){entry.includedInBaseline=true;entry.reconciledAt=patch.recordedAt;}
     item.reconciledBySnapshot=true;
   }else if(item.posted&&item.date>='2026-11-14'&&account==='Isybank'){
     if(item.kind==='planned'&&item.matchPlan){
       item.reviewStatus='settled';
       item.selectedAccount=account;
       item.reconciledBySnapshot=true;
     }else if(item.reviewStatus==='pending'||item.reviewStatus==='matched_existing'){
       // È già nel saldo bancario; non proporre di addebitarlo un'altra volta.
       // L'operazione resta consultabile nello storico dell'estratto.
       item.reviewStatus='matched_existing';
       item.includedInSnapshot=true;
     }
   }
 }
 result.baseline.accounts[account]=Math.round(Number(patch.available)*100)/100;
 result.baseline.opening=euro(Object.values(result.baseline.accounts)
   .reduce((sum,x)=>sum+asCents(x),0));
 if(patch.date>=result.baseline.snapshotDate){
   result.baseline.snapshotDate=patch.date;
   result.baseline.snapshotMonth=patch.date.slice(0,7);
 }
 result.appliedBalanceUpdates=[...(result.appliedBalanceUpdates||[]),patch.id];
 result.bankBalanceHistory=[...(result.bankBalanceHistory||[]),{
   id:patch.id,account,available:Number(patch.available),date:patch.date,
   recordedAt:patch.recordedAt,source:patch.source||'Inserimento manuale',
   previousEstimated:state.baseline.accounts[account]
 }];
 return validate(result);
}
function SmonthsHas(s,month){return Object.prototype.hasOwnProperty.call(s.months,month)}
function lastBankUpdate(account){
 return [...(S.bankBalanceHistory||[])].reverse().find(x=>x.account===account);
}
function renderBankAccounts(){
 const accounts=estimateAccounts();
 const names=['Isybank','Intesa','Revolut'];
 $('walletAccounts').innerHTML=names.map(account=>{
   const record=lastBankUpdate(account);
   const caption=record?'Saldo dichiarato '+dayTitle(record.date):
       'Ultimo saldo disponibile in archivio';
   return '<div class="wallet-row"><div class="wallet-row-name"><b>'+account+'</b>'+
     '<small>'+escapeHTML(caption)+'</small></div>'+
     '<div class="wallet-row-right"><strong>'+money(accounts[account])+'</strong>'+
     '<button type="button" data-edit-bank="'+account+'">Aggiorna</button></div></div>';
 }).join('');
}
function changeBankAvailable(account){
 if(!['Isybank','Intesa','Revolut','Cash'].includes(account))return;
 const current=estimateAccounts()[account];
 const input=prompt('Saldo DISPONIBILE attuale di '+account+' (euro).\n'+
   'Leggilo direttamente nell’app bancaria, senza sottrarre di nuovo i pagamenti.',current.toFixed(2).replace('.',','));
 if(input===null)return;
 const amount=Number(input.trim().replace(',','.'));
 if(!input.trim()||!Number.isFinite(amount)||amount<0||amount>99999999){
   notify('Inserisci un saldo disponibile valido.',true);return;
 }
 const now=dayLocal();
 if(!SmonthsHas(S,now.slice(0,7))){
   notify('Non sono presenti i dati del mese attuale: importa prima un piano aggiornato.',true);return;
 }
 if(!confirm('Confermi '+money(amount)+' di saldo disponibile '+account+'?\n'+
   'Il saldo sostituirà la vecchia stima e riconcilierà le operazioni già comprese nel conto.'))return;
 const patch={schema:'finanze-balance-snapshot-v1',
   id:'saldo_'+account+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,9),
   baseHash:S.baseline.sourceStateHash,
   account,available:amount,date:now,recordedAt:new Date().toISOString(),
   source:'Saldo disponibile inserito manualmente sul telefono'};
 try{
   const next=applyBankBalanceSnapshot(S,patch);
   if(safeSave(next))notify('Saldo '+account+' aggiornato. Previsioni ricalcolate senza duplicare le spese.');
 }catch(e){notify('Non riesco ad aggiornare: '+e.message,true)}
}

/* Regole V4. Nessun budget fisso per Svago o benzina.
   Le somme di Revolut Spesa e Libero sono registri manuali, non API bancarie. */
function monthFuelLine(line){
 return line?.type==='BUDGET_VITA' &&
   /benzina|carburante/i.test(line.name||'');
}
function adjustMonthlyPolicy(month){
 const m={...month};
 const fixedRows=(m.details?.fixed||[]);
 const fuel=fixedRows.filter(monthFuelLine);
 if(fuel.length){
   m.details={...m.details,fixed:fixedRows.filter(x=>!monthFuelLine(x))};
   m.fixed=euro(asCents(m.fixed)-fuel.reduce((n,x)=>n+asCents(x.amount),0));
   const reservedFuel=fuel.filter(x=>x.status==='ACCANTONATO');
   m.reservedFixed=euro(Math.max(0,asCents(m.reservedFixed)-
       reservedFuel.reduce((n,x)=>n+asCents(x.amount),0)));
 }
 m.goals={...(m.goals||{})};
 delete m.goals.svago;
 return m;
}
function estimateAccountsForState(state){
 const b={...state.baseline.accounts};
 for(const e of state.transactions||[]){
   if(e.includedInBaseline)continue;
   b[e.account]=euro(asCents(b[e.account])-asCents(e.amount));
 }
 for(const x of state.bankStatement||[]){
   if(x.reviewStatus==='settled'&&x.selectedAccount&&!x.reconciledBySnapshot)
     b[x.selectedAccount]=euro(asCents(b[x.selectedAccount])+asCents(x.amount));
 }
 return b;
}
function upgradeV4(old){
 const next=JSON.parse(JSON.stringify(old));
 let changed=false;
 for(const [month,base] of Object.entries(next.months)){
   const fuel=(base.details?.fixed||[]).filter(monthFuelLine);
   if(fuel.length || Object.prototype.hasOwnProperty.call(base.goals||{},'svago')){
     next.months[month]=adjustMonthlyPolicy(base);changed=true;
   }
 }
 if(!next.revolutPockets){
   const account=estimateAccountsForState(next).Revolut;
   const total=Math.max(0,asCents(account));
   const groceries=Math.min(30000,total);
   next.revolutPockets={food:euro(groceries),free:0,
     createdAt:new Date().toISOString(),source:'Ripartizione iniziale da confermare'};
   changed=true;
 }
 // Old Revolut purchases were already reflected in the initial pocket snapshot.
 // Do not add them back to a pocket if an earlier purchase is later corrected.
 for(const e of next.transactions){
   if(e.account==='Revolut'&&e.pocketAccounted===undefined){
     e.pocketAccounted=false;changed=true;
   }
 }
 if(!Array.isArray(next.transferHistory)){next.transferHistory=[];changed=true}
 if(!Array.isArray(next.pocketHistory)){next.pocketHistory=[];changed=true}
 if(next.policyVersion!==4){next.policyVersion=4;changed=true}
 return changed?validate(next):old;
}
function protectedFundsFor(month){
 const m=month.base;
 const rows=m.details?.fixed||[];
 const kinds=['BUDGET_VITA','FONDO_TASSE'];
 let pool=0,descriptions=[];
 for(const x of rows){
   if(!kinds.includes(x.type)||month.settledNames.fixed.includes(x.name))continue;
   let amount=asCents(x.amount);
   if(x.type==='BUDGET_VITA'){
     let cat= /alimentar/i.test(x.name)?'alimentari':
              /bollett/i.test(x.name)?'bollette':
              /condomin/i.test(x.name)?'condominio':null;
     if(cat)amount-=month.absorbed[cat]||0;
   }
   if(amount>0){
     pool+=amount;
     descriptions.push({name:x.name,amount:euro(amount)});
   }
 }
 const goals=asCents(m.goals?.casa||0)+asCents(m.goals?.viaggi||0);
 if(asCents(m.goals?.casa||0)>0)descriptions.push({name:'Casa futura',amount:m.goals.casa});
 if(asCents(m.goals?.viaggi||0)>0)descriptions.push({name:'Viaggi',amount:m.goals.viaggi});
 return {total:pool+goals,descriptions,plannedSavings:goals};
}
function currentFreeSummary(){
 const months=forecast(),curr=months.find(x=>x.month===visibleMonth());
 if(!curr)return null;
 const balances=estimateAccounts();
 const bankTotal=Object.values(balances).reduce((n,v)=>n+asCents(v),0);
 const protectedFunds=curr.protected.total;
 const due=curr.fixed+curr.variable+curr.plannedSavings;
 const free=bankTotal-due;
 return {
   month:curr.month,bankTotal,free,protectedFunds,
   patrAfterCommitments:free+protectedFunds,
   mandatoryDue:due-protectedFunds,
   currentMonth:curr,
   accounts:balances
 };
}
function reservedAccount(month,type){
 if(!month)return 0;
 const b=month.base.details?.fixed||[];
 const due=b.filter(x=>!month.settledNames.fixed.includes(x.name));
 if(type==='Isybank'){
   const fixed=due.filter(x=>
     x.type!=='BUDGET_VITA'&&x.type!=='FONDO_TASSE'&&!/mutuo/i.test(x.name))
     .reduce((n,x)=>n+asCents(x.amount),0);
   const card=(month.base.details?.variable||[]).filter(x=>
     !month.settledNames.variable.includes(x.name)&&/carta di credito|saldo carta/i.test(x.name))
     .reduce((n,x)=>n+asCents(x.amount),0);
   return fixed+card;
 }
 if(type==='Intesa')return due.filter(x=>/mutuo/i.test(x.name))
    .reduce((n,x)=>n+asCents(x.amount),0);
 return 0;
}
function estimateRevolutPockets(){
 const total=asCents(estimateAccounts().Revolut);
 const food=asCents(S.revolutPockets?.food);
 const free=asCents(S.revolutPockets?.free);
 return {total,food,free,unassigned:total-food-free};
}
function availableToTransfer(from){
 const months=forecast(),current=months.find(x=>x.month===visibleMonth());
 const next=months.find(x=>x.month>visibleMonth());
 const a=estimateAccounts();
 let reserve=0;
 if(from==='Isybank')reserve=Math.max(reservedAccount(current,'Isybank'),
                                     reservedAccount(next,'Isybank'));
 if(from==='Intesa'){
   const fund=protectedFundsFor(current).descriptions.filter(x=>
     /bollett|condomin|casa|viaggi|tass|fisc/i.test(x.name))
     .reduce((sum,x)=>sum+asCents(x.amount),0);
   reserve=reservedAccount(next,'Intesa')+fund;
 }
 return Math.max(0,asCents(a[from])-reserve);
}
function adjustRevolutPockets(){
 const total=asCents(estimateAccounts().Revolut);
 if(total<0){notify('Saldo Revolut negativo: aggiorna prima i saldi.',true);return}
 const old=estimateRevolutPockets();
 const foodText=prompt('Quanto risulta nel conto Revolut SPESA (in €)?',euro(old.food).toFixed(2));
 if(foodText===null)return;
 const food=Number(foodText.trim().replace(',','.'));
 if(!Number.isFinite(food)||food<0||asCents(food)>total){notify('Importo spesa maggiore del totale Revolut.',true);return}
 const freeText=prompt('Quanto risulta nel conto Revolut LIBERO (in €)?',euro(old.free).toFixed(2));
 if(freeText===null)return;
 const free=Number(freeText.trim().replace(',','.'));
 if(!Number.isFinite(free)||free<0||asCents(free)+asCents(food)>total){
   notify('I due saldi non possono superare il totale Revolut.',true);return
 }
 const extra=total-asCents(food)-asCents(free);
 if(!confirm('Confermi Revolut Spesa '+money(food)+', Libero '+money(free)+
   (extra?' e '+money(euro(extra))+' ancora da ripartire?':'?')+
   '\nQuesto aggiorna solo il registro dell’app, non sposta soldi in banca.'))return;
 const next=JSON.parse(JSON.stringify(S));
 next.revolutPockets={food:euro(asCents(food)),free:euro(asCents(free)),
   createdAt:new Date().toISOString(),source:'Ripartizione confermata manualmente'};
 next.pocketHistory.push({time:new Date().toISOString(),food:next.revolutPockets.food,
   free:next.revolutPockets.free,kind:'Manuale'});
 if(safeSave(next))notify('Conti Revolut aggiornati.');
}
function recordFreeTransfer(){
 const sourceText=prompt('Hai GIÀ fatto il trasferimento in banca?\nDa quale conto? Scrivi Isybank o Intesa.','Isybank');
 if(sourceText===null)return;
 const from=sourceText.trim();
 if(!['Isybank','Intesa'].includes(from)){notify('Conto di origine non valido.',true);return}
 const max=availableToTransfer(from);
 const estimate=estimateAccounts();
 const raw=prompt('Quanto hai già trasferito da '+from+' a Revolut LIBERO? (euro)\n'+
   'Disponibile dopo gli impegni già previsti: '+money(euro(max)),euro(max).toFixed(2));
 if(raw===null)return;
 const amount=Number(raw.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<=0||asCents(amount)>max){
   notify('Importo superiore alla disponibilità prudenziale di '+from+'.',true);return;
 }
 const cents=asCents(amount);
 if(!confirm('Confermi di aver GIÀ trasferito '+money(euro(cents))+' da '+from+
   ' a Revolut LIBERO?\nNon verrà disposto alcun bonifico. Il patrimonio totale resterà invariato.'))return;
 const next=JSON.parse(JSON.stringify(S));
 next.baseline.accounts[from]=euro(asCents(next.baseline.accounts[from])-cents);
 next.baseline.accounts.Revolut=euro(asCents(next.baseline.accounts.Revolut)+cents);
 next.baseline.opening=euro(Object.values(next.baseline.accounts).reduce((n,x)=>n+asCents(x),0));
 next.revolutPockets.free=euro(asCents(next.revolutPockets.free)+cents);
 next.transferHistory.push({id:'transfer_'+Date.now(),date:dayLocal(),from,to:'Revolut libero',
    amount:euro(cents),createdAt:new Date().toISOString(),status:'Già effettuato in banca'});
 if(safeSave(next))notify('Trasferimento registrato. Conti aggiornati, patrimonio invariato.');
}
function undoLastTransfer(){
 const e=S.transferHistory?.at(-1);
 if(!e)return;
 const lastSnapshot=(S.bankBalanceHistory||[]).some(x=>
   ['Revolut',e.from].includes(x.account)&&
   Number.isFinite(Date.parse(x.recordedAt))&&Date.parse(x.recordedAt)>Date.parse(e.createdAt));
 if(lastSnapshot){
   notify('Dopo il trasferimento hai aggiornato un saldo bancario. Non puoi annullarlo qui: riallinea i saldi reali.',true);
   return;
 }
 if(asCents(S.revolutPockets.free)<asCents(e.amount)){
   notify('Il conto Revolut libero contiene meno del trasferimento. Correggi prima i movimenti registrati.',true);return;
 }
 if(!confirm('Annullare solo la registrazione di '+money(e.amount)+' da '+e.from+' a Revolut Libero?\n'+
             'Non viene effettuato alcun bonifico vero.'))return;
 const next=JSON.parse(JSON.stringify(S));
 const amount=asCents(e.amount);
 next.baseline.accounts[e.from]=euro(asCents(next.baseline.accounts[e.from])+amount);
 next.baseline.accounts.Revolut=euro(asCents(next.baseline.accounts.Revolut)-amount);
 next.baseline.opening=euro(Object.values(next.baseline.accounts).reduce((v,x)=>v+asCents(x),0));
 next.revolutPockets.free=euro(asCents(next.revolutPockets.free)-amount);
 next.transferHistory.pop();
 if(safeSave(next))notify('Registrazione del trasferimento annullata.');
}
function renderAccountRoles(){
 const curr=forecast().find(x=>x.month===visibleMonth());
 const next=forecast().find(x=>x.month>visibleMonth());
 const a=estimateAccounts();
 const isy=Math.max(reservedAccount(curr,'Isybank'),
                      reservedAccount(next,'Isybank'));
 const fundIntesa=curr.protected.descriptions.filter(x=>
   /bollett|condomin|casa|viaggi|tass|fisc/i.test(x.name))
   .reduce((sum,x)=>sum+asCents(x.amount),0);
 const mortgage=reservedAccount(next,'Intesa')+fundIntesa;
 $('isyNeeded').textContent=money(euro(isy));
 $('intesaNeeded').textContent=money(euro(mortgage));
 $('isyWarning').hidden=asCents(a.Isybank)>=isy;
 $('isyWarning').textContent='Attenzione: su Isybank mancano '+money(euro(isy-asCents(a.Isybank)))+
    ' per garantire anche le prossime rate e gli abbonamenti. Aspetta gli incassi prima di trasferire denaro.';
 $('intesaWarning').hidden=!next||asCents(a.Intesa)>=mortgage;
 $('intesaWarning').textContent='Mutuo del mese successivo e fondi di Intesa: '+money(euro(mortgage))+
    '. Il saldo attuale non li copre completamente; non trasferire denaro prima di verificare le entrate.';
 const pockets=estimateRevolutPockets();
 $('revolutFood').textContent=money(euro(pockets.food));
 $('revolutFree').textContent=money(euro(pockets.free));
 const diff=pockets.unassigned;
 $('pocketUnassigned').textContent=diff===0?'Ripartizione totale Revolut completa (da verificare con l’app bancaria).':
   diff>0?money(euro(diff))+' su Revolut ancora da ripartire tra i due conti.':
   'Attenzione: la somma dei due conti Revolut supera il saldo totale di '+money(euro(-diff))+
    '. Allinea la ripartizione.';
 $('pocketUnassigned').classList.toggle('warning',diff<0);
 const hist=S.transferHistory||[];
 $('transferCount').textContent=hist.length?'('+hist.length+')':'';
 $('transferList').innerHTML=hist.slice(-8).reverse().map((x,i)=>
   '<div class="wallet-row"><div class="wallet-row-name"><b>'+escapeHTML(x.from)+' → Revolut libero</b>'+
   '<small>'+escapeHTML(dayTitle(x.date)+' · '+x.status)+'</small></div>'+
   '<div class="wallet-row-right"><strong>'+money(x.amount)+'</strong>'+
   (i===0?'<button type="button" id="undoLastTransfer">Annulla</button>':'')+
   '</div></div>').join('')||
   '<p class="small-hint">Ancora nessun trasferimento registrato.</p>';
}

function render(){
 if(!S)return;
 const projections=forecast();
 const current=visibleMonth();
 const actual=projections.find(x=>x.month===current);
 const stats=getStats();
 const accounts=estimateAccounts();
 const equity=Object.values(accounts).reduce((n,x)=>n+asCents(x),0);
 $('equityNow').textContent=money(euro(equity));
 const free=currentFreeSummary();
 $('freeNow').textContent=free?money(euro(free.free)):'—';
 $('freeNow').classList.toggle('negative',!!free&&free.free<0);
 $('fundsAndNet').textContent=free?money(euro(free.patrAfterCommitments)):'—';
 $('protectedFunds').textContent=free?money(euro(free.protectedFunds)):'—';
 renderBankAccounts();
 renderAccountRoles();
 $('todaySpent').textContent=money(euro(stats.today));
 $('monthSpent').textContent=money(euro(stats.month));
 $('monthNet').textContent=actual?money(euro(actual.ending)):'Da aggiornare';
 const goals=S.months[current]?.goals||{};
 $('houseGoal').textContent=money(goals.casa||0);
 $('travelGoal').textContent=money(goals.viaggi||0);
 const monthList=projections.filter(m=>m.month>=current).slice(0,6);
 $('monthCards').innerHTML=monthList.map(cardMonth).join('')||
    '<div class="panel">Il calendario è terminato: importa il piano dei nuovi mesi per continuare.</div>';
 const entries=[...S.transactions].sort((a,b)=>b.date.localeCompare(a.date)||String(b.created_at||'').localeCompare(String(a.created_at||'')));
 renderBankReview();
 $('historyCount').textContent=entries.length+' spese';
 $('historyList').innerHTML=entries.map(x=>'<div class="history-item"><div class="history-info"><b>'+escapeHTML(x.note||categoryTitle[x.category])+'</b>'+
   '<small>'+escapeHTML(dayTitle(x.date)+' · '+x.account+' · '+categoryTitle[x.category])+
   (x.includedInBaseline?(x.reconciledAt?' · Già incluso nel saldo':' · Importato da V4'):'')+'</small></div><div class="history-amount"><strong>−'+money(x.amount)+'</strong>'+
   (!x.includedInBaseline?'<button type="button" data-undo="'+escapeHTML(x.id)+'">Annulla</button>':'')+'</div></div>').join('')||
   '<div class="small-hint">Nessuna spesa registrata.</div>';
}
function safeSave(next){
  const before=S;
  try{S=validate(upgradeV4(next));persist();render();return true}catch(e){S=before;notify(e.message,true);return false}
}
function addExpense(ev){
 ev.preventDefault();
 const amount=Number($('amount').value),account=$('account').value,category=$('category').value,date=$('date').value;
 const note=$('note').value.trim().slice(0,100);
 if(!Number.isFinite(amount)||amount<=0||amount>100000 || !['Isybank','Intesa','Revolut'].includes(account)||
   !categoryTitle[category]||!/^20\d\d-\d\d-\d\d$/.test(date)||date>dayLocal()||date<S.baseline.snapshotDate||!S.months[date.slice(0,7)]){
    notify('Controlla importo, conto, categoria e data.',true);return;
 }
 const budget=category==='alimentari'||category==='bollette'||category==='condominio';
 const msg='Registrare '+money(amount)+' da '+account+' il '+dayTitle(date)+'? '+
    (budget?'La quota già prevista verrà consumata una sola volta.':'Questa spesa riduce il netto previsto.');
 if(account==='Revolut'){
   const pockets=estimateRevolutPockets();
   const pocket=category==='alimentari'?'food':'free';
   if(asCents(amount)>pockets[pocket]){
     notify('Saldo del conto Revolut '+(pocket==='food'?'Spesa':'Libero')+
         ' insufficiente. Allinea i conti o registra prima un trasferimento già effettuato.',true);
     return;
   }
 }
 if(category==='alimentari'&&account!=='Revolut'&&
    !confirm('Di norma la spesa alimentare viene pagata con Revolut. Confermi che questa spesa è uscita davvero da '+account+'?'))return;
 if(!confirm(msg))return;
 const next=JSON.parse(JSON.stringify(S));
 if(account==='Revolut'){
   const key=category==='alimentari'?'food':'free';
   next.revolutPockets[key]=euro(asCents(next.revolutPockets[key])-asCents(amount));
 }
 const identifier='phone_'+Date.now()+'_'+Math.random().toString(36).slice(2,11);
 next.transactions.push({id:identifier,date,amount:Math.round(amount*100)/100,account,category,
   note:note||categoryTitle[category],created_at:new Date().toISOString(),includedInBaseline:false,
   pocketAccounted:account==='Revolut'});
 if(safeSave(next)){
   $('amount').value='';$('note').value='';notify('Spesa salvata sul telefono. Patrimonio e sei mesi aggiornati.');
 }
}
function undo(id){
 const item=S.transactions.find(x=>x.id===id);
 if(!item||item.includedInBaseline)return;
 if(!confirm('Annullare '+money(item.amount)+' · '+item.note+'?'))return;
 const next=JSON.parse(JSON.stringify(S));
 next.transactions=next.transactions.filter(x=>x.id!==id);
 if(item.account==='Revolut'&&item.pocketAccounted===true&&next.revolutPockets){
   const key=item.category==='alimentari'?'food':'free';
   next.revolutPockets[key]=euro(asCents(next.revolutPockets[key])+asCents(item.amount));
 }
 const review=next.bankStatement?.find(x=>'stmt_'+x.id===id);
 if(review && review.reviewStatus==='applied_extra'){
   review.reviewStatus='pending';
   delete review.selectedAccount;
 }
 if(safeSave(next))notify('Inserimento annullato; saldi stimati ripristinati.');
}
function mergeImported(payload){
 // A First start backup replaces this companion profile only with explicit
 // user approval. Never mix in archives from the owner's V31 app.
 if(S.firstStart){
  if(payload?.schema!=='finanze-offline-v1'||payload.firstStart!==true||
    Number(payload.policyVersion)<32)
   throw Error('First start può importare solo backup creati da First start.');
  return validate(v5Clone(payload));
 }
 if(payload?.schema==='finanze-bank-review-v1')
   return mergeBankReviews(S,payload);
 if(payload?.schema==='finanze-plan-update-v1'){
   if(payload.baseHash && payload.baseHash!==S.baseline.sourceStateHash)throw Error('Piano non riferito al tuo archivio: per sicurezza non importato.');
   const next=JSON.parse(JSON.stringify(S));
   const changed=Object.entries(payload.months||{});
   if(!changed.length)throw Error('Nessun mese da aggiornare');
   for(const [month,patch] of changed){
     if(!next.months[month])throw Error('Mese '+month+' non disponibile nella V1');
     const obj={...next.months[month],...patch};
     if(!obj.details)obj.details=next.months[month].details;
     next.months[month]=obj;
   }
   return validate(next);
 }
 if(payload?.schema==='finanze-offline-v1'){
   const incoming=validate(payload);
   if(incoming.baseline.sourceStateHash!==S.baseline.sourceStateHash){
     throw Error('Il file proviene da una diversa base finanziaria. Nessun dato è stato sovrascritto.');
   }
   const next=JSON.parse(JSON.stringify(S));
   next.months={...next.months,...incoming.months};
   const ids=new Set(next.transactions.map(x=>x.id));
   for(const row of incoming.transactions)if(!ids.has(row.id)){next.transactions.push(row);ids.add(row.id)}
   if(incoming.bankStatement?.length){
     const seen=new Set((next.bankStatement||[]).map(x=>x.id));
     if(!next.bankStatement)next.bankStatement=[];
     for(const row of incoming.bankStatement)if(!seen.has(row.id)){
       next.bankStatement.push(row);seen.add(row.id);
     }
   }
   for(const field of ['manualEntries','monthlyChecks','foodCashEvents','transferHistory','pocketHistory',
       'v8ExtraSavings','v8ExtraPlans','v8TaxCorrections','v9Transfers']){
     const seen=new Set((next[field]||[]).map(x=>x.id||JSON.stringify(x)));
     if(!Array.isArray(next[field]))next[field]=[];
     for(const row of incoming[field]||[]){
       const key=row.id||JSON.stringify(row);
       if(!seen.has(key)){next[field].push(row);seen.add(key);}
     }
   }
   // Loan metadata is exported in full and merged by stable ID. The newer
   // edit wins, so restoring a recent backup also restores financing updates.
   if(Array.isArray(incoming.v24Loans)){
     const byId=new Map((next.v24Loans||[]).map(row=>[row.id,row]));
     for(const row of incoming.v24Loans){
       if(!row?.id)continue;
       const old=byId.get(row.id);
       if(!old||(row.updatedAt||'')>(old.updatedAt||''))byId.set(row.id,row);
     }
     next.v24Loans=[...byId.values()];
   }
   next.foodSpentByMonth={...(incoming.foodSpentByMonth||{}),...(next.foodSpentByMonth||{})};
   next.v9AccountOverrides={...(incoming.v9AccountOverrides||{}),...(next.v9AccountOverrides||{})};
   // The phone's current bank balances always win over older backups.
   return validate(next);
 }
 throw Error('File non riconosciuto. Importa un backup Finanze o un aggiornamento mensile JSON.');
}
window.receiveImportedFile=function(json){
 try{
   const imported=JSON.parse(json);
   const next=mergeImported(imported);
   if(!confirm(S.firstStart?
     'Ripristinare il backup First start? Sostituirà i dati attuali di questa app, senza modificare l’app principale.':
     'Importare il file? Il programma conserva le spese già registrate sul telefono e non applica automaticamente nuovi addebiti.'))return;
   if(safeSave(next)){
     notify('Aggiornamento importato; spese conservate.');
     if(S.policyVersion<17)window.location.reload();
   }
 }catch(e){notify(e.message||String(e),true)}
};
window.receiveExportStatus=function(msg){notify(msg)};
function exportData(){
 const payload=JSON.stringify(S,null,2);
 if(window.FinanzeAndroid) FinanzeAndroid.exportJson(payload);
 else{
   const url=URL.createObjectURL(new Blob([payload],{type:'application/json'}));
   const a=document.createElement('a');a.href=url;a.download=(S.firstStart?
     'Finanza_First_start_backup_':'Finanze_backup_')+dayLocal()+'.json';a.click();
   setTimeout(()=>URL.revokeObjectURL(url),500);
 }
}
function importData(){
 if(window.FinanzeAndroid) FinanzeAndroid.importJson();
 else{
   const f=document.createElement('input');f.type='file';f.accept='.json,application/json';
   f.onchange=async()=>{if(f.files[0])window.receiveImportedFile(await f.files[0].text())};
   f.click();
 }
}

/* FINANZE OFFLINE V5: diario netto rapido e scadenziario operativo.
 * Migrazione non distruttiva dalla V4: tutte le spese e i saldi restano salvati.
 * Le spunte salvate hanno stato separato dai movimenti già presenti in banca.
 */
const V5_KINDS=['Colazione','Tabacco','Cena','Sfizi','Altro'];
let v5Section='home',v5QuickKind='Colazione',v5AddKind='fixed';
let v5Period=dayLocal().slice(0,7);
const v5Clone=x=>JSON.parse(JSON.stringify(x));
function v5Months(){return Object.keys(S.months).sort()}
function v5LegalMonth(m){return v5Months().includes(m)}
function v5Upgrade(src){
 // This independent First start app has no legacy personal migrations.
 if(src.firstStart===true&&src.policyVersion>=32)return src;
 const state=v5Clone(src);let changed=false;
 for(const [month,base] of Object.entries(state.months)){
   if((base.details?.fixed||[]).some(monthFuelLine)||Object.hasOwn(base.goals||{},'svago')){
     state.months[month]=adjustMonthlyPolicy(base);changed=true;
   }
 }
 if(!Array.isArray(state.monthlyChecks)){state.monthlyChecks=[];changed=true}
 if(!Array.isArray(state.manualEntries)){state.manualEntries=[];changed=true}
 if(!state.foodSpentByMonth){state.foodSpentByMonth={};changed=true}
 if(!Array.isArray(state.foodCashEvents)){state.foodCashEvents=[];changed=true}
 if(!Array.isArray(state.actualFundHistory)){state.actualFundHistory=[];changed=true}
 if(state.actualFunds===undefined){state.actualFunds=0;changed=true}
 if(state.foodSpentByMonth['2026-11']===undefined){
   // Totale dichiarato dall'utente già contenuto negli ultimi saldi.
   state.foodSpentByMonth['2026-11']=150;changed=true;
 }
 if((Number(state.policyVersion)||0)<5){state.policyVersion=5;changed=true}
 return changed?validate(state):src;
}
function v5Save(next){
 const old=S;
 try{
   S=v5Upgrade(next);
   if(S.policyVersion===16)S=v17Upgrade(S);
   if(S.policyVersion===17)S=v18Upgrade(S);
   if(S.policyVersion===18)S=v19Upgrade(S);
   if(S.policyVersion===19)S=v20Upgrade(S);
   if(S.policyVersion===20)S=v21Upgrade(S);
   if(S.policyVersion===21)S=v22Upgrade(S);
   if(S.policyVersion===22)S=v23Upgrade(S);
   if(S.policyVersion===23)S=v24Upgrade(S);
   if(S.policyVersion===24)S=v25Upgrade(S);
   if(S.policyVersion===25)S=v26Upgrade(S);
   if(S.policyVersion===26)S=v27Upgrade(S);
   if(S.policyVersion===27)S=v28Upgrade(S);
   if(S.policyVersion===28)S=v29Upgrade(S);
   if(S.policyVersion===29)S=v30Upgrade(S);
   if(S.policyVersion===30)S=v31Upgrade(S);
   persist();
   v5Render();
   return true;
 }catch(err){S=old;notify('Salvataggio non riuscito: '+err.message,true);return false}
}
function v5AccountBalances(){
 const a=estimateAccounts();
 for(const c of S.monthlyChecks||[]){
   if(c.status!=='done'||c.reconciled||!c.charge)continue;
   a[c.account]=euro(asCents(a[c.account])+(c.kind==='income'?c.cashCents:-c.cashCents));
 }
 for(const c of S.foodCashEvents||[]){
   if(!c.reconciled)a.Revolut=euro(asCents(a.Revolut)-c.amountCents);
 }
 if(S.policyVersion>=9){
   for(const t of S.v9Transfers||[]){
     if(t.cancelled)continue;
     if(!t.fromReconciled)a[t.from]=euro(asCents(a[t.from])-t.amountCents);
     if(!t.toReconciled)a[t.to]=euro(asCents(a[t.to])+t.amountCents);
   }
 }
 if(S.policyVersion>=11){
   // The monthly food allocation is a virtual payment FROM Isybank.
   // Debit that specific account exactly once, not a separate invisible
   // reduction of global net worth.
   a.Isybank=euro(asCents(a.Isybank)-v6ExternalPending());
 }
 return a;
}
function v5Key(month,kind,x){
 return [month,kind,x.date,x.name].join('|');
}
function v5KnownPaid(month,kind,row,complete=false){
 if(complete)return true;
 const group=kind==='extra'?'variable':kind;
 return (S.bankStatement||[]).some(x=>x.reviewStatus==='settled'&&
   x.matchPlan?.month===month&&x.matchPlan.group===group&&
   x.matchPlan.name.toLocaleLowerCase('it-IT')===row.name.toLocaleLowerCase('it-IT'));
}
function v5Catalog(month,kind){
 const m=S.months[month];if(!m)return [];
 const group=kind==='extra'?'variable':kind;
 let rows=[];
 for(const x of m.completed?.[group]||[]){
   rows.push({id:v5Key(month,kind,x),month,kind, ...x,planned:false,confirmed:true,manual:false});
 }
 for(const x of m.details?.[group]||[]){
   const grocery=kind==='fixed'&&x.type==='BUDGET_VITA'&&/alimentar/i.test(x.name);
   rows.push({id:v5Key(month,kind,x),month,kind, ...x,
      planned:true,confirmed:v5KnownPaid(month,kind,x),manual:false,
      grocery,account:x.account||(grocery?'Cointestato esterno':kind==='income'?
        /familiari/i.test(x.name)?'Cash':/affitto/i.test(x.name)?'Intesa':'Isybank':
        /mutuo|condomin|bollett/i.test(x.name)?'Intesa':
        /carta di credito|saldo carta/i.test(x.name)?'Isybank':
        kind==='extra'?'Revolut':'Isybank')});
 }
 for(const x of S.manualEntries||[]){
   if(x.month!==month||x.kind!==kind)continue;
   rows.push({ ...x, planned:true,confirmed:false,manual:true});
 }
 const dedupe=new Map();
 for(const x of rows)if(!dedupe.has(x.id))dedupe.set(x.id,x);
 return [...dedupe.values()].filter(x=>!v7IsExcluded(x.id))
   .filter(x=>S.policyVersion<8||
      (kind==='fixed'&&x.type!=='FONDO_TASSE')||
      (kind==='extra'&&x.type!=='PAGAMENTO_TASSE')||kind==='income')
   .filter(x=>S.policyVersion<11||kind!=='fixed'||
      (!v11IsHouseFund(x)&&!v11IsGas(x)&&!v11IsBundled(x)&&x.type!=='V11_DEPRECATED_PETROL'))
   .map(x=>S.policyVersion>=9&&S.v9AccountOverrides?.[x.id]?
      {...x,account:S.v9AccountOverrides[x.id]}:x)
   .map(x=>S.policyVersion>=12&&kind==='fixed'&&!v5RowStatus(x).done?
      {...x,account:v12FixedBank(x)}:x)
   .sort((a,b)=>a.date.localeCompare(b.date)||a.name.localeCompare(b.name,'it'));
}
function v5FoodUsed(month){
 if(S.policyVersion>=6&&(S.v6ExternalFood||[]).some(v=>v.month===month))return 30000;
 const amount=asCents(S.foodSpentByMonth?.[month]||0);
 const old=(forecast().find(x=>x.month===month)?.absorbed?.alimentari)||0;
 return Math.max(amount,old);
}
function v5FoodDue(row){
 return Math.max(0,asCents(row.amount)-v5FoodUsed(row.month));
}
function v5ManualCheck(id){return (S.monthlyChecks||[]).find(x=>x.id===id&&x.status==='done')}
function v5Plans(){
 if(S.policyVersion>=8)return v8Plans();
 if(S.policyVersion>=6)return v6SafePlans();
 const baseline=forecast();
 let oldPrev=null,previousEnd=null;
 const result=[];
 for(const m of baseline){
   const originalMonth=m.month;
   const rows={fixed:v5Catalog(originalMonth,'fixed'),
     extra:v5Catalog(originalMonth,'extra'),income:v5Catalog(originalMonth,'income')};
   let fixed=m.fixed,variable=m.variable,income=m.income;
   const food=rows.fixed.find(x=>x.grocery);
   const externalSettled=(S.v6ExternalFood||[]).some(x=>x.month===originalMonth);
   if(food&&!externalSettled){
     const originalConsumed=m.absorbed?.alimentari||0;
     const target=Math.min(asCents(food.amount),v5FoodUsed(originalMonth));
     fixed-=Math.max(0,target-originalConsumed);
   }
   // V4 already excludes verified bank payments and older completed lines.
   for(const x of S.manualEntries||[]){
     if(x.month!==originalMonth)continue;
     if(v5ManualCheck(x.id))continue;
     if(x.kind==='fixed')fixed+=asCents(x.amount);
     else if(x.kind==='extra')variable+=asCents(x.amount);
     else if(x.kind==='income')income+=asCents(x.amount);
   }
   for(const c of S.monthlyChecks||[]){
     if(c.status!=='done'||c.month!==originalMonth||c.manual)continue;
     if(c.kind==='fixed')fixed-=c.dueCents;
     if(c.kind==='extra')variable-=c.dueCents;
     if(c.kind==='income')income-=c.dueCents;
   }
   let bookedCash=0;
   for(const c of S.monthlyChecks||[]){
     if(c.status!=='done'||c.reconciled||!c.charge||c.cashMonth!==originalMonth)continue;
     bookedCash+=(c.kind==='income'?c.cashCents:-c.cashCents);
   }
   for(const c of S.foodCashEvents||[]){
     if(!c.reconciled&&c.month===originalMonth)bookedCash-=c.amountCents;
   }
   // Once the first day of a month has arrived, the external grocery
   // contribution is no longer an outstanding bill. It is a cash-flow
   // adjustment (unless reconciled by an updated bank balance).
   for(const x of S.v6ExternalFood||[]){
     if(x.month!==originalMonth)continue;
     fixed-=x.amountCents;
     if(!x.reconciled)bookedCash-=x.amountCents;
   }
   let opening=(previousEnd===null?m.opening:
     previousEnd+(m.opening-oldPrev.ending))+bookedCash;
   fixed=Math.max(0,fixed);variable=Math.max(0,variable);income=Math.max(0,income);
   const saved=asCents(m.base.goals?.casa||0)+asCents(m.base.goals?.viaggi||0);
   const ending=opening+income-fixed-variable-saved;
   const resultItem={...m,opening,income,fixed,variable,ending,
     foodUsed:v5FoodUsed(originalMonth),foodDue:food?v5FoodDue(food):0,rows};
   result.push(resultItem);oldPrev=m;previousEnd=ending;
 }
 return result;
}
function v5Now(){
 if(S.policyVersion>=8)return v8Now();
 if(S.policyVersion>=6)return v6SafeNow();
 const current=visibleMonth();
 const m=v5Plans().find(x=>x.month===current);
 const a=v5AccountBalances();
 const gross=Object.values(a).reduce((sum,x)=>sum+asCents(x),0)-
   (S.policyVersion>=6?v6ExternalPending():0);
 const due=m?m.fixed+m.variable+asCents(m.base.goals?.casa||0)+asCents(m.base.goals?.viaggi||0):0;
 return {month:current,accounts:a,gross,free:gross-due,end:m?.ending??0,plan:m};
}
function v5QuickSpent(){
 const mo=dayLocal().slice(0,7);
 return S.transactions.filter(x=>x.date.startsWith(mo)&&['svago','extra'].includes(x.category))
   .reduce((sum,x)=>sum+asCents(x.amount),0);
}
function v5RenderWallet(){
 if(S.policyVersion>=9){v9WalletDisplay();return}
 if(S.policyVersion>=8){v8WalletDisplay();return}
 const a=v5AccountBalances();
 const month=visibleMonth();
 const needs=[...v5Catalog(month,'fixed'),...v5Catalog(month,'extra')]
   .filter(x=>!x.grocery&&!v5RowStatus(x).done)
   .reduce((acc,x)=>{
     if(V6_ACCOUNTS.includes(x.account))acc[x.account]=(acc[x.account]||0)+asCents(x.amount);
     return acc;
   },{});
 $('walletAccounts').innerHTML=['Isybank','Intesa','Revolut','Cash'].map(name=>{
   const rec=lastBankUpdate(name);
   const due=needs[name]||0;
   return '<div class="wallet-row"><div class="wallet-row-name"><b>'+name+'</b><small>'+
      escapeHTML(rec?'Saldo stimato · ultimo controllo '+dayTitle(rec.date):
       'Saldo stimato, aggiornato con entrate e uscite')+
     '</small><small>Da coprire '+escapeHTML(monthTitle(month))+': '+money(euro(due))+'</small></div>'+
     '<div class="wallet-row-right"><strong>'+money(a[name])+'</strong>'+
     '<button type="button" data-bank-v5="'+name+'">Modifica</button></div></div>';
 }).join('');
}
function v5RowStatus(x){
 const c=v5ManualCheck(x.id);
 const auto=x.grocery&&S.policyVersion>=6;
 const paid=auto&&(S.v6ExternalFood||[]).some(v=>v.month===x.month);
 const legacyConfirmed=!!x.confirmed&&!v7Reopened(x.id);
 return {done:!!(legacyConfirmed||c||paid),locked:!!auto,record:c,
   historicallyVerified:legacyConfirmed};
}
function v5RowHtml(x){
 if(S.policyVersion>=22&&!x.grocery)return v22RowHtml(x);
 const state=v5RowStatus(x);
 const food=x.grocery;
 const used=food?v5FoodUsed(x.month):0;
 const remaining=food?Math.max(0,asCents(x.amount)-used):asCents(x.amount);
 const note=food?'<small>Già spesi '+money(euro(used))+' / '+money(x.amount)+
       ' · restano '+money(euro(remaining))+'</small>':
       x.note?'<small>'+escapeHTML(x.note)+'</small>':'';
 const label=state.historicallyVerified?'Già verificato · puoi togliere la spunta':
   state.locked?'Automatico · conto cointestato':
   state.done?'Pagato / ricevuto · modificabile':'Da confermare';
 const amount=money(x.amount);
 return '<div class="v5-obligation'+(state.done?' done':'')+'"><label class="v5-check">'+
   '<input type="checkbox" data-check-v5="'+escapeHTML(x.id)+'"'+
   (state.done?' checked':'')+(state.locked?' disabled':'')+'>'+
   '<span class="v5-check-info"><small>'+escapeHTML(dayTitle(x.date))+' · '+escapeHTML(label)+'</small>'+
   '<strong>'+escapeHTML(x.name)+'</strong>'+note+'</span></label>'+
   '<div class="v7-row-actions"><span class="v5-row-amount">'+amount+'</span>'+
    (!(food&&S.policyVersion>=6)?'<button type="button" class="v7-exclude" data-v7-exclude="'+
     escapeHTML(x.id)+'" title="Escludi voce dal piano; è ripristinabile">Escludi</button>':'')+
    '</div></div>';
}
function v5RenderLedger(kind,mon){
 const rows=v5Catalog(mon,kind);
 const planned=rows.filter(x=>!v5RowStatus(x).done);
 const pending=planned.reduce((v,x)=>v+(x.grocery?v5FoodDue(x):asCents(x.amount)),0);
 $('v5'+(kind==='fixed'?'Fixed':kind==='extra'?'Extra':'Income')+'Total').textContent=
   money(euro(pending))+' aperti';
  const excluded=(S.v7ExcludedRows||[]).filter(x=>x.month===mon&&x.kind===kind);
  const archive=excluded.length?
    '<details class="v7-archive"><summary>'+
      (S.policyVersion>=22?'Voci eliminate (':'Voci escluse (')+
      excluded.length+') · ripristinabili</summary>'+
      excluded.map(x=>'<div class="v7-archive-row"><span>'+escapeHTML(x.name)+' · '+
        money(x.amount)+'</span><button type="button" data-v7-restore="'+escapeHTML(x.id)+'">Ripristina</button></div>').join('')+
    '</details>':'';
  $('v5'+(kind==='fixed'?'Fixed':kind==='extra'?'Extra':'Income')+'Rows').innerHTML=
   (rows.map(x=>v5RowHtml(x)+
     (S.policyVersion>=8&&kind==='extra'&&!v5RowStatus(x).done?
       '<div class="v8-inline-extra"><span>Riservati: '+v8Money(v8ExtraFundActual(x.id))+
       '</span><button type="button" data-v8-extra-save="'+escapeHTML(x.id)+'">Accantona</button>'+
       '<button type="button" data-v8-extra-plan="'+escapeHTML(x.id)+'">Quota mensile</button></div>':'')
    ).join('')||
    '<p class="small-hint">Nessuna voce in questo mese. Puoi aggiungerla dal pulsante in basso.</p>')+archive;
 if(kind==='fixed'){
   const food=rows.find(x=>x.grocery);
   const used=S.policyVersion>=6?asCents(S.foodSpentByMonth?.[mon]||0):
       (food?v5FoodUsed(mon):0);
   const note=S.policyVersion>=16?
    (mon==='2026-11'?'Novembre: alimentari già finanziati e fuori dal patrimonio.':
     mon==='2027-01'?'Gennaio: 300 € alimentari inclusi nel budget viaggio estero di 1.000 €, non trasferirli anche al cointestato.':
     'Alimentari: fondo mensile previsto il 18, dopo gli accrediti; il versamento al cointestato si conferma quando effettuato.'):
    S.policyVersion>=6?
     (mon==='2026-11'?'Novembre: 300 € già trasferiti fuori dal patrimonio.':
      'Dal 1° del mese i 300 € sono destinati al cointestato esterno (deduzione contabile; non è un bonifico automatico).'):'';
   $('v5FoodStatus').innerHTML=(S.policyVersion>=16&&mon==='2027-01')?
      '<p class="small-hint">'+escapeHTML(note)+'</p>':
      '<p class="small-hint">'+escapeHTML(note)+'</p>'+
      '<div class="food-status-line"><b>Già consumati sul cointestato: '+money(euro(used))+
      '</b><b>Rimasti sul cointestato: '+money(euro(Math.max(0,30000-used)))+'</b></div>';

 }
}
function v5MonthCards(){
 if(S.policyVersion>=8){v8MonthCards();return}
 const months=v5Plans().filter(m=>m.month>=visibleMonth()).slice(0,6);
 $('v5MonthCards').innerHTML=months.map(m=>{
   const house=asCents(m.base.goals?.casa||0),travel=asCents(m.base.goals?.viaggi||0);
   return '<article class="month-card"><div class="month-header"><div><small>PREVISIONE</small><h3>'+
    escapeHTML(monthTitle(m.month))+'</h3></div><div class="month-net"><small>Netto libero</small><strong>'+
    money(euro(m.ending))+'</strong></div></div><div class="month-lines">'+
    '<div class="v5-projection-line"><span>Patrimonio iniziale</span><b>'+money(euro(m.opening))+'</b></div>'+
    '<div class="v5-projection-line"><span>Entrate ancora previste</span><b>'+money(euro(m.income))+'</b></div>'+
    '<div class="v5-projection-line"><span>Spese fisse (inclusi alimentari)</span><b>'+money(euro(m.fixed))+'</b></div>'+
    '<div class="v5-projection-line"><span>Spese extra</span><b>'+money(euro(m.variable))+'</b></div>'+
    '<div class="v5-projection-line"><span>Fondi tasse da accantonare</span><b>'+money(euro(m.plannedTax||0))+'</b></div>'+
    '<div class="v5-projection-line"><span>Obiettivi programmati</span><b>'+money(euro(house+travel))+'</b></div>'+
    '<div class="v5-projection-line"><span>Patrimonio finale, inclusi fondi</span><b>'+money(euro(m.grossEnd??m.ending))+'</b></div>'+
    '</div></article>';
 }).join('')||'<div class="panel">Importa il piano dei mesi successivi.</div>';
}
function v5RenderQuickHistory(){
 // Same source and date filter as v5QuickSpent: values cannot disagree.
 const current=dayLocal().slice(0,7);
 const rows=S.transactions.filter(x=>
   String(x.date||'').startsWith(current)&&['svago','extra'].includes(x.category))
   .slice().sort((a,b)=>String(b.created_at||b.date).localeCompare(String(a.created_at||a.date)));
 $('v5QuickCount').textContent='('+rows.length+(rows.length===1?' spesa':' spese')+')';
 const sums=new Map();
 for(const x of rows){
   const kind=String(x.subtype||x.note||'Altro').trim()||'Altro';
   sums.set(kind,(sums.get(kind)||0)+asCents(x.amount));
 }
 $('v20CategoryTotals').innerHTML=[...sums].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'it'))
   .map(([kind,cents])=>'<div class="v20-category-row"><span>'+
    escapeHTML(kind)+'</span><b>'+v8Money(cents)+'</b></div>').join('')||
   '<p class="small-hint">Nessuna spesa personale registrata per questo mese.</p>';
 $('v5QuickHistory').innerHTML=rows.map(x=>
   '<div class="v5-history-row v20-expense-row"><span>'+
   escapeHTML(dayTitle(x.date)+' · '+(x.subtype||x.note||'Altro'))+
   '<small>'+escapeHTML(x.account||'Conto non indicato')+'</small></span>'+
   '<b>−'+money(x.amount)+'</b>'+
   '<button type="button" data-undo-v5="'+escapeHTML(x.id)+'">Elimina</button></div>').join('');
}
function v5RenderAnalysis(){
 const p=v5Now();
 const m=p.plan;
 $('v5Analytics').innerHTML='<div class="v5-projection-line"><span>Patrimonio in tutti i conti</span><b>'+money(euro(p.gross))+'</b></div>'+
  '<div class="v5-projection-line"><span>Netto già speso questo mese</span><b>'+money(euro(v5QuickSpent()))+'</b></div>'+
  '<div class="v5-projection-line"><span>Spese fisse ancora aperte</span><b>'+money(euro(m?.fixed||0))+'</b></div>'+
  '<div class="v5-projection-line"><span>Extra in attesa</span><b>'+money(euro(m?.variable||0))+'</b></div>'+
  '<div class="v5-projection-line"><span>Entrate da ricevere</span><b>'+money(euro(m?.income||0))+'</b></div>'+
  '<div class="v5-projection-line"><span>Netto libero previsto</span><b>'+money(euro(p.end))+'</b></div>'+
  '<p class="small-hint">L’analisi equity avanzata arriverà in una prossima versione. Questi dati si aggiornano già con ogni spunta.</p>';
}
function v5Render(){
 if(S.policyVersion>=6)v6AutoFood();
 const p=v5Now();
 if(S.policyVersion>=14)v14RenderRisk(p.safeguard);
 $('v5Wealth').textContent=money(euro(p.gross));
 $('v5FreeNow').textContent=money(euro(p.free));
 $('v5FreeNow').classList.toggle('negative',p.free<0);
 $('v5FreeEnd').textContent=money(euro(p.end));
 $('v5NetSpent').textContent=money(euro(v5QuickSpent()));
 const goals=S.months[p.month]?.goals||{};
 $('houseGoal').textContent=money(goals.casa||0);
 $('travelGoal').textContent=money(goals.viaggi||0);
 v5RenderQuickHistory();v5RenderWallet();v5MonthCards();
 if(S.policyVersion>=16)v16RenderSixMonths();
 else if(S.policyVersion>=15)v15SixMonthDisplay();
 if(S.policyVersion>=6)v6ShowFoodState();
 for(const [id,kind] of [['Fixed','fixed'],['Extra','extra'],['Income','income']]){
   $('v5'+id+'Month').value=v5Period;
   v5RenderLedger(kind,v5Period);
 }
  v5RenderAnalysis();
  if(S.policyVersion>=32)v32RenderAnalysis();
  if(S.policyVersion>=24)v24RenderLoans();
  if(S.policyVersion>=8)v8FundDisplay();
  if(S.policyVersion>=11)v11HouseDisplay();
  const entries=S.bankStatement||[];
 $('v5StatementReview').innerHTML='<p class="small-hint">'+entries.length+
   ' movimenti conservati nell’archivio. Esporta il JSON per una verifica dettagliata insieme.</p>';
 if(S.policyVersion>=17)v17RenderAll();
 if(S.policyVersion>=25){
   const history=$('v25TransferHistoryPanel');
   if(history)history.hidden=!(S.v9Transfers||[]).some(x=>!x.cancelled);
 }
 document.querySelectorAll('.tab-page').forEach(el=>el.hidden=el.id!==v5Section);
 document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===v5Section));
 document.querySelectorAll('[data-quick-kind]').forEach(el=>el.classList.toggle('active',el.dataset.quickKind===v5QuickKind));
 if(S.policyVersion>=28)v28TidyAllTabs();
 if(S.firstStart)v32GenericRender();
}

function v5QuickAdd(event){
 event.preventDefault();
 const n=Number($('v5QuickAmount').value);
 if(!Number.isFinite(n)||n<0.01||n>100000){notify('Importo non valido',true);return}
 const date=dayLocal();
 if(!v5LegalMonth(date.slice(0,7))){notify('Importa un piano che comprende il mese attuale',true);return}
 const account=$('v6QuickAccount')?.value||'Cash';
 if(!V6_ACCOUNTS.includes(account))return;
 if(S.policyVersion>=17){
   const safety=v17CycleSafety(),cents=asCents(n);
   if(safety.initialShort>0){
     notify('Proteggi prima gli addebiti: sono necessari trasferimenti fra i conti.',true);return;
   }
   if(cents>safety.spendableToday){
     notify('Questa spesa supera il netto libero fino alla prossima entrata ('+
       v8Money(safety.spendableToday)+').',true);return;
   }
   if(cents>(safety.accounts[account]?.excess||0)){
     notify('Sul conto '+account+' servono soldi per le scadenze. Sposta prima il '+
       'denaro libero sul conto da cui vuoi pagare.',true);return;
   }
 }
 if(!confirm('Registrare '+money(n)+' per '+v5QuickKind+' da '+account+'?'))return;
 const next=v5Clone(S);
 next.transactions.push({
   id:'daily_v5_'+Date.now()+'_'+Math.random().toString(36).slice(2,8),
   date,amount:euro(asCents(n)),account,category:'svago',subtype:v5QuickKind,
   note:v5QuickKind,created_at:new Date().toISOString(),includedInBaseline:false,
   pocketAccounted:false
 });
 if(v5Save(next)){
   $('v5QuickAmount').value='';
   notify('Spesa del netto registrata, saldi e sei mesi aggiornati.');
 }
}
function v5CheckEntry(id,checked){
 const row=['fixed','extra','income'].flatMap(kind=>v5Catalog(v5Period,kind)).find(x=>x.id===id);
 if(!row)return;
 if(row.confirmed){
   notify('Pagamento già verificato nell’archivio; non va conteggiato di nuovo.',true);return;
 }
 const existing=v5ManualCheck(id);
 if(checked&&existing)return;
  if(!checked){
   if(!existing)return;
   if(existing.fundContribution){
     if(!confirm('Annullare l’accantonamento di '+money(euro(existing.dueCents))+' per le tasse?'))return;
     const next=v5Clone(S);
     if(asCents(next.actualFunds||0)<existing.dueCents){notify('Fondi insufficienti per annullare l’accantonamento.',true);return}
     next.actualFunds=euro(asCents(next.actualFunds)-existing.dueCents);
     next.monthlyChecks=next.monthlyChecks.filter(x=>x.id!==id);
     if(v5Save(next))notify('Accantonamento annullato, netto ricalcolato.');
     return;
   }
   if(existing.reconciled){
     notify('Questa voce è già inclusa in un saldo bancario confermato. Correggi il saldo, non duplicare il movimento.',true);
     return;
   }
   if(!confirm('Annullare la conferma di '+row.name+'? L’app ripristinerà il debito o l’incasso atteso.'))return;
   const next=v5Clone(S);
   next.monthlyChecks=next.monthlyChecks.filter(x=>x.id!==id);
   if(v5Save(next))notify('Spunta annullata, valori ricalcolati.');
   return;
 }
 const amount=row.grocery?euro(v5FoodDue(row)):Number(row.amount);
 if(!Number.isFinite(amount)||amount<0){notify('Importo della voce non valido.',true);return}
  if(S.policyVersion>=6&&row.type==='FONDO_TASSE'){
    if(!confirm('Confermi l’accantonamento di '+money(amount)+' per le tasse?\n'+
      'I soldi restano nei tuoi conti, ma non saranno considerati spendibili.'))return;
    const next=v5Clone(S);
    next.actualFunds=euro(asCents(next.actualFunds||0)+asCents(amount));
    next.monthlyChecks.push({id:row.id,month:row.month,kind:row.kind,manual:!!row.manual,
      status:'done',dueCents:asCents(amount),cashCents:0,charge:false,reconciled:true,
      fundContribution:true,account:'Intesa',paidAt:dayLocal(),recordedAt:new Date().toISOString()});
    if(v5Save(next))notify('Riserva tasse aggiornata senza ridurre il patrimonio.');
    return;
  }
  const income=row.kind==='income';
 let account=row.account|| (income?'Isybank':'Revolut');
 // Rental reimbursements vary month to month. The plan is 575 gross,
 // but the actual receipt is entered when the monthly checkbox is ticked.
 let cashAmount=amount;
 if(income&&/affitto/i.test(row.name)){
   const answer=prompt('Incasso affitto, condominio e Internet (500 + 50 + 25). Rimborso bollette inquilina da registrare separatamente (€).\n'+
     'Il valore previsto e '+money(amount)+', ma quello reale puo variare.',
     String(amount).replace('.',','));
   if(answer===null)return;
   cashAmount=Number(answer.trim().replace(',','.'));
   if(!Number.isFinite(cashAmount)||cashAmount<0||cashAmount>100000){
     notify('Importo incasso non valido',true);return;
   }
 }
 // La contabilizzazione è l'azione principale; il conto è ricordato per voce.
 const choice=prompt('Conto '+(income?'su cui hai ricevuto':'da cui hai pagato')+
   ' '+row.name+' ('+money(amount)+'):\nIsybank / Intesa / Revolut / Cash',account);
 if(choice===null)return;
 account=choice.trim();
 if(!V6_ACCOUNTS.includes(account)){
   notify('Indica Isybank, Intesa, Revolut o Cash',true);return;
 }
 const already=confirm('Questo movimento è GIÀ incluso nel saldo disponibile che hai inserito nell’app?\n'+
   'OK = già nel saldo (non lo sottraggo/aggiungo).\nAnnulla = non incluso (aggiorno ora il saldo stimato).');
 const confirmation='Confermi '+(income?'incassati ':'pagati ')+money(cashAmount)+' su '+account+' per '+row.name+
   (already?'? È già nel saldo disponibile.':'? Aggiornerò ora il saldo stimato.');
 if(!confirm(confirmation))return;
 const next=v5Clone(S);
 next.monthlyChecks.push({
   id:row.id,month:row.month,kind:row.kind,manual:!!row.manual,status:'done',
   dueCents:asCents(amount),cashCents:asCents(cashAmount),charge:!already,
   account,paidAt:dayLocal(),cashMonth:dayLocal().slice(0,7),
   recordedAt:new Date().toISOString(),reconciled:already
 });
 if(v5Save(next))notify(income?'Entrata registrata: netto aggiornato.':'Pagamento registrato: scadenze e netto aggiornati.');
}
function v5EditBank(account){
 const now=v5AccountBalances()[account]||0;
 const answer=prompt('Saldo reale verificato di '+(S.firstStart?v32AccountLabel(account):account)+' (euro).\n'+
   'Attuale saldo stimato: '+money(now)+'\n'+
   'Inserisci il saldo corretto. Le registrazioni precedenti saranno riconciliate.',String(now).replace('.',','));
 if(answer===null)return;
 const available=Number(answer.trim().replace(',','.'));
 if(!Number.isFinite(available)||available<0||available>99999999){
   notify('Saldo disponibile non valido.',true);return;
 }
 if(!confirm('Confermi '+money(available)+' su '+
   (S.firstStart?v32AccountLabel(account):account)+
   '? Le registrazioni già incluse saranno riconciliate.'))return;
 const patch={schema:'finanze-balance-snapshot-v1',baseHash:S.baseline.sourceStateHash,
   id:'v5_balance_'+account+'_'+Date.now(),account,available,
   date:dayLocal(),recordedAt:new Date().toISOString(),source:'Saldo manuale da app Finanze Offline'};
 try{
   const next=applyBankBalanceSnapshot(S,patch);
   const when=Date.parse(patch.recordedAt);
   for(const c of next.monthlyChecks||[]){
     if(c.account===account&&Date.parse(c.recordedAt)<=when)c.reconciled=true;
   }
   if(account==='Revolut'){
     for(const c of next.foodCashEvents||[]){
       if(Date.parse(c.createdAt)<=when)c.reconciled=true;
     }
   }
   if(!S.firstStart&&S.policyVersion>=6&&(S.policyVersion<11||account==='Isybank'))
     v6ReconcileFoodWithAccount.call(null,account,patch.date,next);
   if(S.policyVersion>=9)v9ReconcileTransferLegs(next,account,when);
   if(v5Save(next))notify('Saldo '+(S.firstStart?v32AccountLabel(account):account)+
   ' allineato; non sono stati duplicati i pagamenti.');
 }catch(err){notify('Aggiornamento non riuscito: '+err.message,true)}
}
function v5UpdateFood(){
 const m=v5Period;
 if(S.policyVersion>=6){
   notify('Il conto alimentare e esterno: i 300 euro sono gia usciti dal piano e non si monitorano le singole spese qui.',true);return;
 }
 const previous=euro(v5FoodUsed(m));
 const totalRaw=prompt('Spesa alimentare GIA SOSTENUTA nel mese di '+
   monthTitle(m)+' (su 300 €).\nIndica il totale cumulato, non solo l’ultima spesa.',
   String(previous).replace('.',','));
 if(totalRaw===null)return;
 const total=Number(totalRaw.trim().replace(',','.'));
 if(!Number.isFinite(total)||total<previous||total>300){
   notify('Inserisci il totale già speso, da '+money(previous)+' a 300 €. Per correggere un totale inferiore occorre una rettifica.',true);
   return;
 }
 const cents=asCents(total)-asCents(previous);
 if(cents===0){notify('Il totale alimentare è già aggiornato.');return}
 const already=confirm('I nuovi '+money(euro(cents))+' di alimentari sono già compresi nel saldo Revolut registrato?\n'+
   'OK = sì, non sottrarli ancora.\nAnnulla = no, sottrai dal saldo stimato.');
 const next=v5Clone(S);
 next.foodSpentByMonth[m]=euro(asCents(total));
 if(!already){
   next.foodCashEvents.push({id:'food_'+Date.now(),month:m,amountCents:cents,
     createdAt:new Date().toISOString(),reconciled:false});
 }
 if(v5Save(next))notify('Alimentari aggiornati: già spesi '+money(total)+', restano '+money(300-total));
}
function v5OpenAdd(kind){
 if(!['fixed','extra','income'].includes(kind))return;
 v5AddKind=kind;
 const labels={fixed:'Aggiungi spesa fissa',extra:'Aggiungi spesa extra',income:'Aggiungi entrata'};
 $('v5AddTitle').textContent=labels[kind];
 $('v5AddForm').reset();
 const today=dayLocal();
 $('v5AddDate').value=v5Period===today.slice(0,7)?today:v5Period+'-15';
 $('v5AddAccount').value=kind==='fixed'?'Isybank':kind==='extra'?'Revolut':'Isybank';
 $('v5AddRepeat').value='once';
 if(S.firstStart){
  $('v32AddUntil').value='';
  $('v32UntilLabel').hidden=true;
 }
 $('v5AddModal').hidden=false;
 $('v5AddName').focus();
}
function v5AddEntry(event){
 event.preventDefault();
 const name=$('v5AddName').value.trim();
 const amount=Number($('v5AddAmount').value);
 const date=$('v5AddDate').value;
 const note=$('v5AddNote').value.trim();
 const repeat=$('v5AddRepeat').value;
 const endRepeat=S.firstStart&&repeat==='monthly'?$('v32AddUntil').value:'';
 const account=$('v5AddAccount').value;
 if(!name||!Number.isFinite(amount)||amount<=0||amount>100000||!/^20\d\d-\d\d-\d\d$/.test(date)||
   !v5LegalMonth(date.slice(0,7))||!['Isybank','Intesa','Revolut','Cash'].includes(account)){
   notify('Controlla descrizione, importo, data e conto.',true);return;
 }
 if(S.policyVersion>=12&&!S.firstStart&&v5AddKind==='fixed'&&account!==v12FixedBank({name})){
   notify('Addebiti fissi: solo mutuo su Intesa; finanziamenti e abbonamenti su Isybank.',true);
   return;
 }
 const month=date.slice(0,7);
 if(endRepeat&&(!v5LegalMonth(endRepeat)||endRepeat<month)){
  notify('Il mese finale deve essere successivo alla prima scadenza.',true);return;
 }
 const plans=repeat==='monthly'?
   v5Months().filter(m=>m>=month&&(!endRepeat||m<=endRepeat)):[month];
 if(!confirm('Aggiungere '+name+' · '+money(amount)+(plans.length>1?' per '+plans.length+' mesi':'')+
   '? Le voci resteranno da pagare o ricevere finché non le spunti.'))return;
 const next=v5Clone(S),seed='manual_v5_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
 const day=date.slice(8,10);
 plans.forEach((m,i)=>{
   const maxDay=new Date(Number(m.slice(0,4)),Number(m.slice(5,7)),0).getDate();
   const actual=m+'-'+String(Math.min(Number(day),maxDay)).padStart(2,'0');
   next.manualEntries.push({id:seed+'_'+i,kind:v5AddKind,
     month:m,date:actual,name,amount:euro(asCents(amount)),
     note,account,manual:true,recurring:repeat==='monthly'});
 });
 if(v5Save(next)){
   $('v5AddModal').hidden=true;
   notify('Voce aggiunta allo scadenziario.');
 }
}
function v5MoveMonth(direction){
 const d=new Date(v5Period+'-01T12:00:00');
 d.setMonth(d.getMonth()+direction);
 const value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
 if(!v5LegalMonth(value))return;
 v5Period=value;v5Render();
}
function v5Click(event){
 if(event.target.closest('#v24LoanCancel')){v24ResetLoanForm();return}
 const preset=event.target.closest('[data-v24-preset]');
 if(preset){v24PresetLoan(preset.dataset.v24Preset);return}
 const editLoan=event.target.closest('[data-v24-edit]');
 if(editLoan){v24OpenLoanEdit(editLoan.dataset.v24Edit);return}
 const delLoan=event.target.closest('[data-v24-delete]');
 if(delLoan){v24DeleteLoan(delLoan.dataset.v24Delete);return}
 const editIncome=event.target.closest('[data-v22-edit-income]');
 if(editIncome){v22EditIncome(editIncome.dataset.v22EditIncome);return}
 const editGeneric=event.target.closest('[data-v32-edit-row]');
 if(editGeneric){v32EditAmount(editGeneric.dataset.v32EditRow);return}
 const editFood=event.target.closest('[data-v31-edit-food]');
 if(editFood){v31EditFoodFixedAmount(editFood.dataset.v31EditFood);return}
 const delRow=event.target.closest('[data-v22-delete]');
 if(delRow){v22DeleteRow(delRow.dataset.v22Delete);return}
 const cyclePanel=event.target.closest('[data-v21-panel]');
 if(cyclePanel){
   const section=cyclePanel.dataset.v21Panel;
   v21HeroOpen=v21HeroOpen===section?'':section;
   v21RenderHeroBreakdown(v17CycleSafety());
   return;
 }
 const dateCell=event.target.closest('[data-v17-date]');
 if(dateCell){
   v17RenderDateDetail(dateCell.dataset.v17Date);
   if(S.policyVersion>=23)$('v17DateDetails')?.scrollIntoView({behavior:'smooth',block:'start'});
   return;
 }
 if(event.target.closest('[data-v17-thai-move]')){v17RecordThailandTransfer();return}
 const houseLeft=event.target.closest('[data-v11-house-move]');
 if(houseLeft){v11HouseMonthMove(Number(houseLeft.dataset.v11HouseMove));return}
 if(event.target.closest('[data-v11-new-bill]')){v11AddTenantBill();return}
 if(event.target.closest('[data-v11-new-refund]')){v11AddTenantRefund();return}
 const assign=event.target.closest('[data-v9-assign]');
 if(assign){v9AssignAccount(assign.dataset.v9Assign);return}
 const transferControl=event.target.closest('[data-v9-from][data-v9-to]');
 if(transferControl){v9RecordTransfer(transferControl.dataset.v9From,transferControl.dataset.v9To,
   Number(transferControl.dataset.v9Cents));return}
 const undoTransfer=event.target.closest('[data-v9-undo]');
 if(undoTransfer){v9UndoTransfer(undoTransfer.dataset.v9Undo);return}
 const taxEdit=event.target.closest('[data-v8-tax-edit]');
 if(taxEdit){v8TaxEstimateEdit(taxEdit.dataset.v8TaxEdit);return}
 const taxMonthMove=event.target.closest('[data-v8-month-move]');
 if(taxMonthMove){v8FundMove(Number(taxMonthMove.dataset.v8MonthMove));return}
 const earmark=event.target.closest('[data-v8-extra-save]');
 if(earmark){v8ExtraEarmark(earmark.dataset.v8ExtraSave);return}
 const planExtra=event.target.closest('[data-v8-extra-plan]');
 if(planExtra){v8ExtraPlanEdit(planExtra.dataset.v8ExtraPlan);return}
 const undoExtra=event.target.closest('[data-v8-extra-undo]');
 if(undoExtra){v8ExtraFundUndo(undoExtra.dataset.v8ExtraUndo);return}
 const nav=event.target.closest('[data-tab]');
 if(nav){
   v5Section=nav.dataset.tab;v5Render();window.scrollTo(0,0);return;
 }
 const kind=event.target.closest('[data-quick-kind]');
 if(kind){v5QuickKind=kind.dataset.quickKind;v5Render();return}
 const move=event.target.closest('[data-move-month]');
 if(move){v5MoveMonth(Number(move.dataset.moveMonth));return}
 const add=event.target.closest('[data-add]');
 if(add){v5OpenAdd(add.dataset.add);return}
 const undo=event.target.closest('[data-undo-v5]');
 if(undo){v7UndoDaily(undo.dataset.undoV5);return}
 const exclude=event.target.closest('[data-v7-exclude]');
 if(exclude){v7Exclude(exclude.dataset.v7Exclude);return}
 const restore=event.target.closest('[data-v7-restore]');
 if(restore){v7Restore(restore.dataset.v7Restore);return}
 const bank=event.target.closest('[data-bank-v5]');
 if(bank){v5EditBank(bank.dataset.bankV5);return}
 if(event.target.closest('#v5UpdateFood')){v5UpdateFood();return}
 if(event.target.closest('#v5ModalClose')||event.target.closest('#v5AddCancel')){
   $('v5AddModal').hidden=true;return;
 }
}
function v5UndoQuick(id){
 const item=S.transactions.find(x=>x.id===id);
 if(!item||item.includedInBaseline)return;
 if(!confirm('Annullare '+money(item.amount)+' di '+(item.subtype||item.note)+'?'))return;
 const next=v5Clone(S);
 next.transactions=next.transactions.filter(x=>x.id!==id);
 // Legacy V4 entries may have debited their Revolut pocket in their own ledger.
 if(item.pocketAccounted===true&&item.account==='Revolut'&&next.revolutPockets){
   const key=item.category==='alimentari'?'food':'free';
   next.revolutPockets[key]=euro(asCents(next.revolutPockets[key])+asCents(item.amount));
 }
 if(v5Save(next))notify('Spesa annullata.');
}
function v5Change(event){
 if(S.firstStart&&event.target.closest('#v5AddRepeat')){
  $('v32UntilLabel').hidden=$('v5AddRepeat').value!=='monthly';
  return;
 }
 const stateSelect=event.target.closest('[data-v22-status]');
 if(stateSelect){v22SetStatus(stateSelect.dataset.v22Status,stateSelect.value);return}
 const cal=event.target.closest('#v17CalendarMonth');
 if(cal){v17CalendarMonth=cal.value;v17RenderCalendar();return}
 const houseReserve=event.target.closest('[data-v11-reserve]');
 if(houseReserve){v11ReserveHouse(houseReserve.dataset.v11Reserve,houseReserve.checked);v5Render();return}
 const housePay=event.target.closest('[data-v11-pay]');
 if(housePay){v11PayHouse(housePay.dataset.v11Pay,housePay.checked);v5Render();return}
 const monthHouse=event.target.closest('#v11HouseMonth');
 if(monthHouse&&v5LegalMonth(monthHouse.value)){
  v11HouseMonth=monthHouse.value;v5Render();return;
 }
 const fund=event.target.closest('[data-v8-tax-save]');
 if(fund){v8TaxFundSet(fund.dataset.v8TaxSave,fund.checked);v5Render();return}
 const payment=event.target.closest('[data-v8-tax-bill]');
 if(payment){v8TaxPaymentSet(payment.dataset.v8TaxBill,payment.checked);v5Render();return}
 const fundMonth=event.target.closest('#v8FundMonth');
 if(fundMonth&&fundMonth.value>=V8_START_TAX&&S.months[fundMonth.value]){
  v8FundMonth=fundMonth.value;v5Render();return;
 }
 const checkbox=event.target.closest('[data-check-v5]');
 if(checkbox){v7SetChecked(checkbox.dataset.checkV5,checkbox.checked);v5Render();return}
 const field=event.target.closest('.period-month');
 if(field&&v5LegalMonth(field.value)){v5Period=field.value;v5Render()}
}
async function v5Load(){
 let raw;
 if(window.FinanzeAndroid)raw=FinanzeAndroid.readState();
 else raw=localStorage.getItem('finanze_offline_iphone_firststart')||await(await fetch('./seed.json')).text();
 S=validate(JSON.parse(raw));
 if(S.firstStart!==true||S.policyVersion<32)
   throw Error('Archivio non compatibile con First start. Usa un backup creato da questa app.');
 // Public iPhone app never loads automatic bank statements or balance
 // snapshots. Only its zero seed or user-approved local JSON backups.
 if((Number(S.policyVersion)||0)<5){
   // Only existing V1-V4 models need legacy migration.
   S=upgradeV4(S);persist();
 }
 if((Number(S.policyVersion)||0)<6){
   const v5=v5Upgrade(S);if(v5!==S){S=v5;persist()}
   S=v6Upgrade(S);persist();
 }
 if((Number(S.policyVersion)||0)<7){
   const corrected=v7Upgrade(S);
   if(corrected!==S){S=corrected;persist()}
 }
 if((Number(S.policyVersion)||0)<8){
   const upgraded=v8Upgrade(S);
   if(upgraded!==S){S=upgraded;persist()}
 }
 if((Number(S.policyVersion)||0)<9){
   const upgraded=v9Upgrade(S);
   if(upgraded!==S){S=upgraded;persist()}
 }
 if((Number(S.policyVersion)||0)<10){
   const corrected=v10Upgrade(S);
   if(corrected!==S){S=corrected;persist()}
 }
 if((Number(S.policyVersion)||0)<11){
   const corrected=v11Upgrade(S);
   if(corrected!==S){S=corrected;persist()}
 }
 if((Number(S.policyVersion)||0)<12){
   const corrected=v12Upgrade(S);
   if(corrected!==S){S=corrected;persist()}
 }
 if((Number(S.policyVersion)||0)<13){
   const corrected=v13Upgrade(S);
   if(corrected!==S){S=corrected;persist()}
 }
 if((Number(S.policyVersion)||0)<14){
   const upgraded=v14Upgrade(S);
   if(upgraded!==S){S=upgraded;persist()}
 }
 if((Number(S.policyVersion)||0)<15){
   const upgraded=v15Upgrade(S);
   if(upgraded!==S){S=upgraded;persist()}
 }
  if((Number(S.policyVersion)||0)<16){
    const upgraded=v16Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<17){
    const upgraded=v17Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<18){
    const upgraded=v18Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<19){
    const upgraded=v19Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<20){
    const upgraded=v20Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<21){
    const upgraded=v21Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<22){
    const upgraded=v22Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<23){
    const upgraded=v23Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<24){
    const upgraded=v24Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<25){
    const upgraded=v25Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<26){
    const upgraded=v26Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<27){
    const upgraded=v27Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<28){
    const upgraded=v28Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<29){
    const upgraded=v29Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<30){
    const upgraded=v30Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if((Number(S.policyVersion)||0)<31){
    const upgraded=v31Upgrade(S);
    if(upgraded!==S){S=upgraded;persist()}
  }
  if(!v5LegalMonth(v5Period))v5Period=v5Months().at(0);
 v5Section='home';v5Render();
}

/* Finance Offline V6 -- idempotent migration from any saved V5.
   The new snapshot supersedes prior estimated balances. It is not a new income.
   Historical records are retained, not erased or added as a second cash flow.
*/
const V6_CAPTURE_TIME='2026-11-18T22:55:00+01:00';
const V6_ID='v6-20261118-confirmed-four-balances';
const V6_ACCOUNTS=['Isybank','Intesa','Revolut','Cash'];
const V6_RENT_CONDO=50,V6_RENT_INTERNET=25,V6_MONTHLY_FOOD=300;
/* V6 - proiezione per singolo movimento, con fondi tasse interni al patrimonio.
 * I saldi confermati prevalgono; nessun reddito ricevuto rientra negli attesi.
 * Un giroconto non e' un'entrata e non modifica il totale dei quattro conti.
 */
function v6SafePlans(){
 const allMonths=Object.keys(S.months).sort().filter(m=>m>=S.baseline.snapshotMonth);
 const accounts=v5AccountBalances();
 let gross=Object.values(accounts).reduce((n,v)=>n+asCents(v),0)-v6ExternalPending();
 let projectedTaxReserves=0;
 const actualFunds=asCents(S.actualFunds||0);
 const output=[];
 for(const month of allMonths){
   const base=S.months[month];
   const rows={fixed:v5Catalog(month,'fixed'),extra:v5Catalog(month,'extra'),income:v5Catalog(month,'income')};
   const unfinished=x=>!v5RowStatus(x).done;
   const dueFixed=rows.fixed.filter(x=>unfinished(x)&&x.type!=='FONDO_TASSE');
   const dueTax=rows.fixed.filter(x=>unfinished(x)&&x.type==='FONDO_TASSE');
   const dueExtra=rows.extra.filter(unfinished);
   const dueIncome=rows.income.filter(unfinished);
   const fixed=dueFixed.reduce((n,x)=>n+asCents(x.amount),0);
   const tax=dueTax.reduce((n,x)=>n+asCents(x.amount),0);
   const variable=dueExtra.reduce((n,x)=>n+asCents(x.amount),0);
   const income=dueIncome.reduce((n,x)=>n+asCents(x.amount),0);
   const goals=asCents(base.goals?.casa||0)+asCents(base.goals?.viaggi||0);
   const opening=gross;
   const grossEnd=opening+income-fixed-variable;
   projectedTaxReserves+=tax+goals;
   const ending=grossEnd-actualFunds-projectedTaxReserves;
   output.push({month,opening,income,fixed,variable,ending,grossEnd,
     plannedTax:tax,plannedSavings:goals,actualFunds,
     projectedReserves:projectedTaxReserves,base,rows,
     pending:{fixed:dueFixed,extra:dueExtra,income:dueIncome,tax:dueTax}});
   gross=grossEnd;
 }
 return output;
}
function v6SafeNow(){
 const plan=v6SafePlans(),current=plan.find(x=>x.month===visibleMonth())||plan[0];
 const accounts=v5AccountBalances();
 const gross=Object.values(accounts).reduce((n,x)=>n+asCents(x),0)-v6ExternalPending();
 const funds=asCents(S.actualFunds||0);
 const due=current?current.fixed+current.variable+current.plannedTax+current.plannedSavings:0;
 return {month:current?.month,accounts,gross,free:gross-due-funds,
   end:current?.ending||0,plan:current};
}

function v6Upgrade(old){
 if(old.policyVersion>=6 && (old.appliedBalanceUpdates||[]).includes(V6_ID))return old;
 const s=v5Clone(old);
 if(s.baseline?.sourceStateHash!==S.baseline.sourceStateHash)throw Error('Archivio iniziale non corrispondente alla V6.');
 const capture=Date.parse(V6_CAPTURE_TIME);
 const previous=v5AccountBalances();
 const confirmedAccounts={Isybank:120,Intesa:937,Revolut:0,Cash:400};
 // If the user already entered a newer REAL bank balance after the 18-Nov
 // declaration, keep the newer figure rather than rolling it back.
 const latest={};
 for(const history of s.bankBalanceHistory||[]){
   if(!Object.prototype.hasOwnProperty.call(confirmedAccounts,history.account))continue;
   const date=Date.parse(history.recordedAt||'');
   if(Number.isFinite(date)&&date>capture&&(!latest[history.account]||date>latest[history.account])){
     latest[history.account]=date;
   }
 }
 for(const account of Object.keys(latest)){
   if(Number.isFinite(Number(s.baseline.accounts?.[account])))
     confirmedAccounts[account]=Number(s.baseline.accounts[account]);
 }
 s.baseline.accounts=confirmedAccounts;
 s.baseline.opening=euro(Object.values(confirmedAccounts).reduce((n,v)=>n+asCents(v),0));
 s.baseline.snapshotDate='2026-11-18';
 s.baseline.snapshotMonth='2026-11';
 for(const entry of s.transactions||[]){
   const ts=Date.parse(entry.created_at||'');
   const alreadyOutside=entry.category==='alimentari'&&entry.date.startsWith('2026-11');
   if(alreadyOutside||(Number.isFinite(ts)&&ts<=capture)||(!Number.isFinite(ts)&&entry.date<='2026-11-18')){
     entry.includedInBaseline=true;
     entry.reconciledAt=V6_CAPTURE_TIME;
   }
 }
 for(const entry of s.monthlyChecks||[]){
   if(Date.parse(entry.recordedAt||'')<=capture)entry.reconciled=true;
 }
 for(const entry of s.foodCashEvents||[]){
   if(entry.month==='2026-11'||Date.parse(entry.createdAt||'')<=capture)
     entry.reconciled=true;
 }
 for(const entry of s.bankStatement||[]){
   if(entry.reviewStatus==='settled'&&entry.date<='2026-11-18')entry.reconciledBySnapshot=true;
   if(entry.reviewStatus==='applied_extra'&&entry.date<='2026-11-18')entry.reconciledBySnapshot=true;
 }
 const november=s.months['2026-11'];
 const food=november.details.fixed.filter(x=>x.type==='BUDGET_VITA'&&/alimentar/i.test(x.name));
 const foodKeys=new Set(food.map(x=>v5Key('2026-11','fixed',x)));
 for(const c of s.monthlyChecks||[])if(foodKeys.has(c.id)){
   c.reconciled=true;c.charge=false;
 }
 if(food.length){
   const amount=food.reduce((sum,x)=>sum+asCents(x.amount),0);
   november.fixed=euro(asCents(november.fixed)-amount);
   november.details.fixed=november.details.fixed.filter(x=>!food.includes(x));
   november.reservedFixed=euro(Math.max(0,asCents(november.reservedFixed||0)-amount));
   november.completed.fixed=november.completed.fixed||[];
   for(const x of food)november.completed.fixed.push({...x,
     date:'2026-11-18',name:'Alimentari novembre - quota già uscita',amount:x.amount,
     status:'VERSATO_CONTO_COINTESTATO',account:'Esterno',type:'BUDGET_CHIUSO'});
 }
 // November rent 550 (including condo) and parents' 400 cash were already
 // counted in the confirmed four-account total. Do not add them again.
 const doneNov=november.details.income.filter(x=>/affitto|familiari/i.test(x.name));
 const receivedKeys=new Set(doneNov.map(x=>v5Key('2026-11','income',x)));
 for(const c of s.monthlyChecks||[])if(receivedKeys.has(c.id)){
   c.reconciled=true;c.charge=false;
 }
 if(doneNov.length){
   november.income=euro(Math.max(0,asCents(november.income)-
     doneNov.reduce((sum,x)=>sum+asCents(x.amount),0)));
   november.details.income=november.details.income.filter(x=>!doneNov.includes(x));
   november.completed.income=november.completed.income||[];
   for(const x of doneNov){
     const fromRental=/affitto/i.test(x.name);
     november.completed.income.push({...x,name:fromRental?'Affitto e condominio ricevuti':'Aiuto familiari ricevuto (Cash)',
       amount:fromRental?550:400,account:fromRental?'Intesa':'Cash',status:'RICEVUTO_GIA_NEL_SALDO',
       date:'2026-11-18'});
   }
 }
 s.foodSpentByMonth=s.foodSpentByMonth||{};
 s.foodSpentByMonth['2026-11']=150;
 s.v6ClosedFoodMonths=['2026-11'];
 s.v6HousingMonthly={
   rentGrossExpected:575,rentalCondominium:V6_RENT_CONDO,rentalInternet:V6_RENT_INTERNET,
   firstHouseCondominium:50,tenantElectricityAmount:null,
   notes:'Importi affitto e bollette possono cambiare. Aggiungere le bollette effettive e rettificare il canone incassato.'
 };
 for(const [month,m] of Object.entries(s.months)){
   if(month<'2026-12')continue;
   const rent=(m.details.income||[]).find(x=>/affitto/i.test(x.name));
   if(rent){
     const oldAmount=asCents(rent.amount);
     rent.amount=575;rent.name='Affitto + oneri: incasso lordo previsto';
     rent.account='Intesa';rent.type='ENTRATA';
     m.income=euro(asCents(m.income)+(57500-oldAmount));
   }
   const parents=(m.details.income||[]).find(x=>/familiari/i.test(x.name));
   if(parents){parents.account='Cash';parents.name='Aiuto familiari (Cash)'}
   const wages=(m.details.income||[]).find(x=>/stipendio/i.test(x.name));
   if(wages)wages.account='Isybank';
   const foodLine=(m.details.fixed||[]).find(x=>x.type==='BUDGET_VITA'&&/alimentar/i.test(x.name));
   if(foodLine){
     foodLine.date=month+'-01';
     foodLine.account='Cointestato esterno';
     foodLine.name='Quota alimentare su conto cointestato';
     foodLine.externalFood=true;
     foodLine.status='USCITA_FISSA_DAL_PRIMO';
     foodLine.amount=300;
   }
   const newCosts=[
     ['Condominio casa affittata',V6_RENT_CONDO,'Intesa',5],
     ['Internet casa affittata',V6_RENT_INTERNET,'Intesa',10]
   ];
   for(const [name,amount,account,day] of newCosts){
     if((m.details.fixed||[]).some(x=>x.name===name))continue;
     const item={name,amount,date:month+'-'+String(day).padStart(2,'0'),
       type:'PAGAMENTO',status:'DA_PAGARE',category:'Immobile locato',account,
       note:'Spesa fissa dell’immobile affittato'};
     m.details.fixed.push(item);
     m.fixed=euro(asCents(m.fixed)+asCents(amount));
   }
   // Existing tax provision starts in March. Bring it forward to December
   // as a conservative projected reserve, without treating it as money already
   // transferred or an actual bill paid.
   const tax=[
     ['Accantonamento P.IVA Alsolved',75,15],
     ['Fondo tasse complessive (IMU e altri F24)',125,15],
     ['Cedolare secca affitto',50,17]
   ];
   for(const [name,amount,day] of tax){
     if((m.details.fixed||[]).some(x=>x.name===name))continue;
     m.details.fixed.push({name,amount,date:month+'-'+String(day).padStart(2,'0'),
       type:'FONDO_TASSE',status:'DA_ACCANTONARE',category:'Tasse (stima)',
       account:'Intesa',note:'Stima prudenziale: il pagamento effettivo va verificato'});
     m.fixed=euro(asCents(m.fixed)+asCents(amount));
   }
   m.details.fixed.sort((a,b)=>a.date.localeCompare(b.date));
   // Regenerate totals from their dated line items: users reported Dec's
   // income showing zero even though its salary/rent/parents were present.
   // Historical checks are preserved and deducted by v5Plans separately.
   m.income=euro((m.details.income||[]).reduce((sum,x)=>sum+asCents(x.amount),0));
   m.fixed=euro((m.details.fixed||[]).reduce((sum,x)=>sum+asCents(x.amount),0));
   m.variable=euro((m.details.variable||[]).reduce((sum,x)=>sum+asCents(x.amount),0));
 }
 const novemberHousing=[
   {name:'Condominio casa affittata',amount:50,date:'2026-11-05',type:'PAGAMENTO',
     account:'Intesa',status:'DA_PAGARE',note:'Immobile affittato, da verificare se già pagato'},
   {name:'Internet casa affittata',amount:25,date:'2026-11-10',type:'PAGAMENTO',
     account:'Intesa',status:'DA_PAGARE',note:'Internet dell’immobile affittato'}
 ];
 for(const x of novemberHousing){
   if(!november.details.fixed.some(a=>a.name===x.name)){
     november.details.fixed.push(x);
     november.fixed=euro(asCents(november.fixed)+asCents(x.amount));
   }
 }
 november.details.fixed.sort((a,b)=>a.date.localeCompare(b.date));
 s.revolutPockets={food:0,free:0,source:'Conto cointestato alimentari esterno al patrimonio',
   createdAt:V6_CAPTURE_TIME};
 s.appliedBalanceUpdates=[...(s.appliedBalanceUpdates||[]),V6_ID];
 s.bankBalanceHistory=[...(s.bankBalanceHistory||[]),
   {id:V6_ID,account:'Tutti i conti + Cash',date:'2026-11-18',
    recordedAt:V6_CAPTURE_TIME,available:1457,previousEstimated:previous,
    source:'Quattro saldi reali comunicati dall’utente il 18 novembre'}];
 for(const [account,available] of Object.entries(s.baseline.accounts)){
   s.bankBalanceHistory.push({id:V6_ID+'-'+account,account,available,
     date:'2026-11-18',recordedAt:V6_CAPTURE_TIME,
     previousEstimated:previous[account]??0,
     source:'Saldo disponibile o contante verificato direttamente dall?utente'});
 }
 s.actualFunds=s.actualFunds||0;
 s.policyVersion=6;
 return validate(s);
}

/* The external grocery account is OUTSIDE wealth. From 1st of each month,
 * remove 300 EUR from managed wealth even before reconciliation. Never
 * pretend a real bank transfer was executed. */
function v6AutoFood(){
 if(S.policyVersion<6||S.policyVersion>=30)return;
 if(!Array.isArray(S.v6ExternalFood))S.v6ExternalFood=[];
 const today=dayLocal(),current=today.slice(0,7);
 let changed=false;
 for(const month of Object.keys(S.months).sort()){
   if(month<'2026-12'||month>current)continue;
   if(S.policyVersion>=16&&month==='2027-01')continue;
   if(S.policyVersion>=13&&today<month+'-18')continue;
   if(!S.v6ExternalFood.some(x=>x.month===month)){
     S.v6ExternalFood.push({id:'external_food_'+month,month,amountCents:30000,
       reconciled:false,account:null,source:'Esclusione contabile automatica, non bonifico bancario'});
     changed=true;
   }
 }
 if(changed)persist();
}
function v6ExternalPending(){
 if(S.policyVersion>=30)return 0; // Replaced with explicit fixed charge on 19th
 return (S.v6ExternalFood||[]).filter(x=>!x.reconciled)
   .reduce((sum,x)=>sum+x.amountCents,0);
}
function v6ReconcileFoodWithAccount(account,date,target){
 const state=target||S;
 const rows=(state.v6ExternalFood||[]).filter(x=>!x.reconciled&&x.month<=date.slice(0,7));
 if(!rows.length)return;
 const amount=rows.reduce((sum,x)=>sum+x.amountCents,0);
 if(!confirm('Ci sono '+money(euro(amount))+' di alimentari esclusi virtualmente dal patrimonio.\n'+
  'Il saldo aggiornato di '+account+' comprende GIÀ i bonifici realmente eseguiti al conto cointestato?\n'+
  'OK = sì, riconcilia. Annulla = no, lascia la deduzione virtuale.'))return;
 for(const row of rows){row.reconciled=true;row.account=account;row.reconciledAt=new Date().toISOString()}
}
function v6ShowFoodState(){
 const p=v6ExternalPending();
 const node=$('v6ExternalFoodNote');
 if(node)node.textContent=p>0?
  money(euro(p))+' per alimentari già destinati al conto cointestato, da riconciliare con il pagamento reale.':
  (S.policyVersion>=16?
   'Il fondo alimentare è programmato dal 18; gennaio 2027 è già incluso nel budget viaggio estero di 1.000 €, senza doppio addebito.':
   'La quota alimentare esce dal patrimonio gestito il 1° di ogni mese, senza contare il conto cointestato.');
}

/* User interaction is V8; historical V5-V7 behavior retained for
   safe bank reconciliation and backward-compatible JSON import/export. */
/* Finanze Offline V7: each action is reversible, auditable, and drives the
 * same wallet balance and cash-flow projection on every screen.
 */
const V7_FIX_ID='v7-correzione-stipendio-dicembre-2026';
function v7Upgrade(source){
 const s=v5Clone(source);
 if(s.policyVersion>=7&&Array.isArray(s.v7AppliedFixes)&&s.v7AppliedFixes.includes(V7_FIX_ID))return source;
 if(!Array.isArray(s.v7AppliedFixes))s.v7AppliedFixes=[];
 if(!Array.isArray(s.v7AuditEvents))s.v7AuditEvents=[];
 if(!Array.isArray(s.v7ReopenedVerified))s.v7ReopenedVerified=[];
 if(!Array.isArray(s.v7ExcludedRows))s.v7ExcludedRows=[];
 // The user explicitly confirmed on 18 November that the DECEMBER salary
 // has NOT been paid. Do not add 1,300 EUR to any account when restoring it.
 // Preserve an audit record of the mistaken flag.
 if(dayLocal()<'2026-12-01'){
   const wrong=(s.monthlyChecks||[]).filter(c=>
     c.status==='done'&&c.month==='2026-12'&&c.kind==='income'&&
     /stipendio\s+datore/i.test(c.id||''));
   if(wrong.length){
     s.v7AuditEvents.push(...wrong.map(c=>({
       id:'v7_revert_dec_wage_'+c.id,action:'reopen_future_income',
       reason:'Utente: stipendio dicembre non ancora ricevuto',
       recordedAt:new Date().toISOString(),previous:v5Clone(c)
     })));
     s.monthlyChecks=s.monthlyChecks.filter(c=>!wrong.includes(c));
   }
   const wage=s.months?.['2026-12']?.details?.income?.find(x=>/stipendio\s+datore/i.test(x.name));
   if(wage){
     const id=v5Key('2026-12','income',wage);
     s.v7ReopenedVerified=s.v7ReopenedVerified.filter(x=>x!==id);
   }
 }
 s.v7AppliedFixes.push(V7_FIX_ID);
 s.policyVersion=7;
 return validate(s);
}
function v7IsExcluded(id){return (S.v7ExcludedRows||[]).some(x=>x.id===id)}
function v7Reopened(id){return (S.v7ReopenedVerified||[]).includes(id)}
function v7FindRow(id){
 for(const kind of ['fixed','extra','income']){
   const row=v5Catalog(v5Period,kind).find(x=>x.id===id);
   if(row)return row;
 }
 return null;
}
function v7SetChecked(id,checked){
 const row=v7FindRow(id);
 if(!row){notify('Voce non trovata: aggiorna la pagina.',true);return}
 if(row.grocery&&S.policyVersion>=6){
   notify('La quota alimentare è gestita automaticamente e non corrisponde al saldo del conto cointestato.',true);return;
 }
 const existing=v5ManualCheck(id);
 if(!checked){
   if(existing){
     if(existing.fundContribution){
       v5CheckEntry(id,false);return;
     }
     const wasInSnapshot=!!existing.reconciled;
     const amount=money(euro(existing.cashCents));
     if(!confirm('Riaprire «'+row.name+'» ('+amount+')?\n'+
       (wasInSnapshot?
        'Il saldo di '+existing.account+' è già stato confermato: non lo modifico. Riporto la voce tra gli importi in attesa.':
        'Annullerò anche la registrazione dell’incasso/pagamento sul conto '+existing.account+'.')))return;
     const next=v5Clone(S);
     next.monthlyChecks=next.monthlyChecks.filter(x=>x.id!==id);
     if(v5Save(next))notify('Spunta tolta. Entrate, uscite, saldi e previsioni aggiornati.');
     return;
   }
   if(row.confirmed&&!v7Reopened(id)){
     if(!confirm('Questa voce risultava già verificata da uno storico precedente.\n'+
       'Vuoi riaprirla come da pagare/ricevere? Il saldo già dichiarato non verrà modificato.'))return;
     const next=v5Clone(S);
     next.v7ReopenedVerified.push(id);
     if(v5Save(next))notify('Voce storica riaperta: torna tra gli importi da confermare.');
   }
   return;
 }
 if(row.confirmed&&v7Reopened(id)){
   const next=v5Clone(S);
   next.v7ReopenedVerified=next.v7ReopenedVerified.filter(x=>x!==id);
   if(v5Save(next))notify('Voce storica riportata allo stato verificato, saldi invariati.');
   return;
 }
 v5CheckEntry(id,true);
}
function v7Exclude(id){
 const row=v7FindRow(id);
 if(!row||row.grocery&&S.policyVersion>=6)return;
 if(!confirm('Escludere «'+row.name+'» dal piano?\n'+
   'Non viene cancellata la banca: la voce passa tra le escluse e potrai ripristinarla.\n'+
   'Se era una spunta provvisoria, verrà annullata.'))return;
 const next=v5Clone(S);
 if(!Array.isArray(next.v7ExcludedRows))next.v7ExcludedRows=[];
 if(next.v7ExcludedRows.some(x=>x.id===id))return;
 const check=(next.monthlyChecks||[]).find(x=>x.id===id&&x.status==='done');
 if(check?.fundContribution){
   if(asCents(next.actualFunds||0)<check.dueCents){
     notify('Non posso escludere: la riserva fiscale registrata è maggiore dei fondi attualmente accantonati.',true);return;
   }
   next.actualFunds=euro(asCents(next.actualFunds)-check.dueCents);
 }
 next.monthlyChecks=(next.monthlyChecks||[]).filter(x=>x.id!==id);
 next.v7ExcludedRows.push({id,name:row.name,kind:row.kind,month:row.month,
   amount:row.amount,date:row.date,manual:!!row.manual,sourceConfirmed:!!row.confirmed,
   excludedAt:new Date().toISOString()});
 if(v5Save(next))notify('Voce esclusa dal piano. Saldi e previsioni aggiornati.');
}
function v7Restore(id){
 const excluded=(S.v7ExcludedRows||[]).find(x=>x.id===id);
 if(!excluded)return;
 const next=v5Clone(S);
 next.v7ExcludedRows=next.v7ExcludedRows.filter(x=>x.id!==id);
 if(v5Save(next))notify('Voce ripristinata tra le scadenze.');
}
function v7UndoDaily(id){
 const item=S.transactions.find(x=>x.id===id);
 if(!item||!['svago','extra'].includes(item.category))return;
 const captured=!!item.includedInBaseline;
 if(!confirm('Eliminare la registrazione «'+(item.subtype||item.note||'Uscita')+
   '» di '+money(item.amount)+'?\n'+(captured?
    'Questa spesa è già contenuta in un saldo dichiarato: elimino la registrazione ma NON restituisco i soldi al conto.':
    'Il saldo stimato del conto '+item.account+' aumenterà del relativo importo.')))return;
 const next=v5Clone(S);
 next.transactions=next.transactions.filter(x=>x.id!==id);
 if(item.account==='Revolut'&&item.pocketAccounted===true&&next.revolutPockets){
   const key=item.category==='alimentari'?'food':'free';
   next.revolutPockets[key]=euro(asCents(next.revolutPockets[key])+asCents(item.amount));
 }
 if(v5Save(next))notify(captured?'Registrazione rimossa; saldo bancario confermato invariato.':
   'Spesa annullata: saldo stimato e proiezioni aggiornati.');
}


/* FINANZE V8: funds (tax + extra), forecast without double-counting,
   spendable account targets and reversible earmarking. */
const V8_START_TAX='2027-03';
const V8_TAX_SNAPSHOT='v8-fondi-dal-marzo-2027';
const V8_BANKS=['Isybank','Intesa','Revolut','Cash'];
function v8Upgrade(previous){
 const s=v5Clone(previous);
 if(s.policyVersion>=8)return previous;
 if(!Array.isArray(s.v8ExtraSavings))s.v8ExtraSavings=[];
 if(!Array.isArray(s.v8ExtraPlans))s.v8ExtraPlans=[];
 if(!Array.isArray(s.v8Transfers))s.v8Transfers=[];
 if(!Array.isArray(s.v8History))s.v8History=[];
 if(!Array.isArray(s.v8TaxCorrections))s.v8TaxCorrections=[];
 if(!s.v8TaxOverrides)s.v8TaxOverrides={};
 s.v8SavingsPolicy={taxStartMonth:V8_START_TAX,
   taxNote:'Accantonamenti stimati, importi fiscali non certificati. Confermare con F24 e commercialista.'};
 s.policyVersion=8;
 return validate(s);
}
function v8TaxFunds(month){
 if(!S.months[month]||month<V8_START_TAX)return [];
 return (S.months[month].details?.fixed||[]).filter(x=>x.type==='FONDO_TASSE')
   .map(x=>{
     const id=v5Key(month,'fixed',x),overrides=S.v8TaxOverrides||{};
     return {...x,id,month,kind:'fund',account:'Intesa',
       amount:Object.prototype.hasOwnProperty.call(overrides,id)?overrides[id]:x.amount};
   })
   .filter(x=>!v7IsExcluded(x.id))
   .sort((a,b)=>a.date.localeCompare(b.date));
}
function v8TaxBills(month){
 if(!S.months[month])return [];
 return (S.months[month].details?.variable||[]).filter(x=>x.type==='PAGAMENTO_TASSE')
   .map(x=>{
     const id=v5Key(month,'extra',x),overrides=S.v8TaxOverrides||{};
     return {...x,id,month,kind:'taxBill',account:'Intesa',
       amount:Object.prototype.hasOwnProperty.call(overrides,id)?overrides[id]:x.amount};
   })
   .filter(x=>!v7IsExcluded(x.id))
   .sort((a,b)=>a.date.localeCompare(b.date));
}
function v8FundContribution(row){return (S.monthlyChecks||[]).find(x=>x.id===row.id&&x.status==='done'&&x.fundContribution)}
function v8TaxPaidCents(){
 return (S.monthlyChecks||[]).filter(x=>x.status==='done'&&x.kind==='extra'&&
   Object.values(S.months).some(m=>(m.details?.variable||[]).some(y=>y.type==='PAGAMENTO_TASSE'&&
      (x.id||'').includes(y.name)))).reduce((n,x)=>n+(x.cashCents||x.dueCents||0),0);
}
function v8TaxActiveCents(){return Math.max(0,asCents(S.actualFunds||0)-v8TaxPaidCents())}
function v8ExtraRow(expenseId){
 for(const mon of Object.keys(S.months)){
  const x=v5Catalog(mon,'extra').find(row=>row.id===expenseId);
  if(x)return x;
 }
 return null;
}
function v8ExtraFundActual(id){
 return (S.v8ExtraSavings||[]).filter(x=>x.expenseId===id)
   .reduce((n,x)=>n+x.amountCents,0);
}
function v8ExtraFundActive(id){
 const row=v8ExtraRow(id);
 return row&&!v5RowStatus(row).done?v8ExtraFundActual(id):0;
}
function v8ExtraTotalActive(){
 const seen=new Set((S.v8ExtraSavings||[]).map(x=>x.expenseId));
 return [...seen].reduce((n,id)=>n+v8ExtraFundActive(id),0);
}
function v8ReserveDistribution(){
 const res=Object.fromEntries(V8_BANKS.map(x=>[x,0]));
 for(const x of S.monthlyChecks||[]){
  if(x.fundContribution&&x.status==='done')
   res[V8_BANKS.includes(x.account)?x.account:'Intesa']+=x.dueCents;
 }
 let missing=Math.max(0,v8TaxActiveCents()-Object.values(res).reduce((n,v)=>n+v,0));
 res.Intesa+=missing;
 let consumed=v8TaxPaidCents();
 for(const account of ['Intesa','Isybank','Revolut','Cash']){
  const n=Math.min(res[account],consumed);
  res[account]-=n;consumed-=n;
 }
 for(const e of S.v8ExtraSavings||[]){
  const row=v8ExtraRow(e.expenseId);
  if(row&&!v5RowStatus(row).done)
   res[V8_BANKS.includes(e.account)?e.account:'Intesa']+=e.amountCents;
 }
 return res;
}
function v8DueTax(month){
 return v8TaxFunds(month).filter(x=>!v8FundContribution(x));
}
function v8ExtraPlanFor(id){return (S.v8ExtraPlans||[]).find(x=>x.expenseId===id)}
function v8TaxForecast(){
 const out=[];
 let saved=v8TaxActiveCents();
 for(const month of Object.keys(S.months).sort().filter(x=>x>=V8_START_TAX)){
  const toSave=v8DueTax(month).reduce((n,x)=>n+asCents(x.amount),0);
  const toPay=v8TaxBills(month).filter(x=>!v5RowStatus(x).done)
     .reduce((n,x)=>n+asCents(x.amount),0);
  saved+=toSave;
  const fromReserve=Math.min(saved,toPay);
  saved-=fromReserve;
  out.push({month,planned:toSave,expectedBills:toPay,covered:fromReserve,
    unprotected:toPay-fromReserve,left:saved});
 }
 return out;
}
function v8Plans(){
 const accounts=v5AccountBalances();
 let gross=Object.values(accounts).reduce((n,x)=>n+asCents(x),0)-
   (S.policyVersion>=11?0:v6ExternalPending());
 const months=Object.keys(S.months).sort().filter(x=>x>=S.baseline.snapshotMonth);
 let taxReserve=v8TaxActiveCents(),goalsReserve=0;
 const extraReserved=new Map();
 for(const e of S.v8ExtraSavings||[]){
  if(v8ExtraRow(e.expenseId)&&!v5RowStatus(v8ExtraRow(e.expenseId)).done)
   extraReserved.set(e.expenseId,(extraReserved.get(e.expenseId)||0)+e.amountCents);
 }
 const result=[];
 for(const month of months){
  const fixedRows=v5Catalog(month,'fixed').filter(x=>!v5RowStatus(x).done&&v13IsForecastCurrent(x));
  const homeRows=S.policyVersion>=11?v11HouseRows(month)
      .filter(x=>!v5RowStatus(x).done&&
        (S.policyVersion<13||x.reserveDate>=V13_CASH_START)):[];
  const homeFunds=homeRows.reduce((n,x)=>n+asCents(x.amount),0);
  const extraRows=v5Catalog(month,'extra').filter(x=>!v5RowStatus(x).done&&v13IsForecastCurrent(x));
  const bills=v8TaxBills(month).filter(x=>!v5RowStatus(x).done&&v13IsForecastCurrent(x));
  const incomes=v5Catalog(month,'income').filter(x=>!v5RowStatus(x).done&&v13IsForecastCurrent(x));
  const fixed=fixedRows.reduce((n,x)=>n+asCents(x.amount),0);
  const variable=extraRows.reduce((n,x)=>n+asCents(x.amount),0);
  const taxBills=bills.reduce((n,x)=>n+asCents(x.amount),0);
  const income=incomes.reduce((n,x)=>n+asCents(x.amount),0);
  const tax=v8DueTax(month).reduce((n,x)=>n+asCents(x.amount),0);
  const goals=asCents(S.months[month].goals?.casa||0)+asCents(S.months[month].goals?.viaggi||0);
  const opening=gross;
  // Extra reserves are earmarked inside bank balances, not new expenses.
  let extraEarmark=0;
  for(const plan of S.v8ExtraPlans||[]){
   const row=v8ExtraRow(plan.expenseId);
   if(!row||v5RowStatus(row).done||v7IsExcluded(row.id))continue;
   if(month<plan.startMonth||month>row.month)continue;
   const balance=extraReserved.get(row.id)||0;
   const add=Math.min(Math.max(0,asCents(row.amount)-balance),plan.monthlyCents);
   extraReserved.set(row.id,balance+add);extraEarmark+=add;
  }
  taxReserve+=tax;
  goalsReserve+=goals;
  let extraCovered=0;
  for(const row of extraRows){
   const held=extraReserved.get(row.id)||0;
   const cover=Math.min(held,asCents(row.amount));
   extraCovered+=cover;
   extraReserved.delete(row.id);
  }
  const taxCovered=Math.min(taxReserve,taxBills);
  taxReserve-=taxCovered;
  const projectedExtraReserve=[...extraReserved.values()].reduce((n,x)=>n+x,0);
  const grossEnd=opening+income-fixed-homeFunds-variable-taxBills;
  const ending=grossEnd-taxReserve-projectedExtraReserve-goalsReserve;
  result.push({month,opening,income,fixed,homeFunds,variable,taxBills,
   tax,plannedTax:tax,plannedExtra:extraEarmark,plannedSavings:goals,
   taxCovered,extraCovered,grossEnd,ending,remainingTax:taxReserve,
   remainingExtra:projectedExtraReserve,rows:{fixed:fixedRows,house:homeRows,extra:extraRows,income:incomes},
   base:S.months[month],taxDue:bills});
  gross=grossEnd;
 }
 return result;
}
/* V14 - Liquidity guardrails.
 * Current physical Cash is INCLUDED in balance. Depositing it into Isybank
 * or Intesa is an internal transfer, not extra revenue.
 * Future parental Cash receipts are CONDITIONAL until checked as received.
 * Protect every known due date in the coming 90 days; monthly positive end
 * balances cannot override an earlier negative cash-balance point.
 * Unpaid old dues from 18-Nov onward are conservatively due today.
 */
const V14_DAYS=90;
function v14Upgrade(old){
 const changed=v5Clone(old);
 if(changed.policyVersion>=14)return old;
 changed.policyVersion=14;
 changed.v14Policy={
   safeguardDays:90,alreadyOwnedCashIncluded:true,
   bankCashDepositsAreTransfers:true,futureParentsIncomeConditional:true,
   changesBankBalancesOnlyAfterActualTransfer:true
 };
 return validate(changed);
}
/* V15 – parental Cash is a confirmed regular monthly incoming 400 EUR on
 * the 18th. The November 400 EUR is already in the Cash account and must
 * not be added a second time. Phone movements are carried over unchanged.
 */
function v15Upgrade(old){
 const result=v5Clone(old);
 if(result.policyVersion>=15)return old;
 if(!result.v9AccountOverrides)result.v9AccountOverrides={};
 const modified=[];
 for(const [month,m] of Object.entries(result.months||{})){
  if(month<'2026-12')continue;
  for(const income of m.details?.income||[]){
   if(!/aiuto familiari/i.test(income.name||''))continue;
   const oldId=v5Key(month,'income',income);
   income.date=month+'-18';
   income.account='Cash';
   income.estimated=false; // confirmed recurrence, not yet physically received
   income.note='400 euro ricorrenti ogni 18 in Cash. Conferma quando ricevuti; novembre gia nel saldo.';
   const newId=v5Key(month,'income',income);
   v11MigrateKeys(result,oldId,newId);
   result.v9AccountOverrides[newId]='Cash';
   modified.push({month,oldId,newId});
  }
 }
 result.v15ParentalPolicy={
   amountCents:40000,account:'Cash',dateDay:18,starts:'2026-12',
   guaranteedRecurring:true,novemberAlreadyHeld:true,
   incomeRowChanges:modified.length
 };
 result.policyVersion=15;
 return validate(result);
}
function v14SafeLiquidity(includeFutureParents=true){
 const date=dayLocal();
 const start=date>=V13_CASH_START?date:V13_CASH_START;
 const deadline=v9FallbackFrom(start,V14_DAYS);
 const initial=v5AccountBalances();
 const initialCents=V8_BANKS.reduce((n,a)=>n+asCents(initial[a]),0);
 const existingTax=Math.max(0,v8TaxActiveCents());
 const extraHeld={};
 for(const saved of S.v8ExtraSavings||[]){
  const row=v8ExtraRow(saved.expenseId);
  if(!row||v5RowStatus(row).done||v7IsExcluded(row.id))continue;
  extraHeld[saved.expenseId]=(extraHeld[saved.expenseId]||0)+saved.amountCents;
 }
 const heldExtra=()=>Object.values(extraHeld).reduce((n,v)=>n+v,0);
 const events=[];
 const futureParental=[];
 function add(originalDate,type,label,cents,id='',extra={}){
  if(!originalDate||originalDate>deadline||originalDate<V13_CASH_START)return;
  // A late, unconfirmed incoming payment cannot be treated as available now.
  if(type==='income'&&originalDate<start)return;
  if(!Number.isFinite(cents)||cents<=0)return;
  events.push({date:originalDate<start?start:originalDate,
    originalDate,type,label,cents,id,...extra});
 }
 for(const month of Object.keys(S.months).sort()){
  const still=(kind)=>v5Catalog(month,kind).filter(x=>!v5RowStatus(x).done);
  for(const x of still('fixed'))
   add(x.date,'fixed',x.name,asCents(x.amount),x.id);
  for(const x of still('extra'))
   add(x.date,'extra',x.name,asCents(x.amount),x.id);
  for(const x of v11HouseRows(month).filter(x=>!v5RowStatus(x).done))
   add(x.reserveDate,'house',x.name,asCents(x.amount),x.id);
  for(const x of v8TaxBills(month).filter(x=>!v5RowStatus(x).done))
   add(x.date,'taxBill',x.name,asCents(x.amount),x.id);
  for(const x of still('income')){
   const conditional=!S.firstStart&&/familiari/i.test(x.name||'');
   if(conditional&&x.date>=start&&x.date<=deadline)
     futureParental.push({date:x.date,name:x.name,cents:asCents(x.amount)});
   if(conditional&&!includeFutureParents)continue;
   add(x.date,'income',x.name,asCents(x.amount),x.id,{conditional});
  }
  for(const x of v8DueTax(month))
   add(x.date,'taxReserve',x.name,asCents(x.amount),x.id);
  const goals=asCents(S.months[month]?.goals?.casa||0)+
    asCents(S.months[month]?.goals?.viaggi||0);
  if(goals>0)add(month+'-18','goalsReserve','Obiettivi Casa e Viaggi',goals);
 }
 // Planned extra savings only earmark existing money and can be released
 // when the actual scheduled expense is paid.
 for(const plan of S.v8ExtraPlans||[]){
  const row=v8ExtraRow(plan.expenseId);
  if(!row||v5RowStatus(row).done||v7IsExcluded(row.id))continue;
  for(const month of Object.keys(S.months).sort()){
   if(month<plan.startMonth||month>row.month)continue;
   const reserveDate=month+'-18';
   if(reserveDate>row.date)continue;
   add(reserveDate,'extraReserve','Fondo '+row.name,plan.monthlyCents,
     plan.expenseId,{cap:asCents(row.amount)});
  }
 }
 // When the order of two movements on the same day is uncertain, avoid
 // assuming a future deposit arrives before an existing debit.
 // Home funds are reserved on the 18th AFTER the recurring Cash arrives.
 // For other same-day bills we still err on the conservative side.
 const order={fixed:0,extra:0,taxBill:0,
   taxReserve:1,extraReserve:1,goalsReserve:1,income:2,house:3};
 events.sort((a,b)=>a.date.localeCompare(b.date)||
   order[a.type]-order[b.type]||a.label.localeCompare(b.label,'it'));
 let gross=initialCents,taxHeld=existingTax,goalsHeld=0;
 let minSpendable=gross-taxHeld-heldExtra(),worstDay=start;
 let minGross=gross,worstGrossDay=start;
 let firstDeficit=minSpendable<0?start:null;
 let expectedIncome=0,dueTotal=0;
 const rows=[];
 for(const e of events){
  const bankBefore=gross;
  switch(e.type){
   case 'income':
    gross+=e.cents;expectedIncome+=e.cents;break;
   case 'taxReserve':
    taxHeld+=e.cents;break;
   case 'goalsReserve':
    goalsHeld+=e.cents;break;
   case 'extraReserve':{
    const old=extraHeld[e.id]||0;
    extraHeld[e.id]=old+Math.min(e.cents,Math.max(0,e.cap-old));
    break;
   }
   case 'taxBill':
    gross-=e.cents;dueTotal+=e.cents;
    taxHeld=Math.max(0,taxHeld-e.cents);break;
   case 'extra':
    gross-=e.cents;dueTotal+=e.cents;
    extraHeld[e.id]=Math.max(0,(extraHeld[e.id]||0)-e.cents);break;
   default:
    gross-=e.cents;dueTotal+=e.cents;break;
  }
  const spendable=gross-taxHeld-heldExtra()-goalsHeld;
  if(spendable<minSpendable){minSpendable=spendable;worstDay=e.date;}
  if(gross<minGross){minGross=gross;worstGrossDay=e.date;}
  if(spendable<0&&!firstDeficit)firstDeficit=e.date;
  rows.push({date:e.date,type:e.type,label:e.label,cents:e.cents,
    balance:spendable,gross,was:bankBefore});
 }
 const freeToday=Math.max(0,minSpendable);
 return {start,deadline,horizonDays:V14_DAYS,initial:initialCents,
   initialProtected:existingTax+(S.v8ExtraSavings||[]).reduce((n,x)=>{
     const row=v8ExtraRow(x.expenseId);
     return n+(row&&!v5RowStatus(row).done?x.amountCents:0);
   },0),
   freeToday:Math.max(0,freeToday),lowestSpendable:minSpendable,
   worstDay,lowestGross:minGross,worstGrossDay,
   firstDeficit,expectedIncome,dueTotal,
   conditionalIncome:futureParental.reduce((n,x)=>n+x.cents,0),
   conditionalItems:futureParental,rows};
}
function v14LiquiditySummary(){
 if(S.firstStart)return v14SafeLiquidity(true);
 if(S.policyVersion>=15){
   const guaranteed=v14SafeLiquidity(true);
   const withoutParents=v14SafeLiquidity(false);
   return {...guaranteed,
     confirmedFutureParents:guaranteed.conditionalIncome,
     withoutParentsMinimum:withoutParents.lowestSpendable,
     withoutParentsDate:withoutParents.worstDay};
 }
 const baseline=v14SafeLiquidity(false);
 const withParents=v14SafeLiquidity(true);
 return {...baseline,withParentsFree:withParents.freeToday,
   withParentsMinimum:withParents.lowestSpendable,
   withParentsDate:withParents.worstDay};
}

function v8Now(){
 const m=v8Plans().find(x=>x.month===visibleMonth())||v8Plans()[0];
 const accounts=v5AccountBalances();
 const gross=Object.values(accounts).reduce((n,v)=>n+asCents(v),0)-
   (S.policyVersion>=11?0:v6ExternalPending());
 const monthlyRemaining=(m?.ending||0)-(m?.income||0);
 const safeguard=S.policyVersion>=14?v14LiquiditySummary():null;
 return {month:m?.month,accounts,gross,
   free:safeguard?safeguard.freeToday:monthlyRemaining,
   nominalMonthFree:monthlyRemaining,safeguard,
   end:S.policyVersion>=16?
     (v16SixMonthRows().find(x=>x.month===m?.month)?.netFree??0):
     (m?.ending||0),plan:m};
}

function v8Money(n){return money(euro(n))}
function v8TaxMinimum(){
 const all=Object.keys(S.months).sort().filter(x=>x>=V8_START_TAX);
 const upcoming=all.flatMap(month=>v8TaxBills(month).filter(x=>!v5RowStatus(x).done));
 const next=upcoming.length?upcoming[0].month:null;
 if(!next)return {month:null,total:0,need:0,planned:0,count:0};
 const total=upcoming.filter(x=>x.month===next).reduce((n,x)=>n+asCents(x.amount),0);
 const from=dayLocal().slice(0,7)>V8_START_TAX?dayLocal().slice(0,7):V8_START_TAX;
 const count=all.filter(x=>x>=from&&x<=next).length||1;
 const current=v8TaxActiveCents();
 const planned=all.filter(x=>x>=from&&x<=next)
   .reduce((n,month)=>n+v8DueTax(month).reduce((k,x)=>k+asCents(x.amount),0),0);
 return {month:next,total,need:Math.max(0,Math.ceil((total-current)/count)),
   planned,current,count,shortfall:Math.max(0,total-current-planned)};
}
function v8TaxEstimateEdit(id){
 const row=Object.keys(S.months).flatMap(m=>[...v8TaxFunds(m),...v8TaxBills(m)])
   .find(x=>x.id===id);
 if(!row)return;
 const already=row.kind==='fund'?!!v8FundContribution(row):v5RowStatus(row).done;
 if(already){notify('Togli prima la spunta: la somma gi? registrata non pu? cambiare retroattivamente.',true);return}
 const input=prompt('Nuovo importo STIMATO per '+row.name+' (euro).\n'+
   'Questa ? una previsione, non sostituisce gli F24 ufficiali.',
   String(row.amount).replace('.',','));
 if(input===null)return;
 const amount=Number(input.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<0||amount>100000){
   notify('Importo stimato non valido.',true);return;
 }
 const next=v5Clone(S);
 next.v8TaxOverrides[id]=Math.round(amount*100)/100;
 next.v8TaxCorrections.push({id,original:row.amount,revised:amount,
   changedAt:new Date().toISOString(),source:'v8-manual-tax-estimate'});
 if(v5Save(next))notify('Stima fiscale modificata: fondi e previsioni ricalcolati.');
}
function v8TaxFundSet(id,checked){
 const row=Object.keys(S.months).flatMap(month=>v8TaxFunds(month)).find(x=>x.id===id);
 if(!row)return;
 const current=v8FundContribution(row);
 if(checked&&current)return;
 const next=v5Clone(S);
 if(!checked){
  if(!current)return;
  if(!confirm('Annullare l’accantonamento di '+money(row.amount)+' per '+row.name+'?\n'+
    'Il denaro torna spendibile ma il saldo bancario fisico resta invariato.'))return;
  if(asCents(next.actualFunds||0)<current.dueCents){
   notify('Il fondo residuo è insufficiente. Verifica prima eventuali pagamenti F24.',true);return;
  }
  next.actualFunds=euro(asCents(next.actualFunds||0)-current.dueCents);
  next.monthlyChecks=next.monthlyChecks.filter(x=>x.id!==id);
  if(v5Save(next))notify('Accantonamento annullato, netto e conti aggiornati.');
  return;
 }
 const account=prompt('Su quale conto restano i soldi protetti per le tasse?\n'+
    V8_BANKS.join(' / '),'Intesa');
 if(account===null)return;
 if(!V8_BANKS.includes(account.trim())){notify('Conto non valido.',true);return}
 const canReserve=asCents(v5AccountBalances()[account.trim()])-
   (v8ReserveDistribution()[account.trim()]||0);
 if(canReserve<asCents(row.amount)){
   notify('Disponibilit? non vincolata insufficiente su '+account.trim()+
     '. Scegli un altro conto o aggiorna il saldo reale.',true);return;
 }
 if(!confirm('Accantonare '+money(row.amount)+' su '+account.trim()+
   ' per le tasse?\nIl saldo del conto NON cambia; diminuisce solo il denaro liberamente spendibile.'))return;
 next.actualFunds=euro(asCents(next.actualFunds||0)+asCents(row.amount));
 next.monthlyChecks.push({id:row.id,month:row.month,kind:'fixed',status:'done',
   dueCents:asCents(row.amount),cashCents:0,charge:false,reconciled:true,
   fundContribution:true,account:account.trim(),paidAt:dayLocal(),
   recordedAt:new Date().toISOString(),source:'v8-fondi'});
 if(v5Save(next))notify('Fondo tasse protetto: saldi reali invariati, disponibile aggiornato.');
}
function v8TaxPaymentSet(id,checked){
 const row=Object.keys(S.months).flatMap(month=>v8TaxBills(month)).find(x=>x.id===id);
 if(!row)return;
 const current=v5ManualCheck(row.id);
 if(checked&&current)return;
 const next=v5Clone(S);
 if(!checked){
  if(current){
   if(!confirm('Annullare il pagamento F24 '+row.name+'?\n'+
     (current.reconciled?'Saldo bancario già verificato: non lo modifico.':
       'Il saldo stimato del conto verrà ripristinato.')))return;
   next.monthlyChecks=next.monthlyChecks.filter(x=>x.id!==row.id);
  }else if(row.confirmed&&!v7Reopened(row.id)){
   next.v7ReopenedVerified.push(row.id);
  }else return;
  if(v5Save(next))notify('F24 riaperto e previsioni aggiornate.');
  return;
 }
 if(row.confirmed&&v7Reopened(row.id)){
  next.v7ReopenedVerified=next.v7ReopenedVerified.filter(x=>x!==row.id);
  if(v5Save(next))notify('F24 riportato allo stato già verificato.');
  return;
 }
 const str=prompt('Importo REALE pagato per '+row.name+' (in euro).\n'+
  'La previsione è '+money(row.amount)+'; correggila se l’F24 è diverso.',
  String(row.amount).replace('.',','));
 if(str===null)return;
 const amount=Number(str.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<0||amount>100000){notify('Importo F24 non valido.',true);return}
 const accountText=prompt('Conto che ha pagato l’F24 (Isybank/Intesa/Revolut/Cash)','Intesa');
 if(accountText===null)return;
 const account=accountText.trim();
 if(!V8_BANKS.includes(account)){notify('Conto non valido.',true);return}
 const already=confirm('L’F24 è GIÀ incluso nel saldo reale verificato di '+account+'?\n'+
  'OK: non sottrarre di nuovo. Annulla: aggiorna ora il saldo stimato.');
 if(!confirm('Confermi F24 pagato '+money(amount)+' da '+account+'?'))return;
 next.monthlyChecks.push({id:row.id,month:row.month,kind:'extra',status:'done',
  dueCents:asCents(row.amount),cashCents:asCents(amount),account,
  paidAt:dayLocal(),cashMonth:dayLocal().slice(0,7),
  reconciled:already,charge:!already,recordedAt:new Date().toISOString(),source:'v8-tax-payment'});
 if(v5Save(next))notify('F24 registrato. Patrimonio e riserva fiscale ricalcolati.');
}
function v8ExtraEarmark(id){
 const row=v8ExtraRow(id);
 if(!row||v5RowStatus(row).done){notify('La spesa è già pagata o non è nel piano.',true);return}
 const already=v8ExtraFundActual(id);
 const initial=Math.max(0,asCents(row.amount)-already);
 const input=prompt('Quanto vuoi mettere da parte OGGI per '+row.name+'?\n'+
   'Costo previsto '+money(row.amount)+' · già accantonato '+v8Money(already)+
   '.\nIl denaro resta nel tuo conto e diventa non spendibile.',
   String(euro(Math.min(initial,5000))).replace('.',','));
 if(input===null)return;
 const amount=Number(input.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<=0||amount>100000){notify('Importo non valido.',true);return}
 if(asCents(amount)+already>asCents(row.amount)){
   notify('L’accantonamento supererebbe il costo previsto. Aggiorna prima la spesa.',true);return;
 }
 const choice=prompt('Conto su cui tieni questi soldi riservati: '+
   (S.firstStart?V8_BANKS.map(v32AccountLabel).join(' / '):V8_BANKS.join(' / ')),
   S.firstStart?v32AccountLabel(row.account||'Isybank'):'Intesa');
 if(choice===null)return;
 const account=S.firstStart?v32ResolveAccount(choice):choice.trim();
 if(!V8_BANKS.includes(account)){notify('Conto non valido.',true);return}
 const available=asCents(v5AccountBalances()[account])-(v8ReserveDistribution()[account]||0);
 if(available<asCents(amount)){
   notify('Disponibilit? non vincolata insufficiente su '+account+
     '. Aggiorna il saldo o scegli un altro conto.',true);return;
 }
 if(!confirm('Proteggere '+money(amount)+' su '+account+' per '+row.name+
   '?\nNon è un bonifico: il saldo del conto resta uguale, il libero diminuisce.'))return;
 const next=v5Clone(S);
 next.v8ExtraSavings.push({id:'extra_saved_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),
   expenseId:id,amountCents:asCents(amount),account,date:dayLocal(),
   createdAt:new Date().toISOString()});
 if(v5Save(next))notify('Somma riservata alla spesa extra, senza doppio addebito.');
}
function v8ExtraPlanEdit(id){
 const row=v8ExtraRow(id);
 if(!row||v5RowStatus(row).done)return;
 const existing=v8ExtraPlanFor(id);
 const str=prompt('Quanto vuoi programmare da accantonare OGNI MESE per '+row.name+
   '?\n0 = disattiva il piano. L’importo mensile è una previsione: lo accantonerai davvero con «Accantona».',
   String(euro(existing?.monthlyCents||0)).replace('.',','));
 if(str===null)return;
 const amount=Number(str.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<0||amount>100000){notify('Importo non valido.',true);return}
 const startMonth=dayLocal().slice(0,7);
 if(!v5LegalMonth(startMonth)||startMonth>row.month){
  notify('La scadenza della spesa è precedente all’attuale mese: usa Accantona.',true);return;
 }
 const next=v5Clone(S);
 next.v8ExtraPlans=next.v8ExtraPlans.filter(x=>x.expenseId!==id);
 if(amount>0){
  next.v8ExtraPlans.push({expenseId:id,monthlyCents:asCents(amount),
    startMonth,updatedAt:new Date().toISOString()});
 }
 if(v5Save(next))notify(amount>0?'Quota mensile impostata: proiezioni aggiornate.':
   'Piano mensile rimosso.');
}
function v8ExtraFundUndo(eventId){
 const x=(S.v8ExtraSavings||[]).find(x=>x.id===eventId);
 if(!x)return;
 if(!confirm('Liberare '+v8Money(x.amountCents)+' dal fondo della spesa extra?\n'+
   'L’importo torna spendibile senza alterare il saldo reale.'))return;
 const next=v5Clone(S);
 next.v8ExtraSavings=next.v8ExtraSavings.filter(x=>x.id!==eventId);
 if(v5Save(next))notify('Fondo extra liberato: netto e conti aggiornati.');
}

let v8FundMonth='2027-03';
function v8UpcomingExtraRows(){
 return Object.keys(S.months).sort().flatMap(month=>v5Catalog(month,'extra'))
  .filter(x=>!v5RowStatus(x).done)
  .filter(x=>x.month>=dayLocal().slice(0,7));
}
function v8FundDisplay(){
 const coverage=v8TaxMinimum();
 $('v8FundMonth').value=v8FundMonth;
 const funds=v8TaxFunds(v8FundMonth),taxDue=v8TaxBills(v8FundMonth);
 const actualTax=v8TaxActiveCents(),actualExtra=v8ExtraTotalActive();
 $('v8FundsTaxTotal').textContent=v8Money(actualTax);
 $('v8FundsExtraTotal').textContent=v8Money(actualExtra);
 $('v8FundCoverage').innerHTML=coverage.month?
  '<p>Prossimo gruppo di scadenze fiscali previste: <b>'+escapeHTML(monthTitle(coverage.month))+
  ' · '+v8Money(coverage.total)+'</b>.</p>'+
  '<p>Per coprirle da marzo, quota minima media indicativa: <b>'+
   v8Money(coverage.need)+'/mese</b> per '+coverage.count+' mesi. '+
   'Piano già presente: <b>'+v8Money(coverage.planned)+'</b> di accantonamenti futuri, '+
   'fondi effettivi protetti '+v8Money(coverage.current)+'.</p>'+
  (coverage.shortfall>0?'<p class="v8-warning">Riserva prevista insufficiente di '+
     v8Money(coverage.shortfall)+'. Le somme fiscali sono stime da confermare.</p>':
     '<p class="v8-positive">Sulla base delle stime attuali il piano di accantonamento copre il primo gruppo di F24.</p>'):
   '<p>Non risultano scadenze F24 future nel piano.</p>';
 $('v8TaxRows').innerHTML=funds.map(x=>{
  const done=!!v8FundContribution(x);
  return '<div class="v5-obligation"><label class="v5-check"><input type="checkbox" data-v8-tax-save="'+
   escapeHTML(x.id)+'"'+(done?' checked':'')+'><span class="v5-check-info"><small>'+
   escapeHTML(dayTitle(x.date))+' · '+(done?'Accantonato':'Da accantonare')+
   '</small><strong>'+escapeHTML(x.name)+'</strong><small>Fondo interno, non è un addebito bancario.</small></span></label>'+
   '<div class="v8-row-side"><span class="v5-row-amount">'+money(x.amount)+'</span>'+
    '<button type="button" data-v8-tax-edit="'+escapeHTML(x.id)+'">Rivedi stima</button></div></div>';
 }).join('')||'<p class="small-hint">Nessun accantonamento pianificato in questo mese.</p>';
 $('v8TaxBillRows').innerHTML=Object.keys(S.months).sort().filter(month=>month>=dayLocal().slice(0,7))
  .flatMap(month=>v8TaxBills(month)).map(x=>{
   const paid=!!v5RowStatus(x).done;
   return '<div class="v5-obligation"><label class="v5-check"><input type="checkbox" data-v8-tax-bill="'+
    escapeHTML(x.id)+'"'+(paid?' checked':'')+'><span class="v5-check-info"><small>'+
    escapeHTML(dayTitle(x.date))+' · '+(paid?'Segnato pagato':'F24 previsto, importo da verificare')+
    '</small><strong>'+escapeHTML(x.name)+'</strong></span></label>'+
    '<div class="v8-row-side"><span class="v5-row-amount">'+money(x.amount)+'</span>'+
    '<button type="button" data-v8-tax-edit="'+escapeHTML(x.id)+'">Rivedi stima</button></div></div>';
  }).join('')||'<p class="small-hint">Nessun F24 previsto nelle prossime scadenze.</p>';
 const extraRows=v8UpcomingExtraRows();
 $('v8ExtraFundRows').innerHTML=extraRows.map(x=>{
  const saved=v8ExtraFundActual(x.id),plan=v8ExtraPlanFor(x.id);
  return '<div class="v8-extra-item"><div class="v8-extra-top"><div><small>'+
    escapeHTML(monthTitle(x.month)+' · '+dayTitle(x.date))+'</small><strong>'+escapeHTML(x.name)+
    '</strong></div><b>'+money(x.amount)+'</b></div>'+
    '<div class="v8-progress">Effettivamente riservati '+v8Money(saved)+' / '+money(x.amount)+
    (plan?' · '+v8Money(plan.monthlyCents)+'/mese programmati':'')+'</div>'+
    '<div class="v8-extra-actions"><button type="button" data-v8-extra-save="'+escapeHTML(x.id)+
    '">+ Accantona</button><button type="button" data-v8-extra-plan="'+escapeHTML(x.id)+
    '">Quota mensile</button></div></div>';
 }).join('')||'<p class="small-hint">Nessuna spesa extra futura da finanziare.</p>';
 $('v8ExtraFundEvents').innerHTML=(S.v8ExtraSavings||[]).slice(-20).reverse().map(x=>{
  const row=v8ExtraRow(x.expenseId);
  return '<div class="v8-saved-event"><span>'+escapeHTML(row?.name||'Spesa precedente')+
    ' · '+escapeHTML(x.account)+'</span><b>'+v8Money(x.amountCents)+'</b>'+
    '<button type="button" data-v8-extra-undo="'+escapeHTML(x.id)+'">Libera</button></div>';
 }).join('')||'<p class="small-hint">Nessuna somma accantonata per spese extra.</p>';
}
function v8NextIncomeOn(account){
 const today=dayLocal();
 const rows=Object.keys(S.months).sort().flatMap(month=>v5Catalog(month,'income'))
  .filter(x=>x.account===account&&!v5RowStatus(x).done&&x.date>=today)
  .sort((a,b)=>a.date.localeCompare(b.date));
 return rows[0]?.date||null;
}
function v8Advisory(){
 const today=dayLocal(),balances=v5AccountBalances(),protectedByAccount=v8ReserveDistribution();
 const minimum={},shortages={},surpluses={};
 for(const account of V8_BANKS){
  if(account==='Cash'){minimum[account]=asCents(balances.Cash);shortages[account]=0;surpluses[account]=0;continue}
  const next=v8NextIncomeOn(account);
  const ceiling=next||new Date(new Date(today+'T12:00:00').getTime()+36*86400000).toISOString().slice(0,10);
  let obligations=0;
  for(const month of Object.keys(S.months)){
   for(const kind of ['fixed','extra']){
    const rows=v5Catalog(month,kind).filter(x=>!v5RowStatus(x).done&&x.account===account);
    for(const x of rows)if(x.date<=ceiling)obligations+=asCents(x.amount);
   }
   for(const x of v8TaxBills(month).filter(x=>!v5RowStatus(x).done&&x.account===account)){
    if(x.date<=ceiling)obligations+=asCents(x.amount);
   }
  }
  // Food is transferred to a joint bank account on the first; it is
  // excluded from patrimony automatically but must still be financed.
  if(account==='Intesa'&&!S.firstStart){
   for(const month of Object.keys(S.months)){
    if(month<'2026-12'||month+'-01'>ceiling||month+'-01'<today)continue;
    if(!(S.v6ExternalFood||[]).some(x=>x.month===month))obligations+=30000;
   }
  }
  minimum[account]=obligations+(protectedByAccount[account]||0);
  shortages[account]=Math.max(0,minimum[account]-asCents(balances[account]));
  surpluses[account]=Math.max(0,asCents(balances[account])-minimum[account]);
 }
 const transferable=Math.max(0,(surpluses.Isybank||0)+(surpluses.Intesa||0)-
   (shortages.Isybank||0)-(shortages.Intesa||0));
 const plannedFree=Math.max(0,v8Now().free);
 return {balances,protectedByAccount,minimum,shortages,surpluses,transferable,
   revolutTarget:plannedFree,missing:(shortages.Isybank||0)+(shortages.Intesa||0)};
}
function v8WalletDisplay(){
 const advice=v8Advisory(),a=advice.balances;
 $('walletAccounts').innerHTML=V8_BANKS.map(name=>{
   const rec=lastBankUpdate(name);
   const protectedCash=advice.protectedByAccount[name]||0;
   const real=asCents(a[name]);
   const free=Math.max(0,real-protectedCash);
   let recommendation='';
   if(name==='Isybank'||name==='Intesa'){
     const target=advice.minimum[name]||0;
     const shortage=advice.shortages[name]||0;
     recommendation='<small>Minimo prudenziale per scadenze ravvicinate e fondi: <b>'+
       v8Money(target)+'</b></small>'+
       (shortage?'<small class="v8-warning">Mancano '+v8Money(shortage)+
         ' prima di trasferire denaro altrove.</small>':
         '<small class="v8-positive">Margine sopra il minimo '+v8Money(advice.surpluses[name])+'</small>');
   }else if(name==='Revolut'){
     recommendation='<small>Obiettivo netto da destinare a Revolut: <b>'+
       v8Money(advice.revolutTarget)+'</b>. Importo trasferibile ora in sicurezza: <b>'+
       v8Money(advice.transferable)+'</b>.</small>';
   }else recommendation='<small>Contanti effettivamente in possesso: <b>'+money(a.Cash)+
     '</b> · si aggiornano con entrate/uscite Cash.</small>';
   return '<div class="v8-wallet-row"><div class="v8-wallet-title"><b>'+name+
     '</b><strong>'+money(a[name])+'</strong></div>'+
     '<small>Saldo stimato · '+escapeHTML(rec?'ultimo allineamento '+dayTitle(rec.date):
       'aggiornato dai movimenti registrati')+'</small>'+
     '<small>Riservati in fondi: '+v8Money(protectedCash)+
       ' · saldo non vincolato: '+v8Money(free)+'</small>'+recommendation+
     '<button type="button" class="v8-manual" data-bank-v5="'+name+'">Modifica saldo reale</button></div>';
 }).join('');
 $('v8WalletAdvice').textContent=
   'La distribuzione è una proposta basata sulle scadenze note fino al prossimo incasso previsto su ciascun conto. '+
   'Non include bollette sconosciute e non esegue trasferimenti bancari. '+
   (advice.missing?
    'Prima di spostare soldi su Revolut, copri '+v8Money(advice.missing)+
    ' di fabbisogno potenziale sulle scadenze Isybank/Intesa.':
    'Puoi destinare gradualmente il netto a Revolut dopo aver protetto tutte le scadenze.');
}
function v8FundMove(delta){
 const d=new Date(v8FundMonth+'-01T12:00:00');
 d.setMonth(d.getMonth()+delta);
 const value=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
 if(value<V8_START_TAX||!S.months[value])return;
 v8FundMonth=value;v5Render();
}

function v8MonthCards(){
 if(S.policyVersion>=25)return v25MonthCards();
 const data=v8Plans().filter(x=>x.month>=visibleMonth()).slice(0,6);
 const cashRows=S.policyVersion>=17?v17MonthMetrics():S.policyVersion>=16?v16SixMonthRows():[];
 const projection=S.policyVersion>=19?v17DailyPlan():null;
 $('v5MonthCards').innerHTML=data.map(m=>
   '<article class="month-card"><div class="month-header"><div><small>PREVISIONE</small><h3>'+
     escapeHTML(monthTitle(m.month))+'</h3></div><div class="month-net v19-month-net">'+
     (S.policyVersion>=19?'<div class="v19-cycle-value"><small>Netto fino alla prossima entrata</small>'+
       '<strong class="v19-cycle-amount">'+
       v8Money(v19CycleForMonth(m.month,projection)?.net||0)+'</strong></div>':'')+
     '<div class="v19-month-end"><small>Netto libero a fine mese</small><strong>'+
     money(euro(S.policyVersion>=19?(cashRows.find(x=>x.month===m.month)?.atEnd||0):
       S.policyVersion>=16?(cashRows.find(x=>x.month===m.month)?.netFree||0):m.ending))+
     '</strong></div></div></div><div class="month-lines">'+
     '<div class="v5-projection-line"><span>Patrimonio iniziale</span><b>'+money(euro(m.opening))+'</b></div>'+
     '<div class="v5-projection-line"><span>Entrate ancora previste</span><b>'+money(euro(m.income))+'</b></div>'+
     '<div class="v5-projection-line"><span>Finanziamenti e abbonamenti</span><b>'+money(euro(m.fixed))+'</b></div>'+
     (S.policyVersion>=11?'<div class="v5-projection-line"><span>Fondi case e alimentari'+
       (S.policyVersion>=16&&m.month==='2027-01'?' (alimentari nel viaggio)':'')+
       '</span><b>'+money(euro(m.homeFunds||0))+'</b></div>':'')+
     '<div class="v5-projection-line"><span>Spese extra alla scadenza</span><b>'+money(euro(m.variable))+'</b></div>'+
     '<div class="v5-projection-line"><span>F24 fiscali previsti</span><b>'+money(euro(m.taxBills))+'</b></div>'+
     '<div class="v5-projection-line"><span>Da accantonare per tasse</span><b>'+
       money(euro(m.plannedTax))+'</b></div>'+
     '<div class="v5-projection-line"><span>Quota programmata fondi extra</span><b>'+
       money(euro(m.plannedExtra))+'</b></div>'+
     '<div class="v5-projection-line"><span>Fondi rimanenti (tasse + extra)</span><b>'+
       money(euro(m.remainingTax+m.remainingExtra))+'</b></div>'+
     '<div class="v5-projection-line"><span>Patrimonio finale · fondi inclusi</span><b>'+
       money(euro(m.grossEnd))+'</b></div>'+
     (S.policyVersion>=16?'<div class="v5-projection-line"><span>Fondi protetti già inclusi nel patrimonio</span><b>'+
       money(euro(S.policyVersion>=17?(cashRows.find(x=>x.month===m.month)?.protectedSum||0):(m.remainingTax+m.remainingExtra)))+'</b></div>'+
       '<div class="v5-projection-line"><span>Netto prudente fino a '+
         escapeHTML(monthTitle(cashRows.at(-1)?.month||m.month))+'</span><b>'+
       money(euro(cashRows.find(x=>x.month===m.month)?.netFree||0))+'</b></div>'+
       (m.month==='2027-01'?'<p class="small-hint">Dal 17 gennaio al 4 febbraio: i 300 € alimentari di gennaio sono già parte dei 1.000 € del budget viaggio estero, non un secondo addebito.</p>':''):'')+
   '</div></article>').join('')||
   '<div class="panel">Nessuna proiezione disponibile.</div>';
}


/* V9 - Cash allocation decisions. All monetary values below are cents.
 * No banking integration: actions only register a transfer already done.
 * One source of truth (v5AccountBalances), recomputed after every save.
 */
function v9Upgrade(old){
 const s=v5Clone(old);
 if(s.policyVersion>=9)return old;
 if(!Array.isArray(s.v9Transfers))s.v9Transfers=[];
 if(!s.v9AccountOverrides)s.v9AccountOverrides={};
 s.policyVersion=9;
 return validate(s);
}
function v9NextIncome(account){
 const today=dayLocal();
 return Object.keys(S.months).sort()
   .flatMap(m=>v5Catalog(m,'income'))
   .filter(x=>x.account===account&&!v5RowStatus(x).done&&x.date>=today)
   .sort((a,b)=>a.date.localeCompare(b.date))[0]||null;
}
function v9FallbackFrom(iso,days){
 const d=new Date(iso+'T12:00:00');
 d.setDate(d.getDate()+days);
 return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+
   String(d.getDate()).padStart(2,'0');
}
function v9FallbackDate(days){
 const d=new Date(dayLocal()+'T12:00:00');
 d.setDate(d.getDate()+days);
 return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+
   String(d.getDate()).padStart(2,'0');
}
function v9AccountNeeds(account,until,from){
 const today=dayLocal(),items=[];
 const earliest=from||v13WindowStart();
 for(const month of Object.keys(S.months).sort()){
  for(const kind of ['fixed','extra']){
   for(const x of v5Catalog(month,kind)){
    if(x.account!==account||v5RowStatus(x).done||
        x.date>until||x.date<earliest)continue;
    items.push({id:x.id,date:x.date,name:x.name,kind,
      amountCents:asCents(x.amount)});
   }
  }
  for(const x of v8TaxBills(month)){
   const assigned=S.v9AccountOverrides?.[x.id]||x.account;
   if(assigned!==account||v5RowStatus(x).done||x.date>until||
      x.date<earliest)continue;
   items.push({id:x.id,date:x.date,name:x.name,kind:'tax',
     amountCents:asCents(x.amount)});
  }
  if(S.policyVersion>=11){
   for(const x of v11HouseRows(month)){
    if(x.account!==account||v5RowStatus(x).done||
      x.reserveDate>until||x.reserveDate<earliest)continue;
    items.push({id:x.id,date:x.reserveDate,name:x.name,kind:'housefund',
      amountCents:asCents(x.amount)});
   }
  }else if(account==='Intesa'&&month>='2026-12'){
   const due=month+'-01';
   if(due>until||due<earliest)continue;
   const food=(S.v6ExternalFood||[]).find(x=>x.month===month);
   if(!food||!food.reconciled){
    items.push({id:null,date:due,name:'Versamento alimentari al cointestato',
      kind:'food',amountCents:30000});
   }
  }
 }
 items.sort((a,b)=>a.date.localeCompare(b.date));
 return items;
}
/* V10: Correct mortgage account on upgrade from V9, while preserving
 * bank balances, previous transactions, paid flags and manual account checks.
 * The projected Revolut amount is the same amount as the headline NETTO LIBERO OGGI.
 */
function v10Upgrade(old){
 const s=v5Clone(old);
 if(s.policyVersion>=10)return old;
 if(!s.v9AccountOverrides)s.v9AccountOverrides={};
 const mortgageRows=[];
 for(const [month,m] of Object.entries(s.months||{})){
   for(const x of [...(m.details?.fixed||[]),...(m.completed?.fixed||[])]){
     if(/\bmutuo\b/i.test(x.name||''))mortgageRows.push({month,x});
   }
 }
 for(const x of s.manualEntries||[]){
   if(x.kind==='fixed'&&/\bmutuo\b/i.test(x.name||''))mortgageRows.push({month:x.month,x});
 }
 const changed=[];
 for(const {month,x} of mortgageRows){
   const key=v5Key(month,'fixed',x);
   if(s.v9AccountOverrides[key]!=='Intesa'||x.account!=='Intesa')changed.push(key);
   x.account='Intesa';
   s.v9AccountOverrides[key]='Intesa';
 }
 // Already-paid movements and confirmed bank balances are intentionally kept:
 // reclassifying an old bank debit without verification could fabricate cash.
 s.v10MortgageCorrection={month:dayLocal().slice(0,7),
   account:'Intesa',affectedKeys:changed};
 s.policyVersion=10;
 return validate(s);
}

/* V12: the only recurring fixed charge on Intesa is the mortgage.
 * Every other unpaid fixed financing/subscription charge belongs to Isybank.
 * Historical paid items, account-confirmed movements, rent income and tax
 * fund reserves must retain their recorded account.
 */
function v12FixedBank(row){
 if(S?.firstStart===true)return row.account||'Isybank';
 return /\bmutuo\b/i.test(row.name||'')?'Intesa':'Isybank';
}
function v12Upgrade(old){
 const updated=v5Clone(old);
 if((updated.policyVersion||0)>=12)return old;
 if(!updated.v9AccountOverrides)updated.v9AccountOverrides={};
 let reassigned=0,skippedPaid=0;
 const adapt=(row,month,id)=>{
  if(!row||row.type==='FONDO_TASSE'||row.type==='V11_DUPLICATE_TIM'||
      row.type==='V11_DEPRECATED_PETROL')return;
  const done=(updated.monthlyChecks||[]).some(x=>x.id===id&&x.status==='done')||
   (updated.bankStatement||[]).some(x=>x.reviewStatus==='settled'&&
      x.matchPlan?.month===month&&x.matchPlan?.group==='fixed'&&
      (x.matchPlan?.name||'').toLowerCase()===(row.name||'').toLowerCase());
  if(done){skippedPaid++;return}
  const desired=v12FixedBank(row);
  if(row.account!==desired||updated.v9AccountOverrides[id]!==desired)reassigned++;
  row.account=desired;
  updated.v9AccountOverrides[id]=desired;
 };
 for(const [month,m] of Object.entries(updated.months||{})){
  for(const row of m.details?.fixed||[])
   adapt(row,month,v5Key(month,'fixed',row));
 }
 for(const row of updated.manualEntries||[]){
  if(row.kind==='fixed')adapt(row,row.month,row.id);
 }
 updated.v12AccountPolicy={
  Isybank:'tutte le uscite fisse e i fondi casa escluso mutuo',
  Intesa:'unico addebito fisso mutuo; incassi affitto e rimborsi',
  mortgage:'Intesa',allOtherUnpaidFixed:'Isybank',updatedAt:dayLocal(),
  reassigned,paidItemsUnmodified:skippedPaid
 };
 updated.policyVersion=12;
 return validate(updated);
}

/* V13 cash-flow start: the baseline balances were reconciled on 18 Nov.
 * Earlier unmarked entries are not fresh liabilities. They remain available
 * in their month ledgers, not auto-marked paid or deleted.
 */
const V13_CASH_START='2026-11-18';
const V13_HOUSE_START='2026-12';
const V13_RESERVE_DAY='18';
function v13IsForecastCurrent(x){
 return S.policyVersion<13||x.date>=V13_CASH_START;
}
function v13WindowStart(){
 return S.policyVersion>=13?V13_CASH_START:'0000-01-01';
}
function v13Upgrade(old){
 const v=v5Clone(old);
 if((v.policyVersion||0)>=13)return old;
 for(const [month,m] of Object.entries(v.months||{})){
  if(month<'2026-12')continue;
  for(const row of m.details?.fixed||[]){
    if(/alimentar/i.test(row.name||'')&&row.type==='HOUSE_FUND'){
      row.note='Alimentari: quota di 300 euro dal 18 del mese, dopo gli accrediti. Conto cointestato fuori patrimonio.';
      row.status='FONDO_ALIMENTARI_DAL_18';
    }
  }
 }
 v.v13CashCycle={
   baselineFrom:V13_CASH_START,houseFundsFirstMonth:V13_HOUSE_START,
   monthlyFundDay:18,
   incomeWindow:'14–17',
   accountingNotice:'Scadenze prima del 18/11/2026 escluse dai nuovi fabbisogni; non segnate automaticamente come pagate.'
 };
 v.policyVersion=13;
 return validate(v);
}
function v13FollowingIncome(account,after){
 return Object.keys(S.months).sort().flatMap(month=>v5Catalog(month,'income'))
   .filter(x=>x.account===account&&!v5RowStatus(x).done&&x.date>after)
   .sort((a,b)=>a.date.localeCompare(b.date))[0]||null;
}

function v9Plan(){
 const balances=v5AccountBalances(),reserved=v8ReserveDistribution();
 const now=dayLocal(),data={};
 for(const account of V8_BANKS){
   const next=v9NextIncome(account);
   const until=next?(S.policyVersion>=11?v11DayBefore(next.date):next.date):v9FallbackDate(35);
   const items=v9AccountNeeds(account,until);
   const due=items.reduce((n,x)=>n+x.amountCents,0);
   const protectedCents=reserved[account]||0;
   const current=asCents(balances[account]);
   const required=due+protectedCents;
   const following=next?v13FollowingIncome(account,next.date):null;
   const afterUntil=following?v11DayBefore(following.date):
     (next?v9FallbackFrom(next.date,35):null);
   const afterItems=next&&afterUntil?v9AccountNeeds(account,afterUntil,next.date):[];
   const afterRequired=afterItems.reduce((n,x)=>n+x.amountCents,0)+protectedCents;
   data[account]={
     account,current,required,due,protected:protectedCents,
     short:Math.max(0,required-current),
     excess:Math.max(0,current-required),
     nextIncome:next?{name:next.name,date:next.date,amountCents:asCents(next.amount)}:null,
     until,items,
     afterIncome:next?{date:next.date,amountCents:asCents(next.amount),
       nextDate:following?.date||null,until:afterUntil,required:afterRequired,items:afterItems}:null
   };
 }
 // Bank shortfalls have priority over moving discretionary funds to Revolut.
 const surplus=Object.fromEntries(V8_BANKS.map(x=>[x,data[x].excess]));
 const shortage={Isybank:data.Isybank.short,Intesa:data.Intesa.short};
 const actions=[];
 for(const destination of ['Isybank','Intesa']){
   for(const source of ['Intesa','Isybank','Revolut']){
     if(source===destination||shortage[destination]<=0||surplus[source]<=0)continue;
     const cents=Math.min(surplus[source],shortage[destination]);
     if(cents<=0)continue;
     actions.push({from:source,to:destination,amountCents:cents,
       label:'Copri le spese obbligatorie'});
     surplus[source]-=cents;shortage[destination]-=cents;
   }
 }
 let stillMissing=shortage.Isybank+shortage.Intesa;
 // Optional alternatives, NOT additional transfers on top of other suggestions.
 const cashAlternatives=[];
 let cashAvailable=Math.max(0,data.Cash.current-data.Cash.protected);
 for(const target of ['Isybank','Intesa']){
   const amountCents=Math.min(data[target].short,cashAvailable);
   if(amountCents>0){
     cashAlternatives.push({from:'Cash',to:target,amountCents,
       label:'Cash invece di trasferimento bancario'});
     cashAvailable-=amountCents;
   }
 }
  const cashOptional=stillMissing>0?Math.min(stillMissing,surplus.Cash):0;
 const cashActions=[];
 let availableCash=cashOptional;
 for(const target of ['Isybank','Intesa']){
   if(availableCash<=0||shortage[target]<=0)continue;
   const amountCents=Math.min(shortage[target],availableCash);
   cashActions.push({from:'Cash',to:target,amountCents,
     label:'Versa i contanti che possiedi già, se necessario'});
   availableCash-=amountCents;
 }
 const missingAfterCash=Math.max(0,stillMissing-cashOptional);
 // Only the remaining banking surplus can finance discretionary Revolut.
 const maxFree=Math.max(0,v8Now().free);
 const moveRevolut=stillMissing===0?Math.min(maxFree,surplus.Isybank+surplus.Intesa):0;
 if(moveRevolut>0){
   for(const source of ['Intesa','Isybank']){
     const amountCents=Math.min(surplus[source],moveRevolut-
       actions.filter(x=>x.to==='Revolut').reduce((n,x)=>n+x.amountCents,0));
     if(amountCents>0){
       actions.push({from:source,to:'Revolut',amountCents,label:'Destina al netto spendibile'});
       surplus[source]-=amountCents;
     }
   }
 }
 return {today:now,balances,accounts:data,actions,cashActions,cashAlternatives,
   missingBank:stillMissing,cashOptional,missingAfterCash,
   transferableRevolut:actions.filter(x=>x.to==='Revolut').reduce((n,x)=>n+x.amountCents,0)};
}
function v9ActionHtml(action,optional=false){
 const title='Sposta '+v8Money(action.amountCents)+' da '+action.from+' a '+action.to;
 return '<div class="v9-move"><div><strong>'+escapeHTML(title)+'</strong>'+
  '<small>'+(optional?'Solo se vuoi utilizzare i contanti. Non li considero già versati.':
    escapeHTML(action.label||'Proteggi le prossime scadenze'))+'</small></div>'+
  '<button type="button" data-v9-from="'+escapeHTML(action.from)+'" '+
   'data-v9-to="'+escapeHTML(action.to)+'" data-v9-cents="'+action.amountCents+'">'+
   'Ho effettuato lo spostamento</button></div>';
}
/* V15: 6-month summary exposes the difference between closing wealth
 * and the LOWEST point reached inside that month, including recurring Cash.
 * The tables recalculate after each payment, deposit, income or manual edit.
 */
/* V16 cash-aware six-month net:
 * - January 2027 groceries (EUR 300) are a part of the EXISTING EUR 1000
 *   Thailand allowance, not an additional EUR 300 charge.
 * - Monthly spendable is a prudent end-of-month allowance: the minimum
 *   unreserved wealth from that month-end through the end of the visible
 *   6-month horizon. It cannot be mistaken for the gross ending wealth.
 * - Earmarked tax and extra balances remain in assets but cannot be spent.
 */
const V16_THAILAND_START='2027-01-17';
const V16_THAILAND_END='2027-02-04';
const V16_JAN_FOOD_INCLUDED=30000;
function v16Upgrade(old){
 const next=v5Clone(old);
 if((next.policyVersion||0)>=16)return old;
 next.v16TravelFood={
   tripStart:V16_THAILAND_START,tripEnd:V16_THAILAND_END,
   month:'2027-01',foodCents:30000,
   includedInExistingThailandAllowanceCents:100000,
   doubleCountAvoided:true,
   februaryFoodUnchanged:true
 };
 const thailand=next.months['2027-01']?.details?.variable?.find(x=>
   /viaggio\s+estero/i.test(x.name||'')&&asCents(x.amount)===100000);
 if(thailand){
   thailand.note='Budget viaggio estero dal 17 gennaio al 4 febbraio: 1.000 euro totali, comprensivi dei 300 euro alimentari di gennaio, non da sottrarre nuovamente.';
 }
 // The 575-euro rent is recurring, not confined to Jan-Apr.
 // Older forecast stopped recording it in May, making later rolling
 // six-month projections artificially pessimistic.
 const rentTemplate=next.months['2027-04']?.details?.income?.find(x=>/affitto/i.test(x.name||''));
 const addedRent=[];
 if(rentTemplate)for(const [month,m] of Object.entries(next.months)){
   if(month<'2027-05')continue;
   const exists=(m.details?.income||[]).some(x=>/affitto/i.test(x.name||''))||
     (next.manualEntries||[]).some(x=>x.kind==='income'&&x.month===month&&/affitto/i.test(x.name||''));
   if(exists)continue;
   const row=v5Clone(rentTemplate);
   row.date=month+'-17';
   row.account='Intesa';
   row.estimated=false;
   row.note='Affitto ricorrente lordo 575 euro: 500 affitto + 50 condominio + 25 Internet. Eventuali bollette inquilina a rimborso separato.';
   m.details.income.push(row);
   m.income=euro(asCents(m.income)+asCents(row.amount));
   addedRent.push(month);
 }
 next.v16TravelFood.rentMonthsRestored=addedRent;
 // Important: do not remove past confirmed outgoing or bank-verified entries.
 // Future January food is excluded in v11HouseRows and v6AutoFood, without
 // editing the user's bank amounts, actual movement history, or budget extras.
 next.policyVersion=16;
 return validate(next);
}
function v16SixMonthRows(){
 const plan=v8Plans();
 let first=plan.findIndex(x=>x.month>=dayLocal().slice(0,7));
 if(first<0)first=0;
 const months=plan.slice(first,first+6);
 const base=Object.values(v5AccountBalances()).reduce((n,x)=>n+asCents(x),0);
 const events=[];
 const extraHeld=new Map();
 for(const saved of S.v8ExtraSavings||[]){
   const row=v8ExtraRow(saved.expenseId);
   if(row&&!v5RowStatus(row).done&&!v7IsExcluded(row.id))
     extraHeld.set(row.id,(extraHeld.get(row.id)||0)+saved.amountCents);
 }
 let taxHeld=v8TaxActiveCents();
 let goalsHeld=0;
 const held=()=>[...extraHeld.values()].reduce((sum,cents)=>sum+cents,0);
 const dateNow=dayLocal();
 let gross=base;
 const out=[];
 function put(day,category,cents,label,id='',cap=0){
   if(!day||!cents)return;
   events.push({day:day<dateNow?dateNow:day,
     category,cents,label,id,cap});
 }
 for(const m of months){
  const entries=[];
  function add(day,category,cents,label,id='',cap=0){
    const entry={day:day<dateNow?dateNow:day,category,cents,label,id,cap};
    entries.push(entry);
    events.push(entry);
  }
  for(const x of m.rows.fixed)
    add(x.date,'due',asCents(x.amount),x.name,x.id);
  for(const x of m.rows.extra)
    add(x.date,'extra',asCents(x.amount),x.name,x.id);
  for(const x of m.rows.house)
    add(x.reserveDate,'house',asCents(x.amount),x.name,x.id);
  for(const x of m.taxDue||[])
    add(x.date,'taxBill',asCents(x.amount),x.name,x.id);
  for(const x of m.rows.income)
    add(x.date,'income',asCents(x.amount),x.name,x.id);
  for(const x of v8DueTax(m.month)){
    const date=x.date||m.month+'-18';
    add(date,'taxReserve',asCents(x.amount),x.name,x.id);
  }
  const goals=asCents(m.base.goals?.casa||0)+asCents(m.base.goals?.viaggi||0);
  if(goals)add(m.month+'-18','goalsReserve',goals,'Obiettivi programmati');
  for(const planExtra of S.v8ExtraPlans||[]){
    const extra=v8ExtraRow(planExtra.expenseId);
    if(!extra||v5RowStatus(extra).done||v7IsExcluded(extra.id)||
       m.month<planExtra.startMonth||m.month>extra.month||
       m.month+'-18'>extra.date)continue;
    add(m.month+'-18','extraReserve',planExtra.monthlyCents,
      'Accantonamento '+extra.name,extra.id,asCents(extra.amount));
  }
 }
 const priority={due:0,extra:0,taxBill:0,taxReserve:1,
   goalsReserve:1,extraReserve:1,income:2,house:3};
 events.sort((a,b)=>a.day.localeCompare(b.day)||
   priority[a.category]-priority[b.category]||
   a.label.localeCompare(b.label,'it'));
 let cursor=0;
 const snapshots=[];
 for(const m of months){
   let monthLow=gross,monthLowDay=dateNow;
   while(cursor<events.length&&events[cursor].day.slice(0,7)<=m.month){
     const e=events[cursor++];
     switch(e.category){
       case 'income':gross+=e.cents;break;
       case 'taxReserve':taxHeld+=e.cents;break;
       case 'goalsReserve':goalsHeld+=e.cents;break;
       case 'extraReserve':{
         const previous=extraHeld.get(e.id)||0;
         extraHeld.set(e.id,previous+Math.min(e.cents,Math.max(0,e.cap-previous)));
         break;
       }
       case 'taxBill':
         gross-=e.cents;
         taxHeld=Math.max(0,taxHeld-e.cents);
         break;
       case 'extra':
         gross-=e.cents;
         extraHeld.set(e.id,Math.max(0,(extraHeld.get(e.id)||0)-e.cents));
         break;
       default:gross-=e.cents;break;
     }
     const unlocked=gross-taxHeld-goalsHeld-held();
     snapshots.push({day:e.day,month:m.month,unlocked});
     if(gross<monthLow){monthLow=gross;monthLowDay=e.day;}
   }
   // v8Plans is the authoritative projection of total end-of-month wealth;
   // daily schedule is validated against it in V16 regression tests.
   const protectedSum=taxHeld+goalsHeld+held();
   const atEnd=gross-protectedSum;
   out.push({month:m.month,closing:gross,
     accordingToPlan:m.grossEnd,protectedSum,atEnd,
     low:monthLow,lowDate:monthLowDay,
     income:m.income,fixed:m.fixed,houseFunds:m.homeFunds,
     extras:m.variable,taxBills:m.taxBills,
     details:m.rows,plan:m,netFree:0,
     until:months.at(-1).month});
 }
 for(let i=0;i<out.length;i++){
   // End-of-month cash available must be left after *all* later known
   // commitments within the displayed horizon (not just current month).
   const future=snapshots.filter(x=>x.month>out[i].month);
   const minimum=Math.min(out[i].atEnd,
      ...future.map(x=>x.unlocked));
   out[i].minFutureUnreserved=minimum;
   out[i].netFree=Math.max(0,minimum);
   out[i].futureShortfall=Math.max(0,-minimum);
   out[i].scopeIsTruncated=i===out.length-1;
 }
 return out;
}
function v16RenderSixMonths(){
 const el=$('v15MonthOverview');
 if(!el)return;
 const rows=v16SixMonthRows();
 el.innerHTML='<div class="v15-lead"><b>Patrimonio, netto spendibile e scadenze</b>'+
   '<span>La disponibilità libera di un mese protegge anche le spese ancora previste'+
   ' nei mesi successivi di questa panoramica. Patrimonio e fondi protetti non sono'+
   ' soldi da trasferire automaticamente a Revolut.</span></div>'+
  '<table class="v15-month-table v16-month-table"><thead><tr>'+
   '<th>Mese</th><th>Patrimonio</th><th>Netto libero</th><th>Minimo</th>'+
   '</tr></thead><tbody>'+
   rows.map(x=>'<tr><th>'+escapeHTML(monthTitle(x.month))+'</th>'+
     '<td>'+v8Money(x.closing)+'</td>'+
     '<td class="v16-net-free">'+v8Money(x.netFree)+
       (x.scopeIsTruncated?'<small>solo fino a '+escapeHTML(monthTitle(x.until))+'</small>':'')+
       '</td>'+
     '<td class="'+(x.low<0?'v15-low':'v15-positive')+'">'+v8Money(x.low)+
       '<small>'+escapeHTML(dayTitle(x.lowDate))+'</small></td></tr>').join('')+
   '</tbody></table>'+
   '<p class="v15-foot">Minimo = punto più basso del patrimonio nel mese,'+
   ' prima o dopo gli accrediti. Il netto libero è il margine spendibile'+
   ' a fine mese dopo aver protetto gli impegni fino a '+escapeHTML(monthTitle(rows.at(-1)?.month||''))+
   '. Non garantisce le spese non ancora registrate né quelle oltre la panoramica.'+
   ' Se il minimo è negativo, servono liquidità anticipata o spese rinviate.</p>';
}

function v15SixMonthRows(){
 const forecast=v8Plans();
 const first=Math.max(0,forecast.findIndex(x=>x.month>=dayLocal().slice(0,7)));
 const months=forecast.slice(first,first+6);
 let running=Object.values(v5AccountBalances()).reduce((n,x)=>n+asCents(x),0);
 const result=[];
 for(const m of months){
  const entries=[];
  function event(date,type,label,amount){
   if(!date||!amount)return;
   entries.push({date:date<dayLocal()?dayLocal():date,
     originalDate:date,type,label,amount});
  }
  for(const x of m.rows.fixed)event(x.date,'due',x.name,-asCents(x.amount));
  for(const x of m.rows.extra)event(x.date,'due',x.name,-asCents(x.amount));
  for(const x of m.rows.house)event(x.reserveDate,'house',x.name,-asCents(x.amount));
  for(const x of m.taxDue||[])event(x.date,'due',x.name,-asCents(x.amount));
  for(const x of m.rows.income)event(x.date,'income',x.name,asCents(x.amount));
  const priority={due:0,income:1,house:2};
  entries.sort((a,b)=>a.date.localeCompare(b.date)||
    priority[a.type]-priority[b.type]||a.label.localeCompare(b.label,'it'));
  let min=running,minDate=dayLocal();
  for(const row of entries){
   running+=row.amount;
   if(running<min){min=running;minDate=row.date}
  }
  result.push({month:m.month,closing:m.grossEnd,afterReserves:m.ending,
    income:m.income,expenses:m.fixed+m.homeFunds+m.variable+m.taxBills,
    low:min,lowDate:minDate,
    allEntriesCount:entries.length});
 }
 return result;
}
function v15SixMonthDisplay(){
 const el=$('v15MonthOverview');
 if(!el)return;
 const months=v15SixMonthRows();
 el.innerHTML='<div class="v15-lead">'+
  '<b>Patrimonio totale e liquidità minima per mese</b>'+
  '<span>I 400 € Cash dei familiari sono entrate fisse ogni 18. '+
   'La colonna “Minimo” mostra gli scoperti possibili prima degli accrediti,'+
   ' anche quando il patrimonio a fine mese è positivo.</span></div>'+
  '<table class="v15-month-table"><thead><tr>'+
   '<th>Mese</th><th>Fine mese</th><th>Minimo nel mese</th>'+
   '</tr></thead><tbody>'+months.map(m=>
    '<tr><th>'+escapeHTML(monthTitle(m.month))+'</th>'+
      '<td>'+v8Money(m.closing)+'</td>'+
      '<td class="'+(m.low<0?'v15-low':'v15-positive')+'">'+
        v8Money(m.low)+'<small>'+escapeHTML(dayTitle(m.lowDate))+'</small>'+
      '</td></tr>').join('')+'</tbody></table>'+
  '<p class="v15-foot">Il patrimonio comprende Cash, Isybank, Intesa e Revolut.'+
  ' Gli accantonamenti fiscali rimangono di tua proprietà; non sono liberi da spendere.'+
  ' Gli importi dipendono dalle scadenze e dai saldi registrati, non da una banca collegata.</p>';
}

function v14RenderRisk(data){
 const el=$('v14RiskSummary');
 if(!el||!data)return;
 // Highest protection: minimum among recorded income intervals
 // throughout the existing 90-day forecast. The number remains signed.
 const negative=data.lowestSpendable<0;
 const day=new Date(data.worstDay+'T12:00:00');
 const when=Number.isFinite(day.getTime())?
   day.toLocaleDateString('it-IT',{day:'numeric',month:'long',year:'numeric'}):
   dayTitle(data.worstDay);
 el.innerHTML='<span class="v20-minimum-caption">Liquidità minima tra le entrate · 90 giorni</span>'+
   '<strong class="v20-minimum-value'+(negative?' v20-negative':'')+'">'+
   v8Money(data.lowestSpendable)+'</strong>'+
   '<span class="v20-minimum-date">'+escapeHTML(when)+'</span>';
}
function v9WalletDisplay(){
 const advice=v9Plan();
  const todayNet=v5Now().free; // protected 90-day spendable, same as headline.
 $('walletAccounts').innerHTML=V8_BANKS.map(account=>{
  const x=advice.accounts[account];
  const rec=lastBankUpdate(account);
  const isCash=account==='Cash',isRevolut=account==='Revolut';
  const heading=isCash?'Denaro contante che possiedi adesso':
    'Saldo attuale stimato dai movimenti';
  let purpose=isCash?'Contanti da conservare per scadenze registrate':
    isRevolut?'NETTO SPENDIBILE SICURO DA DESTINARE A REVOLUT':
      'DA TENERE per le spese fino al prossimo accredito';
  const amountToShow=isRevolut?todayNet:x.required;
  const dateText=isRevolut?
    'Stesso importo del netto davvero spendibile, calcolato sulle scadenze dei prossimi 90 giorni. Non è un trasferimento automatico.':
    x.nextIncome?
    'Prossima entrata prevista: '+dayTitle(x.nextIncome.date)+' · '+x.nextIncome.name+
    ' ('+v8Money(x.nextIncome.amountCents)+')':
    'Nessun nuovo incasso registrato entro il periodo: controllo fino al '+dayTitle(x.until);
  let result='';
  if(isRevolut){
   const amountToAdd=Math.max(0,todayNet-x.current);
   result='<div class="v9-gap v9-revolut-gap">'+
     'Da aggiungere a Revolut per raggiungere l’obiettivo: <strong data-v10-revolut-to-add>'+
       v8Money(amountToAdd)+'</strong>.'+
     '<span> Trasferibile oggi in sicurezza, dopo le scadenze degli altri conti: '+
       '<strong data-v10-revolut-safe>'+v8Money(advice.transferableRevolut)+'</strong>.</span></div>';
  }else if(x.short>0){
   result='<div class="v9-gap v9-missing">Mancano <strong>'+v8Money(x.short)+'</strong> '+
     'per coprire le prossime uscite.</div>';
  }else if(x.excess>0){
   result='<div class="v9-gap v9-covered">Oltre il minimo: <strong>'+
      v8Money(x.excess)+'</strong></div>';
  }else result='<div class="v9-gap v9-covered">Disponibilità esattamente al livello necessario.</div>';
  const details=x.items.length?
    '<details class="v9-due-details"><summary>Vedi le '+x.items.length+
    ' spese considerate nel minimo</summary>'+
      x.items.map(item=>'<div class="v9-due-item"><div><small>'+
        escapeHTML(dayTitle(item.date))+'</small><span>'+escapeHTML(item.name)+
        '</span></div><div><strong>'+v8Money(item.amountCents)+'</strong>'+
        (item.id?'<button type="button" data-v9-assign="'+escapeHTML(item.id)+'">'+
          'Cambia conto</button>':'')+'</div></div>').join('')+'</details>':
      '<p class="v9-none-due">Nessuna scadenza non pagata su questo conto entro il periodo.</p>';
  const control='<button type="button" class="v8-manual" data-bank-v5="'+account+
    '">Modifica saldo reale</button>';
  return '<div class="v9-account"><div class="v9-account-heading"><h3>'+account+'</h3>'+
    '<span class="v9-now-label">QUANTO C’È ADESSO</span></div>'+
    '<strong class="v9-current" data-v9-current="'+account+'">'+v8Money(x.current)+'</strong>'+
    '<div class="v9-estimate-note">'+escapeHTML(heading)+
      (rec?' · ultimo saldo verificato '+dayTitle(rec.date):'')+'</div>'+
    '<div class="v9-need-line"><span>'+purpose+'</span><strong data-v9-need="'+account+'"'+
      (isRevolut?' id="v10RevolutTarget"':'')+'>'+
     v8Money(amountToShow)+'</strong></div>'+
    (isRevolut?'<div class="v9-funds-line">Questo importo coincide con il netto prudente della Panoramica. Il saldo Revolut reale è mostrato sopra.</div>':'')+
    (x.protected?'<div class="v9-funds-line">Inclusi '+v8Money(x.protected)+
      ' di fondi già protetti.</div>':'')+
    '<div class="v9-next">'+escapeHTML(dateText)+'</div>'+result+
    ((S.policyVersion>=13&&(account==='Isybank'||account==='Intesa')&&x.afterIncome)?
      '<div class="v13-after-income"><span>DOPO IL PROSSIMO ACCREDITO ('+
        escapeHTML(dayTitle(x.afterIncome.date))+')</span>'+
        '<strong data-v13-after-need="'+account+'">'+v8Money(x.afterIncome.required)+'</strong>'+
        '<small>Da conservare per le spese successive fino al '+
          escapeHTML(dayTitle(x.afterIncome.until))+
          '. È una previsione futura, non denaro da versare adesso.</small>'+
          '<details class="v13-after-breakdown"><summary>Vedi le '+
            x.afterIncome.items.length+' voci del prossimo ciclo</summary>'+
            x.afterIncome.items.map(item=>
              '<div class="v13-after-row"><span><small>'+escapeHTML(dayTitle(item.date))+
              '</small>'+escapeHTML(item.name)+'</span><div><strong>'+
              v8Money(item.amountCents)+'</strong>'+
              (item.id&&item.kind!=='housefund'?
                '<button type="button" data-v9-assign="'+escapeHTML(item.id)+'">Conto</button>':'')+
              '</div></div>').join('')+'</details></div>':'')+
    details+'<div class="v9-account-actions">'+control+'</div></div>';
 }).join('');
 const entries=[];
 if(S.policyVersion>=11){
   const unknown=v11UnassignedCharges();
   if(unknown.length){
     const total=unknown.reduce((n,x)=>n+asCents(x.amount),0);
     entries.push('<div class="v11-unknown"><b>Spese con conto ancora da assegnare: '+
       v8Money(total)+'</b><p>Non sono incluse nel minimo dei conti finch? non confermi la carta.</p>'+
       unknown.map(x=>'<div><span>'+escapeHTML(x.name)+' ? '+money(x.amount)+
         '</span><button type="button" data-v9-assign="'+escapeHTML(x.id)+'">Assegna conto</button></div>').join('')+
       '</div>');
   }
 }
 if(advice.actions.length){
  for(const a of advice.actions)entries.push(v9ActionHtml(a));
 }else if(advice.missingBank===0){
  entries.push('<p class="v9-done">Le prossime scadenze bancarie risultano coperte dai saldi registrati.</p>');
 }
 if(advice.cashAlternatives?.length||advice.cashActions?.length){
  entries.push('<p class="v14-cash-note"><b>Alternativa: versa il Cash gi? posseduto.</b> '+
    'Scegli tra questo versamento e un trasferimento fra banche: non sommare i due. '+
    'Il patrimonio non aumenta. Registra solo un versamento realmente effettuato.</p>');
  for(const row of (advice.cashAlternatives?.length?
    advice.cashAlternatives:advice.cashActions))entries.push(v9ActionHtml(row,true));
 }
 if(advice.missingBank>0){
  entries.push('<p class="v9-alert">Dopo gli spostamenti proposti'+
   (advice.cashOptional>0?' (anche usando i contanti facoltativamente)':'')+
   ', resterebbero <strong>'+v8Money(advice.missingAfterCash)+
   '</strong> da coprire con entrate future o altre risorse, prima degli addebiti.</p>');
 }
 entries.push('<p class="v9-revolut-tip">Revolut · netto sicuro da destinare: '+
    '<strong>'+v8Money(todayNet)+'</strong>. '+
    'Importo trasferibile oggi senza scoprire le scadenze: '+
    '<strong>'+v8Money(advice.transferableRevolut)+'</strong>. '+
    'Non spostare automaticamente l’intero obiettivo: prima proteggi Isybank e Intesa.</p>');
 $('v9MoveSuggestions').innerHTML=entries.join('');
 const history=(S.v9Transfers||[]).filter(x=>!x.cancelled).slice(-15).reverse();
 $('v9TransferHistory').innerHTML=history.map(x=>
   '<div class="v9-history-item"><div>'+escapeHTML(x.from+' → '+x.to)+
   '<small>'+escapeHTML(dayTitle(x.date))+'</small></div><strong>'+
   v8Money(x.amountCents)+'</strong>'+
   '<button type="button" data-v9-undo="'+escapeHTML(x.id)+'">Annulla</button></div>').join('')||
   '<p class="small-hint">Nessuno spostamento registrato.</p>';
}

function v9AssignAccount(id){
  const rows=Object.keys(S.months).sort().flatMap(month=>[
    ...v5Catalog(month,'fixed'),...v5Catalog(month,'extra'),...v5Catalog(month,'income'),
    ...v8TaxBills(month)
  ]);
  const row=rows.find(x=>x.id===id);
  if(!row||v5RowStatus(row).done){notify('La scadenza non è modificabile: è già pagata o non esiste.',true);return}
  const current=S.v9AccountOverrides?.[id]||row.account;
  const answer=prompt('Da quale conto verrà realmente pagata o ricevuta questa voce?\n'+
    row.name+' · '+money(row.amount)+'\n'+
    (S.firstStart?V8_BANKS.map(v32AccountLabel).join(' / '):V8_BANKS.join(' / ')),
    S.firstStart?v32AccountLabel(current):current);
  if(answer===null)return;
  const bank=S.firstStart?v32ResolveAccount(answer):answer.trim();
  if(!V8_BANKS.includes(bank)){notify('Seleziona uno dei conti disponibili.',true);return}
  if(S.policyVersion>=12&&!S.firstStart&&row.kind==='fixed'&&bank!==v12FixedBank(row)){
    notify('Per le spese fisse: soltanto il mutuo va su Intesa, tutte le altre su Isybank.',true);
    return;
  }
  if(bank===current)return;
  if(!confirm('Associare «'+row.name+'» a '+bank+'?\n'+
    'Si aggiorneranno i soldi da mantenere su ogni conto, non i saldi reali.'))return;
  const next=v5Clone(S);
  if(!next.v9AccountOverrides)next.v9AccountOverrides={};
  next.v9AccountOverrides[id]=bank;
  if(v5Save(next))notify('Conto previsto modificato: distribuzione ricalcolata.');
}
function v9RecordTransfer(from,to,proposedCents){
 if(!V8_BANKS.includes(from)||!V8_BANKS.includes(to)||from===to)return;
 const balances=v5AccountBalances();
 const reserved=v8ReserveDistribution();
 const earmarked=S.policyVersion>=17?(v17TravelAllocations()[from]||0):0;
 const available=asCents(balances[from])-(reserved[from]||0)-earmarked;
 if(available<=0){notify('Nessuna disponibilità libera nel conto '+from,true);return}
 const input=prompt('Hai GIA effettuato questo trasferimento nella banca o in contanti?\n'+
   'Indica l’importo realmente spostato da '+from+' a '+to+' (euro).\n'+
   'La registrazione aggiornerà entrambi i saldi senza creare nuove entrate.',
   String(euro(proposedCents||Math.min(available,5000))).replace('.',','));
 if(input===null)return;
 const value=Number(input.trim().replace(',','.'));
 if(!Number.isFinite(value)||value<=0||value>100000){
   notify('Importo trasferimento non valido.',true);return;
 }
 const amountCents=asCents(value);
 if(amountCents>available){
   notify('Non puoi registrare più del saldo non vincolato di '+from+
     ' ('+v8Money(available)+').',true);return;
 }
 const advice=v9Plan();
 if(amountCents>(advice.accounts[from]?.excess||0)){
   if(!confirm('Attenzione: questo trasferimento riduce il saldo di '+from+
     ' sotto quanto necessario alle sue prossime spese. Confermi di averlo già fatto?'))return;
 }
 if(!confirm('Confermi che hai GIA trasferito '+money(value)+' da '+from+
   ' a '+to+'?\nL’app aggiorna entrambi i saldi. Non esegue alcun bonifico.'))return;
 const next=v5Clone(S);
 if(!Array.isArray(next.v9Transfers))next.v9Transfers=[];
 next.v9Transfers.push({id:'v9_move_'+Date.now()+'_'+Math.random().toString(36).slice(2,8),
   from,to,amountCents,date:dayLocal(),recordedAt:new Date().toISOString(),
   fromReconciled:false,toReconciled:false,cancelled:false});
 if(v5Save(next))notify('Spostamento registrato: entrambi i saldi sono aggiornati; patrimonio invariato.');
}
function v9UndoTransfer(id){
 const entry=(S.v9Transfers||[]).find(x=>x.id===id&&!x.cancelled);
 if(!entry)return;
 if(entry.fromReconciled||entry.toReconciled){
   notify('Uno dei due saldi è già stato riallineato alla banca. Non annullo automaticamente il trasferimento: correggi i saldi reali dei conti coinvolti.',true);
   return;
 }
 if(!confirm('Annullare lo spostamento registrato di '+v8Money(entry.amountCents)+
   ' da '+entry.from+' a '+entry.to+'?\n'+'Entrambi i saldi stimati torneranno ai valori precedenti.'))return;
 const next=v5Clone(S);
 const tr=next.v9Transfers.find(x=>x.id===id);
 if(id.startsWith('v17_thai_')&&next.v17TravelReserve){
   const held=next.v17TravelReserve.allocations;
   held[tr.from]=(held[tr.from]||0)+tr.amountCents;
   held[tr.to]=Math.max(0,(held[tr.to]||0)-tr.amountCents);
 }
 tr.cancelled=true;tr.cancelledAt=new Date().toISOString();
 if(v5Save(next))notify('Trasferimento annullato: patrimonio invariato.');
}
function v9ReconcileTransferLegs(next,account,time){
 for(const row of next.v9Transfers||[]){
   if(row.cancelled||!Number.isFinite(Date.parse(row.recordedAt))||Date.parse(row.recordedAt)>time)continue;
   if(row.from===account)row.fromReconciled=true;
   if(row.to===account)row.toReconciled=true;
 }
}


/* V11: Isybank covers household funds for both homes. Mortgage stays Intesa.
 * All budget reserve checkboxes are non-cash, payments debit only once.
 * All figures in projections are cents, converted at the display boundary.
 */
const V11_VERSION=11;
function v11IsGas(x){return /\bbenzina\b/i.test(x.name||'')&&x.type==='BUDGET_VITA'}
function v11IsHouseFund(x){
 if(S?.firstStart===true)return false;
 if(x.v30FoodFixed===true)return false;
 if(x.type==='HOUSE_FUND')return true;
 if(x.type==='V11_DUPLICATE_TIM')return false;
 return /condominio (?:casa affittata|abitazione principale|prima casa)|bollette (?:abitazione principale|prima casa)|(?:spesa alimentare|quota alimentare|alimentari novembre)/i.test(x.name||'')||
   x.type==='BUDGET_VITA'&&/alimentar|condomin|bollett/i.test(x.name||'');
}
function v11IsBundled(x){return x.type==='V11_DUPLICATE_TIM'}
function v11IsFundSetAside(id){return (S.v11HouseSetAside||[]).includes(id)}
function v11DayBefore(iso){
 const date=new Date(iso+'T12:00:00');
 date.setDate(date.getDate()-1);
 return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+
   String(date.getDate()).padStart(2,'0');
}
function v11HouseRows(month){
 const m=S.months[month];
 if(!m)return [];
 const arr=[];
 for(const source of [...(m.details?.fixed||[]),...(m.completed?.fixed||[])]){
  if(!v11IsHouseFund(source))continue;
  if(S.policyVersion>=13&&month<'2026-12')continue;
  // January 2027: EUR 300 of groceries already INSIDE the EUR 1000
  // Thailand allowance, so do not deduct them separately.
  if(S.policyVersion>=16&&month==='2027-01'&&
     /alimentar/i.test(source.name||''))continue;
  const id=v5Key(month,'fixed',source);
  if(v7IsExcluded(id))continue;
  const grocery=/alimentar|spesa alimentare/i.test(source.name||'');
  arr.push({...source,id,month,kind:'fixed',grocery,
   planned:!!(m.details?.fixed||[]).includes(source),
   confirmed:(m.completed?.fixed||[]).includes(source)||v5KnownPaid(month,'fixed',source),
   account:'Isybank',
   reserveDate:S.policyVersion>=13?month+'-18':month+'-01',
   reserveNote:'Dal 18 del mese, successivamente alle entrate ricorrenti; non è la data dell’addebito'});
 }
 for(const x of S.manualEntries||[]){
  if(x.month!==month||x.kind!=='fixed'||!v11IsHouseFund(x)||v7IsExcluded(x.id))continue;
  arr.push({...x,kind:'fixed',grocery:false,planned:true,confirmed:false,
    account:'Isybank',reserveDate:S.policyVersion>=13?
      (month==='2026-11'?x.date:month+'-18'):month+'-01'});
 }
 const dedupe=new Map();
 for(const x of arr)if(!dedupe.has(x.id))dedupe.set(x.id,x);
 return [...dedupe.values()].sort((a,b)=>a.date.localeCompare(b.date));
}
function v11FindHouse(id){
 for(const month of Object.keys(S.months)){
  const x=v11HouseRows(month).find(x=>x.id===id);
  if(x)return x;
 }
 return null;
}
function v11HouseDue(month){
 return v11HouseRows(month).filter(x=>!v5RowStatus(x).done)
   .reduce((sum,x)=>sum+asCents(x.amount),0);
}
function v11MigrateKeys(s,oldId,newId){
 if(oldId===newId)return;
 for(const x of s.monthlyChecks||[])if(x.id===oldId)x.id=newId;
 for(const x of s.v7ExcludedRows||[])if(x.id===oldId)x.id=newId;
 for(const x of s.v8ExtraSavings||[])if(x.expenseId===oldId)x.expenseId=newId;
 for(const x of s.v8ExtraPlans||[])if(x.expenseId===oldId)x.expenseId=newId;
 for(const field of ['v7ReopenedVerified','v11HouseSetAside']){
  if(Array.isArray(s[field]))
   s[field]=s[field].map(x=>x===oldId?newId:x);
 }
 if(s.v9AccountOverrides&&Object.prototype.hasOwnProperty.call(s.v9AccountOverrides,oldId)){
   s.v9AccountOverrides[newId]=s.v9AccountOverrides[oldId];
   delete s.v9AccountOverrides[oldId];
 }
}
function v11Upgrade(old){
 const s=v5Clone(old);
 if(s.policyVersion>=V11_VERSION)return old;
 if(!Array.isArray(s.v11HouseSetAside))s.v11HouseSetAside=[];
 if(!Array.isArray(s.v11HouseAudit))s.v11HouseAudit=[];
 if(!s.v9AccountOverrides)s.v9AccountOverrides={};
 const impacted=[];
 for(const [month,m] of Object.entries(s.months)){
  for(const row of m.details?.income||[]){
   if(!/stipendio\s+datore/i.test(row.name||'')||month<'2026-12')continue;
   const oldId=v5Key(month,'income',row);
   row.date=month+'-14';
   row.account='Isybank';
   const newId=v5Key(month,'income',row);
   v11MigrateKeys(s,oldId,newId);
   if(!s.monthlyChecks?.some(x=>x.id===newId&&x.status==='done'))
     s.v11HouseAudit.push({id:newId,change:'salary_date',from:oldId,to:newId});
  }
  for(const row of m.details?.fixed||[]){
   const originalId=v5Key(month,'fixed',row);
   const alreadyPaid=(s.monthlyChecks||[]).some(c=>c.id===originalId&&c.status==='done')||
     (s.bankStatement||[]).some(c=>c.reviewStatus==='settled'&&c.matchPlan?.name===row.name&&c.matchPlan?.month===month);
   if(v11IsGas(row)){
     // Petrol is discretionary, not a recurring mandatory charge.
     if(!alreadyPaid)row.type='V11_DEPRECATED_PETROL';
     continue;
   }
   if(/condominio (?:casa affittata|abitazione principale|prima casa)/i.test(row.name||'')){
     row.account='Isybank';
     row.type='HOUSE_FUND';
     row.note='Fondo casa Isybank: quota mensile di 50 €, pagamento effettivo da confermare';
     s.v9AccountOverrides[originalId]='Isybank';
   }
   if(/bollette (?:abitazione principale|prima casa)/i.test(row.name||'')){
     if(!alreadyPaid)row.amount=150;
     row.account='Isybank';
     row.type='HOUSE_FUND';
     row.note='Fondo luce casa principale: 150 € stimati al mese, correggi alla bolletta';
     s.v9AccountOverrides[originalId]='Isybank';
   }
   if(/^(?:spesa alimentare|quota alimentare)/i.test(row.name||'')&&month>='2026-12'){
     row.account='Isybank';
     row.type='HOUSE_FUND';
     row.externalFood=true;
     row.note='Budget alimentare 300 € da Isybank al cointestato esterno il primo del mese';
     s.v9AccountOverrides[originalId]='Isybank';
   }
   if(row.name==='Internet casa affittata'){
     row.account='Isybank';
     s.v9AccountOverrides[originalId]='Isybank';
     if(month>='2026-12'){
       // Included in the 35 EUR TIM charge, so never charge twice.
       if(!alreadyPaid)row.type='V11_DUPLICATE_TIM';
       row.note='25 € già inclusi nel TIM da 35 € (con cellulare da 10 €)';
     }else if(!alreadyPaid){
       row.amount=35;
       row.note='Stima Internet casa affittata 25 € + seconda linea mobile 10 €; data da verificare';
       row.type='PAGAMENTO';
     }
   }
   if(row.name==='TIM'&&month>='2026-12'){
     if(!alreadyPaid)row.amount=35;
     row.account='Isybank';
     row.note='Internet casa affittata 25 € + telefono personale 2 10 €; importo previsto 35 €, verificare fattura';
     s.v9AccountOverrides[originalId]='Isybank';
   }
  }
  if(month>='2026-12'&&!((m.details?.fixed||[]).some(x=>/internet casa mia/i.test(x.name))||
       (s.manualEntries||[]).some(x=>x.month===month&&/internet casa mia/i.test(x.name)))){
    const row={name:'Internet casa mia',date:month+'-01',amount:30,
      account:'Isybank',type:'PAGAMENTO',status:'DA_PAGARE',category:'Abbonamenti',
      note:'30 €/mese; giorno 1 usato per proteggere i fondi, data reale addebito da aggiornare'};
    m.details.fixed.push(row);
    m.fixed=euro(asCents(m.fixed)+3000);
    impacted.push(month);
  }
 }
 // Force pending household rows to Isy. Preserve paid bank history as recorded.
 for(const x of s.manualEntries||[]){
  if(x.kind!=='fixed'||!v11IsHouseFund(x))continue;
  const id=x.id;
  if(!(s.monthlyChecks||[]).some(c=>c.id===id&&c.status==='done')){
   x.account='Isybank';s.v9AccountOverrides[id]='Isybank';
  }
 }
 s.v11AccountsPolicy={Isybank:'finanziamenti, abbonamenti e fondi fissi entrambe le case',
   Intesa:'mutuo 420 €; affitto 575 € e rimborsi inquilina',
   Revolut:'netto libero',Cash:'denaro fisico'};
 s.v11MigrationAddedInternetMonths=impacted;
 s.policyVersion=11;
 return validate(s);
}

let v11HouseMonth=dayLocal().slice(0,7);
function v11ReserveHouse(id,checked){
 const row=v11FindHouse(id);
 if(!row||v5RowStatus(row).done||row.grocery&&row.month==='2026-11')return;
 const next=v5Clone(S);
 if(!Array.isArray(next.v11HouseSetAside))next.v11HouseSetAside=[];
 const stored=next.v11HouseSetAside.includes(id);
 if(checked&&!stored){
  const bank=prompt('Hai davvero lasciato su Isybank '+money(row.amount)+
    ' da parte per '+row.name+'?\nNon è un pagamento né un bonifico: il saldo bancario resta uguale.',
    'Isybank');
  if(bank===null)return;
  if(bank.trim()!=='Isybank'){notify('I fondi casa devono restare su Isybank.',true);return}
  next.v11HouseSetAside.push(id);
 }else if(!checked&&stored){
  if(!confirm('Liberare la riserva per '+row.name+'?\nLa spesa futura resta comunque da coprire.'))return;
  next.v11HouseSetAside=next.v11HouseSetAside.filter(x=>x!==id);
 }else return;
 next.v11HouseAudit.push({id,action:checked?'reserve':'unreserve',
   at:new Date().toISOString()});
 if(v5Save(next))notify(checked?'Quota contrassegnata come protetta su Isybank.':
   'Protezione rimossa; la scadenza rimane nel piano.');
}
function v11PayHouse(id,checked){
 const row=v11FindHouse(id);
 if(!row||row.grocery)return;
 const existing=v5ManualCheck(id);
 const legacy=v5RowStatus(row);
 if(!checked){
  if(existing){
   if(!confirm('Riaprire '+row.name+' come da pagare?\n'+
     (existing.reconciled?'Il saldo bancario è già stato verificato: non lo modifico.':
      'Se il pagamento aveva aggiornato il conto, ne annullo anche l’addebito stimato.')))return;
   const next=v5Clone(S);
   next.monthlyChecks=next.monthlyChecks.filter(x=>x.id!==id);
   if(v5Save(next))notify('Pagamento riaperto, saldi e fondi ricalcolati.');
   return;
  }
  if(row.confirmed&&!v7Reopened(id)){
   if(!confirm('Riaprire un pagamento storico già verificato senza alterare il saldo confermato?'))return;
   const next=v5Clone(S);
   next.v7ReopenedVerified.push(id);
   if(v5Save(next))notify('Scadenza storica riaperta.');
  }
  return;
 }
 if(legacy.done&&!v7Reopened(id))return;
 if(row.confirmed&&v7Reopened(id)){
  const next=v5Clone(S);
  next.v7ReopenedVerified=next.v7ReopenedVerified.filter(x=>x!==id);
  if(v5Save(next))notify('Voce storica confermata.');
  return;
 }
 const answer=prompt('Quanto hai PAGATO realmente per '+row.name+'?\n'+
   'Importo previsto '+money(row.amount)+' €. Se la bolletta cambia, qui inserisci la cifra reale.',
   String(row.amount).replace('.',','));
 if(answer===null)return;
 const amount=Number(answer.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<0||amount>100000){notify('Importo non valido.',true);return}
 const confirmed=confirm('Questo pagamento di '+money(amount)+' è GIÀ incluso nel saldo Isybank verificato?\n'+
   'OK = già compreso (non lo sottraggo di nuovo).\nAnnulla = non compreso (aggiorno adesso Isybank).');
 if(!confirm('Registrare '+money(amount)+' PAGATI su Isybank per '+row.name+'?'))return;
 const next=v5Clone(S);
 next.monthlyChecks.push({id:row.id,month:row.month,kind:'fixed',manual:!!row.manual,
   status:'done',dueCents:asCents(row.amount),cashCents:asCents(amount),
   charge:!confirmed,reconciled:confirmed,account:'Isybank',
   paidAt:dayLocal(),cashMonth:dayLocal().slice(0,7),
   recordedAt:new Date().toISOString(),source:'v11-household'});
 next.v11HouseAudit.push({id,action:'paid',amountCents:asCents(amount),
   at:new Date().toISOString()});
 if(v5Save(next))notify('Pagamento registrato su Isybank, fondi e proiezioni aggiornati.');
}
function v11AddTenantBill(){
 const month=v11HouseMonth;
 const answer=prompt('Importo REALE della bolletta luce della casa affittata (€).\n'+
   'Aggiungila appena conosci importo e data, senza inventare una stima.','');
 if(answer===null)return;
 const amount=Number(answer.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<=0||amount>10000){notify('Importo bolletta non valido.',true);return}
 const date=prompt('Data effettiva o prevista dell’addebito su Isybank (AAAA-MM-GG).',
   month+'-15');
 if(date===null)return;
 if(!/^20\d\d-\d\d-\d\d$/.test(date)||date.slice(0,7)!==month||
   Number.isNaN(Date.parse(date+'T12:00:00'))){
   notify('Inserisci una data valida del mese selezionato.',true);return;
 }
 if(!confirm('Registrare la bolletta casa affittata '+money(amount)+' su Isybank il '+
   dayTitle(date)+'? Il rimborso dell’inquilina verrà registrato separatamente.'))return;
 const next=v5Clone(S);
 next.manualEntries.push({id:'v11_tenant_bill_'+Date.now(),kind:'fixed',
  month,date,name:'Bolletta luce casa affittata',amount,
  account:'Isybank',type:'HOUSE_FUND',manual:true,
  note:'Importo bolletta ricevuto: il rimborso dell’inquilina è un incasso separato su Intesa'});
 if(v5Save(next))notify('Bolletta aggiunta ai fondi casa: Isybank aggiornato.');
}
function v11AddTenantRefund(){
 const answer=prompt('Quanto ti deve rimborsare l’inquilina per le bollette (€)?\n'+
    'Questa entrata è separata dai 575 € di affitto.','');
 if(answer===null)return;
 const amount=Number(answer.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<=0||amount>10000){
  notify('Importo rimborso non valido.',true);return;
 }
 const date=prompt('Data prevista del rimborso su Intesa (AAAA-MM-GG).',dayLocal());
 if(date===null)return;
 if(!/^20\d\d-\d\d-\d\d$/.test(date)||Number.isNaN(Date.parse(date+'T12:00:00'))||
   !v5LegalMonth(date.slice(0,7))){
  notify('Data non valida o fuori dalla pianificazione.',true);return;
 }
 if(!confirm('Aggiungere rimborso bollette inquilina '+money(amount)+
   ' tra le entrate in attesa su Intesa per '+dayTitle(date)+'?'))return;
 const next=v5Clone(S);
 next.manualEntries.push({id:'v11_tenant_reimburse_'+Date.now(),kind:'income',
  month:date.slice(0,7),date,name:'Rimborso bolletta inquilina',
  amount,account:'Intesa',manual:true,
  note:'Rimborso separato dall’affitto mensile 575 €; spuntare solo quando ricevuto'});
 if(v5Save(next))notify('Rimborso aggiunto a Entrate in attesa, conto Intesa.');
}
function v11HouseMonthMove(delta){
 const d=new Date(v11HouseMonth+'-01T12:00:00');
 d.setMonth(d.getMonth()+delta);
 const m=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
 if(!S.months[m])return;
 v11HouseMonth=m;v5Render();
}
function v11UnassignedCharges(){
 const salary=v9NextIncome('Isybank');
 const until=salary?v11DayBefore(salary.date):v9FallbackDate(35);
 const rows=[];
 for(const mon of Object.keys(S.months)){
  for(const kind of ['fixed','extra']){
   for(const x of v5Catalog(mon,kind)){
    if(v5RowStatus(x).done||x.date>until||(S.policyVersion>=13&&x.date<V13_CASH_START)||V8_BANKS.includes(x.account))continue;
    rows.push(x);
   }
  }
 }
 return rows.sort((a,b)=>a.date.localeCompare(b.date));
}
function v11HouseDisplay(){
 if(!S.months[v11HouseMonth])v11HouseMonth=v5Months()[0];
 $('v11HouseMonth').value=v11HouseMonth;
 const rows=v11HouseRows(v11HouseMonth);
 const pending=rows.filter(x=>!v5RowStatus(x).done);
 const total=pending.reduce((n,x)=>n+asCents(x.amount),0);
 const protectedSum=pending.filter(x=>v11IsFundSetAside(x.id))
   .reduce((n,x)=>n+asCents(x.amount),0);
 $('v11HouseTotal').textContent=v8Money(total);
 $('v11HouseProtected').textContent=v8Money(protectedSum);
 const thailandNote=$('v16JanuaryHouseNote');
 if(thailandNote)thailandNote.hidden=!(S.policyVersion>=16&&v11HouseMonth==='2027-01');
 $('v11HouseList').innerHTML=rows.map(x=>{
  const st=v5RowStatus(x),setAside=v11IsFundSetAside(x.id),food=x.grocery;
  return '<div class="v11-house-item"><div class="v11-house-info"><small>'+
    escapeHTML(dayTitle(S.policyVersion>=13?x.reserveDate:x.date))+
   (food?' · Quota cointestato esterno':' · Da proteggere su Isybank')+
    '</small><strong>'+escapeHTML(x.name)+'</strong>'+
    '<small>'+escapeHTML(x.note||'Fondo fisso previsto: non è un pagamento effettuato.')+'</small></div>'+
    '<b>'+money(x.amount)+'</b><div class="v11-house-actions">'+
    '<label><input type="checkbox" data-v11-reserve="'+escapeHTML(x.id)+'"'+
     (setAside?' checked':'')+(st.done?' disabled':'')+
     '> Accantonato su Isy</label>'+
    (food?'<span class="v11-auto">'+(st.done?'Già trasferito al cointestato':
       'Alimentari: quota prevista dal 18 del mese (non e un bonifico automatico)')+'</span>':
      '<label><input type="checkbox" data-v11-pay="'+escapeHTML(x.id)+'"'+
        (st.done?' checked':'')+'> Pagato</label>')+
    '</div></div>';
 }).join('')|| '<p class="small-hint">'+(S.policyVersion>=13&&v11HouseMonth==='2026-11'?
   'Per novembre non sono richiesti nuovi fondi casa: si parte dal 18 dicembre, dopo gli accrediti.':
   'Nessun fondo casa programmato.')+'</p>';
}



/* V17: calendar, account-aware liquidity and next-income spending gate.
 * Cents everywhere. No automatic bank transfer, no invented income.
 * Integrates with the existing offline ledger and preserves mobile data.
 */
const V17_START='2026-11-19';
let v17CalendarMonth=dayLocal().slice(0,7);
/* V18 is visual+calculation-only; do not mutate any bank balance,
 * paid checkbox, manual transaction, travel earmark, or user amount. */
function v18Upgrade(old){
 if((old.policyVersion||0)>=18)return old;
 const next=v5Clone(old);
 next.policyVersion=18;
 next.v18SignedCycleDisplay=true;
 return validate(next);
}
/* V19 changes only presentation and adds signed cycle breakdown.
 * Existing balances, checked payments, transfers and user budgets are preserved.
 */
function v19Upgrade(old){
 if((old.policyVersion||0)>=19)return old;
 const next=v5Clone(old);
 next.policyVersion=19;
 next.v19CompactDisplay=true;
 return validate(next);
}
/* V20: layout-only migration, all user entries, funds and balances preserved. */
function v20Upgrade(old){
 if((old.policyVersion||0)>=20)return old;
 const next=v5Clone(old);
 next.policyVersion=20;
 return validate(next);
}
/* V21: UI-only change; preserve all pre-existing bank data and allocations. */
function v21Upgrade(old){
 if((old.policyVersion||0)>=21)return old;
 const next=v5Clone(old);
 next.policyVersion=21;
 return validate(next);
}
let v21HeroOpen='';
/* V23: no financial state change, only six-month calendar presentation. */
function v23Upgrade(old){
 if((old.policyVersion||0)>=23)return old;
 const next=v5Clone(old);
 next.policyVersion=23;
 return validate(next);
}
let v23SelectedDate='';
function v17AddDays(iso,count){
 const d=new Date(iso+'T12:00:00');d.setDate(d.getDate()+count);
 return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function v17EndMonth(month){
 const d=new Date(month+'-01T12:00:00');d.setMonth(d.getMonth()+1);d.setDate(0);
 return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function v17Upgrade(old){
 if((old.policyVersion||0)>=17)return old;
 const next=v5Clone(old),changes=[];
 function changeExtra(month,pattern,previous,target){
  const m=next.months[month];if(!m)return;
  const row=(m.details?.variable||[]).find(x=>pattern.test(x.name||''));
  if(!row)return;
  const id=v5Key(month,'extra',row);
  const confirmed=(next.monthlyChecks||[]).some(c=>c.id===id&&c.status==='done')||
    (next.v7ExcludedRows||[]).some(c=>c.id===id);
  // Respect phone customisations; only replace the exact stale V16 default.
  if(confirmed||asCents(row.amount)!==asCents(previous))return;
  row.amount=target;
  row.original_budget=target;
  m.variable=euro(asCents(m.variable)-asCents(previous)+asCents(target));
  changes.push({month,id,from:previous,to:target});
 }
 changeExtra('2026-12',/regali.+natale/i,500,250);
 changeExtra('2026-12',/carta di credito.+saldo|saldo.+carta/i,500,400);
 // Earmark exists inside the Cash balance, not a separate income or debit.
 if(!next.v17TravelReserve)next.v17TravelReserve={
   intendedCents:20000,allocations:{Cash:20000,Isybank:0,Intesa:0,Revolut:0},
   expenseMonth:'2027-01',reason:'Attivita viaggio estero',
   includedInNovemberCash:true
 };
 next.v17Migration={appliedOn:dayLocal(),changes,
   noOverwriteBankBalances:true,retainsManualChecks:true,retainsTransactions:true};
 next.policyVersion=17;
 return validate(next);
}
function v17ActivityRow(){
 return v5Catalog('2027-01','extra').find(x=>
   /viaggio\s+estero/i.test(x.name||'')&&/attivit|spostament/i.test(x.name||''))||null;
}
function v17TravelAllocations(){
 const empty={Isybank:0,Intesa:0,Revolut:0,Cash:0};
 if(S?.firstStart===true)return empty;
 const row=v17ActivityRow();
 if(!row||v5RowStatus(row).done)return empty;
 let allocations={...empty,...(S.v17TravelReserve?.allocations||{Cash:20000})};
 // Savings already assigned to the same activity are not held twice.
 let already=(S.v8ExtraSavings||[]).filter(x=>x.expenseId===row.id)
   .reduce((n,x)=>n+x.amountCents,0);
 for(const bank of ['Cash','Revolut','Isybank','Intesa']){
   const used=Math.min(already,allocations[bank]||0);
   allocations[bank]-=used;already-=used;
 }
 return allocations;
}
function v17HeldByAccount(){
 const existing=v8ReserveDistribution();
 const travel=v17TravelAllocations();
 const result={};
 for(const a of V8_BANKS)result[a]=(existing[a]||0)+(travel[a]||0);
 return result;
}
function v17PendingEvents(endMonth){
 const today=dayLocal();
 const out=[],plans=v8Plans().filter(p=>p.month>=today.slice(0,7)&&p.month<=endMonth);
 const lowDate=day=>day<today?today:day;
 function add(day,kind,x,amount,account,label,id='',metadata={}){
   if(!day)return;
   if(kind==='income'&&day<today)return; // overdue income is NOT cash already received
   const d=lowDate(day);
   if(d>endMonth+'-31'||d>v17EndMonth(endMonth))return;
   const cents=asCents(amount);
   if(!cents)return;
   out.push({day:d,originalDay:day,kind,amount:cents,
     account:V8_BANKS.includes(account)?account:'Isybank',
     label:label||x||'',id, ...metadata});
 }
 for(const p of plans){
   for(const x of p.rows.fixed)
     add(x.date,'fixed',x.name,x.amount,x.account,x.name,x.id);
   for(const x of p.rows.house)
     add(x.reserveDate,'house',x.name,x.amount,'Isybank',x.name,x.id,
       {forecastBudget:true,actualDue:x.date});
   for(const x of p.rows.extra)
     add(x.date,'extra',x.name,x.amount,x.account,x.name,x.id);
   for(const x of p.rows.income)
     add(x.date,'income',x.name,x.amount,x.account,x.name,x.id);
   for(const x of p.taxDue||[])
     add(x.date,'taxBill',x.name,x.amount,'Intesa',x.name,x.id);
   for(const x of v8DueTax(p.month))
     add(x.date||p.month+'-18','taxReserve',x.name,x.amount,'Intesa',x.name,x.id);
   const goals=asCents(p.base?.goals?.casa||0)+asCents(p.base?.goals?.viaggi||0);
   if(goals)add(p.month+'-18','goalsReserve','Obiettivi futuri',euro(goals),'Intesa','Obiettivi futuri');
   for(const plan of S.v8ExtraPlans||[]){
     const row=v8ExtraRow(plan.expenseId);
     if(!row||v5RowStatus(row).done||v7IsExcluded(row.id)||
       p.month<plan.startMonth||p.month>row.month||p.month+'-18'>row.date)continue;
     add(p.month+'-18','extraReserve',row.name,euro(plan.monthlyCents),
       V8_BANKS.includes(row.account)?row.account:'Intesa','Accantonamento '+row.name,row.id,
       {cap:asCents(row.amount)});
   }
 }
 const priority={fixed:0,extra:0,house:0,taxBill:0,
   taxReserve:1,goalsReserve:1,extraReserve:1,income:2};
 return out.sort((a,b)=>a.day.localeCompare(b.day)||
   (priority[a.kind]||0)-(priority[b.kind]||0)||
   a.label.localeCompare(b.label,'it'));
}
function v17DailyPlan(){
 const today=dayLocal();
 const start=today<V17_START?V17_START:today;
 const months=v8Plans().map(x=>x.month).filter(m=>m>=start.slice(0,7)).slice(0,6);
 if(!months.length)return {start,months:[],days:[],events:[],initialHeld:0,initialGross:0};
 const end=v17EndMonth(months.at(-1)),events=v17PendingEvents(months.at(-1));
 const balances=v5AccountBalances();
 const initialGross=V8_BANKS.reduce((n,a)=>n+asCents(balances[a]||0),0);
 const travel=v17TravelAllocations();
 const travelTotal=Object.values(travel).reduce((n,x)=>n+x,0);
 const existingExtra=new Map();
 for(const item of S.v8ExtraSavings||[]){
   const row=v8ExtraRow(item.expenseId);
   if(row&&!v5RowStatus(row).done&&!v7IsExcluded(row.id))
     existingExtra.set(row.id,(existingExtra.get(row.id)||0)+item.amountCents);
 }
 let gross=initialGross,taxHeld=v8TaxActiveCents(),goalsHeld=0,travelHeld=travelTotal;
 const extraSum=()=>[...existingExtra.values()].reduce((n,x)=>n+x,0);
 let cursor=0,day=start,rows=[],accountBalances=Object.fromEntries(
   V8_BANKS.map(k=>[k,asCents(balances[k]||0)]));
 while(day<=end){
   let fixed=0,extra=0,income=0,release=0,addedFunds=0,detail=[];
   while(cursor<events.length&&events[cursor].day===day){
     const e=events[cursor++];detail.push(e);
     const cents=e.amount;
     if(e.kind==='income'){
       gross+=cents;income+=cents;accountBalances[e.account]+=cents;
     }else if(e.kind==='taxReserve'){taxHeld+=cents;addedFunds+=cents}
     else if(e.kind==='goalsReserve'){goalsHeld+=cents;addedFunds+=cents}
     else if(e.kind==='extraReserve'){
       const previous=existingExtra.get(e.id)||0;
       const delta=Math.min(cents,Math.max(0,(e.cap||0)-previous));
       existingExtra.set(e.id,previous+delta);addedFunds+=delta;
     }else{
       gross-=cents;accountBalances[e.account]-=cents;
       if(e.kind==='fixed'||e.kind==='house')fixed+=cents;else extra+=cents;
       if(e.kind==='taxBill'){
         const use=Math.min(taxHeld,cents);taxHeld-=use;release+=use;
       }
       if(e.kind==='extra'){
         const reserved=existingExtra.get(e.id)||0;
         const use=Math.min(reserved,cents);existingExtra.set(e.id,reserved-use);release+=use;
         if(/viaggio\s+estero/i.test(e.label)&&/attivit|spostament/i.test(e.label)){
           const useTravel=Math.min(travelHeld,cents-use);
           travelHeld-=useTravel;release+=useTravel;
         }
       }
     }
   }
   const held=taxHeld+goalsHeld+extraSum()+travelHeld;
   rows.push({day,month:day.slice(0,7),fixed,extra,income,
     gross,held,net:gross-held,
     fundChange:addedFunds-release,detail,
     banks:{...accountBalances}});
   day=v17AddDays(day,1);
 }
 return {start,end,months,days:rows,events,initialGross,
   initialHeld:v8TaxActiveCents()+v8ExtraTotalActive()+travelTotal};
}

/* Cycle until first UNRECEIVED income. Date of income is included for due
 * payments, but the new income itself is NOT counted as available yet. */
function v17CycleSafety(){
 const today=dayLocal(),endMonth=v8Plans().at(-1)?.month||today.slice(0,7);
 const events=v17PendingEvents(endMonth);
 const next=events.find(x=>x.kind==='income'&&x.day>=today);
 const cutoff=next?next.day:v17AddDays(today,35);
 const dueKinds=['fixed','house','extra','taxBill'];
 const snapshot=v5AccountBalances(),initialHeld=v17HeldByAccount();
 const targets=Object.fromEntries(V8_BANKS.map(a=>[a,{
   current:asCents(snapshot[a]||0),required:initialHeld[a]||0,
   protected:initialHeld[a]||0,due:0,extraReserve:0,short:0,excess:0,items:[]}
 ]));
 const gross=V8_BANKS.reduce((n,a)=>n+targets[a].current,0);
 const protectedTotal=V8_BANKS.reduce((n,a)=>n+targets[a].protected,0);
 let grossRunning=gross,heldRunning=protectedTotal,minimum=gross-protectedTotal;
 let worstDay=today,firstDeficit=minimum<0?today:null;
 let travelToRelease=Object.values(v17TravelAllocations()).reduce((n,x)=>n+x,0);
 let extraHeld=new Map();
 for(const item of S.v8ExtraSavings||[]){
   const row=v8ExtraRow(item.expenseId);
   if(row&&!v5RowStatus(row).done&&!v7IsExcluded(row.id))
     extraHeld.set(row.id,(extraHeld.get(row.id)||0)+item.amountCents);
 }
 let actualTax=v8TaxActiveCents(),goalsHeld=0;
 const dueItems=[];
 for(const ev of events){
   if(ev.day>cutoff)break;
   if(ev.kind==='income')continue; // never finance today's freedom with unpaid salary
   const account=targets[ev.account]||targets.Isybank;
   if(dueKinds.includes(ev.kind)){
     account.required+=ev.amount;account.due+=ev.amount;
     account.items.push(ev);dueItems.push(ev);grossRunning-=ev.amount;
     if(ev.kind==='taxBill'){
       const used=Math.min(actualTax,ev.amount);
       actualTax-=used;heldRunning-=used;
     }
     if(ev.kind==='extra'){
       const previously=extraHeld.get(ev.id)||0;
       const used=Math.min(previously,ev.amount);
       extraHeld.set(ev.id,previously-used);
       heldRunning-=used;
       if(/viaggio\s+estero/i.test(ev.label)&&/attivit|spostament/i.test(ev.label)){
         const released=Math.min(travelToRelease,ev.amount-used);
         travelToRelease-=released;heldRunning-=released;
       }
     }
   }else if(['taxReserve','goalsReserve','extraReserve'].includes(ev.kind)){
     let amount=ev.amount;
     if(ev.kind==='extraReserve'){
       const old=extraHeld.get(ev.id)||0;
       amount=Math.min(amount,Math.max(0,(ev.cap||0)-old));
       extraHeld.set(ev.id,old+amount);
     }
     if(ev.kind==='taxReserve')actualTax+=amount;
     if(ev.kind==='goalsReserve')goalsHeld+=amount;
     account.required+=amount;account.extraReserve+=amount;
     heldRunning+=amount;account.items.push(ev);
   }
   const free=grossRunning-heldRunning;
   if(free<minimum){minimum=free;worstDay=ev.day}
   if(free<0&&!firstDeficit)firstDeficit=ev.day;
 }
 for(const a of V8_BANKS){
   const row=targets[a];
   row.short=Math.max(0,row.required-row.current);
   row.excess=Math.max(0,row.current-row.required);
 }
 // Allocate only funds EXCESS to each donor's own obligations.
 const remaining=Object.fromEntries(V8_BANKS.map(a=>[a,targets[a].excess]));
 const shortages=Object.fromEntries(V8_BANKS.map(a=>[a,targets[a].short]));
 const actions=[];
 for(const dest of ['Isybank','Intesa','Revolut']){
   for(const src of ['Cash','Intesa','Isybank','Revolut']){
     if(src===dest||shortages[dest]<=0||remaining[src]<=0)continue;
     const amount=Math.min(remaining[src],shortages[dest]);
     if(amount<=0)continue;
     actions.push({from:src,to:dest,cents:amount,
       reason:'Fondi necessari prima del prossimo incasso'});
     remaining[src]-=amount;shortages[dest]-=amount;
   }
 }
 const unresolved=Object.values(shortages).reduce((sum,x)=>sum+x,0);
 const initialShort=targets.Isybank.short+targets.Intesa.short+targets.Revolut.short;
 const grossFree=Math.max(0,minimum);
 // No "safe to spend" badge while an automatic bank debit would be uncovered.
 const spendableToday=minimum>0&&initialShort===0?Math.max(0,minimum):0;
 // Reconciliation: initial assets - outgoing bills - remaining earmarks
 // equals the signed net before the next income. No future salary is advanced.
 const cycleExpenses=dueItems.reduce((sum,e)=>sum+e.amount,0);
 const cycleFundsEnd=heldRunning;
 return {today,next,cutoff,daysWithoutIncome:!next,accounts:targets,
   initialGross:gross,initialProtected:protectedTotal,minimum,
   cycleExpenses,cycleFundsEnd,
   worstDay,firstDeficit,initialShort,unresolved,actions,
   grossFree,spendableToday,dueItems};
}

function v21CycleFundBreakdown(cycle){
 const travel=v17TravelAllocations();
 let travelHeld=Object.values(travel).reduce((n,x)=>n+x,0);
 let taxHeld=v8TaxActiveCents(),goalsHeld=0;
 const extra=new Map();
 for(const item of S.v8ExtraSavings||[]){
   const row=v8ExtraRow(item.expenseId);
   if(row&&!v5RowStatus(row).done&&!v7IsExcluded(row.id))
     extra.set(item.expenseId,(extra.get(item.expenseId)||0)+item.amountCents);
 }
 const events=v17PendingEvents(v8Plans().at(-1)?.month||dayLocal().slice(0,7));
 for(const ev of events){
   if(ev.day>cycle.cutoff)break;
   if(ev.kind==='income')continue;
   if(ev.kind==='taxReserve')taxHeld+=ev.amount;
   else if(ev.kind==='goalsReserve')goalsHeld+=ev.amount;
   else if(ev.kind==='extraReserve'){
     const previously=extra.get(ev.id)||0;
     extra.set(ev.id,previously+Math.min(ev.amount,Math.max(0,(ev.cap||0)-previously)));
   }else if(ev.kind==='taxBill'){
     taxHeld-=Math.min(taxHeld,ev.amount);
   }else if(ev.kind==='extra'){
     const previously=extra.get(ev.id)||0;
     const used=Math.min(previously,ev.amount);
     extra.set(ev.id,previously-used);
     if(/viaggio\s+estero/i.test(ev.label)&&/attivit|spostament/i.test(ev.label)){
       travelHeld-=Math.min(travelHeld,ev.amount-used);
     }
   }
 }
 const items=[];
 if(travelHeld){
   // Cash and other accounts can each hold a portion of the same trip fund.
   // Show its real destination, without assuming it is additional income.
   const total=Object.values(travel).reduce((n,x)=>n+x,0);
   if(travelHeld===total){
     for(const [account,cents] of Object.entries(travel)){
       if(cents>0)items.push({label:'viaggio estero · attività e spostamenti',
         note:'Accantonati su '+(account==='Cash'?'contanti':account),
         cents});
     }
   }else items.push({label:'viaggio estero · attività e spostamenti',
     note:'Riserva ancora vincolata',cents:travelHeld});
 }
 if(taxHeld>0)items.push({label:'Fondo imposte',
   note:'Tasse e F24',cents:taxHeld});
 for(const [id,cents] of extra){
   if(cents<=0)continue;
   const row=v8ExtraRow(id);
   items.push({label:row?.name||'Fondo per spesa extra',
     note:'Spesa programmata',cents});
 }
 if(goalsHeld>0)items.push({label:'Obiettivi di risparmio',
   note:'Casa e viaggi',cents:goalsHeld});
 const amount=items.reduce((n,x)=>n+x.cents,0);
 // Expose any reconciliation issue explicitly, never invent destinations.
 if(amount!==cycle.cycleFundsEnd)
   items.push({label:'Fondi da riconciliare',
    note:'Destinazione non determinata',cents:cycle.cycleFundsEnd-amount});
 return items.filter(x=>x.cents!==0);
}
function v21RenderHeroBreakdown(cycle){
 const container=$('v21HeroDetail');
 if(!container)return;
 for(const type of ['expenses','funds']){
   const button=document.querySelector('[data-v21-panel="'+type+'"]');
   if(button)button.setAttribute('aria-expanded',String(v21HeroOpen===type));
 }
 container.hidden=!v21HeroOpen;
 if(!v21HeroOpen){container.innerHTML='';return}
 let rows,total,title;
 if(v21HeroOpen==='expenses'){
   rows=cycle.dueItems.map(x=>({
     label:x.label,note:dayTitle(x.originalDay||x.day)+' · '+x.account,
     cents:x.amount}));
   total=cycle.cycleExpenses;
   title='Spese fino alla prossima entrata';
 }else{
   rows=v21CycleFundBreakdown(cycle);
   total=cycle.cycleFundsEnd;
   title='Destinazione dei fondi';
 }
 container.innerHTML='<h3>'+escapeHTML(title)+'</h3>'+
   (rows.map(x=>'<div class="v21-breakdown-row"><div><strong>'+
     escapeHTML(x.label)+'</strong><small>'+escapeHTML(x.note||'')+
     '</small></div><b>'+v8Money(x.cents)+'</b></div>').join('')||
     '<p class="v21-no-items">Nessuna voce ancora prevista.</p>')+
   '<div class="v21-breakdown-total"><strong>Totale</strong><b>'+
      v8Money(total)+'</b></div>';
}

function v17MoveHtml(a){
 const label='Sposta '+v8Money(a.cents)+' da '+a.from+' a '+a.to;
 return '<div class="v17-move"><div><strong>'+escapeHTML(label)+'</strong>'+
   '<small>Effettua prima il trasferimento reale, poi registralo qui. '+
   'Nessun movimento bancario automatico.</small></div>'+
   '<button type="button" data-v9-from="'+escapeHTML(a.from)+'" '+
   'data-v9-to="'+escapeHTML(a.to)+'" data-v9-cents="'+a.cents+
   '">Ho spostato questi soldi</button></div>';
}
function v17RenderHome(){
 const d=v17CycleSafety();
 // Only three numbers in this hero; no explanatory paragraphs.
 $('v17NextHeadline').textContent=v8Money(d.minimum);
 $('v19CycleExpenses').textContent=v8Money(d.cycleExpenses);
 $('v19CycleFunds').textContent=v8Money(d.cycleFundsEnd);
 v21RenderHeroBreakdown(d);
 $('v17NextHeadline').classList.toggle('v18-negative',d.minimum<0);
 $('v17NextHeadline').classList.toggle('v18-positive',d.minimum>0);
 const held=v17TravelAllocations();
 const travel=Object.values(held).reduce((n,x)=>n+x,0);
 const alerts=[];
 if(d.initialShort)alerts.push('<p class="v17-alert-line">'+
   'Prima di spendere, proteggi le rate sui conti indicati. '+
   (d.unresolved>0?'Resta da coprire anche '+v8Money(d.unresolved)+'.':
   'Le risorse complessive basterebbero con i trasferimenti proposti.')+'</p>');
 if(d.minimum<0)alerts.push('<p class="v17-alert-line">'+
   'Scopertura aggregata al '+escapeHTML(dayTitle(d.worstDay))+': '+
   v8Money(-d.minimum)+'. Servono meno spese o nuove risorse.</p>');
 const transferItems=d.actions.length?d.actions.map(v17MoveHtml).join(''):
   '<p class="v17-covered">Non occorrono spostamenti per le scadenze '+
    'prima del prossimo incasso, secondo i dati registrati.</p>';
 let optional='';
 if(d.initialShort===0&&d.spendableToday>0){
   const donor=['Intesa','Isybank','Cash'].find(a=>
     a!=='Revolut'&&d.accounts[a]?.excess>0);
   if(donor){
     const amount=Math.min(d.spendableToday,d.accounts[donor].excess);
     optional='<div class="v17-move"><div><strong>Facoltativo: fino a '+
       v8Money(amount)+' per sfizi su Revolut</strong>'+
       '<small>Non è una spesa obbligatoria: puoi lasciarli sul conto e accumulare capitale. '+
       'Solo dopo gli addebiti coperti puoi eventualmente spostarli.</small></div>'+
       '<button type="button" data-v9-from="'+escapeHTML(donor)+
       '" data-v9-to="Revolut" data-v9-cents="'+amount+
       '">Ho spostato su Revolut</button></div>';
   }
 }
 $('v9MoveSuggestions').innerHTML=alerts.join('')+transferItems+optional+
   '<p class="small-hint">Proposte calcolate fino al prossimo incasso, non per '+
   'l’intero semestre. Ogni bonifico o deposito va effettuato personalmente.</p>';
 const detail=V8_BANKS.map(a=>{
   const x=d.accounts[a];
   const name=a==='Cash'?'Contanti':a;
   const warn=x.short>0?'v17-bank-short':'';
   return '<div class="v17-bank '+warn+'"><strong>'+escapeHTML(name)+'</strong>'+
     '<div>Disponibile <b>'+v8Money(x.current)+'</b></div>'+
     '<div>Da proteggere <b>'+v8Money(x.required)+'</b></div>'+
     '<div>'+ (x.short>0?'Mancano ':'Eccedenza ')+'<b>'+
       v8Money(x.short||x.excess)+'</b></div>'+
     '<button type="button" data-bank-v5="'+escapeHTML(a)+'">Verifica saldo reale</button></div>';
 }).join('');
 $('walletAccounts').innerHTML=detail;
 $('v17ReserveTransfer').innerHTML=travel>0&&held.Cash>0?
   '<button class="secondary" type="button" data-v17-thai-move>'+
   'Ho depositato Cash riservato alla viaggio estero su Revolut</button>':
   '';
}

/* V23 six-month diary. Each cell uses existing v17DailyPlan cents. Already
   booked transactions are displayed separately and NEVER deducted twice. */
function v23PostedForDate(iso){
 const rows=[];
 for(const x of S.transactions||[]){
   if(x.date!==iso)continue;
   rows.push({label:x.subtype||x.note||x.category||'Spesa registrata',
    amount:asCents(x.amount),account:x.account||'',
    type:'expense',note:x.includedInBaseline?'Già compresa nel saldo iniziale':
      'Già registrata nel patrimonio'});
 }
 for(const c of S.monthlyChecks||[]){
   if(c.status!=='done'||!c.charge||c.paidAt!==iso)continue;
   const source=v7FindRow(c.id);
   rows.push({label:source?.name||(c.kind==='income'?'Entrata registrata':'Pagamento registrato'),
      amount:c.cashCents||0,account:c.account||'',
      type:c.kind==='income'?'income':c.kind==='fixed'?'fixed':'expense',
      note:'Già contabilizzato nel saldo'});
 }
 return rows;
}
function v23CompactEuro(cents){
 return Math.round(cents/100).toLocaleString('it-IT',{maximumFractionDigits:0});
}
function v23RenderSixMonthCalendar(){
 const plan=v17DailyPlan(),months=plan.months;
 const container=$('v17CalendarGrid');if(!container)return;
 if(!months.length){
   container.innerHTML='<p class="small-hint">Non ci sono ancora mesi di previsione da mostrare.</p>';
   $('v17DateDetails').innerHTML='';return;
 }
 const today=dayLocal();
 const cycles=S.policyVersion>=24?v24CycleAllDays(plan):new Map();
 const indexed=new Map(plan.days.map(x=>[x.day,x]));
 if(!indexed.has(v23SelectedDate))
   v23SelectedDate=indexed.has(today)?today:plan.days[0]?.day||'';
 const weekdays=['L','M','M','G','V','S','D'];
 const html=months.map(month=>{
   const start=new Date(month+'-01T12:00:00');
   const offset=(start.getDay()+6)%7;
   const count=Number(v17EndMonth(month).slice(8));
   const arr=plan.days.filter(x=>x.month===month);
   const end=arr.at(-1);
   const min=arr.reduce((best,x)=>!best||
     (S.policyVersion>=24?(cycles.get(x.day)?.net??x.net)<(cycles.get(best.day)?.net??best.net):x.net<best.net)?x:best,null);
   let cells=Array.from({length:offset},()=>'<span class="v23-calendar-empty" aria-hidden="true"></span>');
   for(let day=1;day<=count;day++){
     const iso=month+'-'+String(day).padStart(2,'0');
     const item=indexed.get(iso);
     if(!item){
       cells.push('<span class="v23-past-day" title="Nessun netto storico disponibile">'+
         '<b>'+day+'</b><small>—</small></span>');
       continue;
     }
     const posted=v23PostedForDate(iso);
     const hasPostedExpense=posted.some(x=>x.type==='expense');
     const hasPostedFixed=posted.some(x=>x.type==='fixed');
     const hasPostedIncome=posted.some(x=>x.type==='income');
     const markers=[
       item.income>0||hasPostedIncome?'in':'',
       item.fixed>0||hasPostedFixed?'out':'',
       item.extra>0||hasPostedExpense?'extra':'',
       item.fundChange!==0?'fund':''
     ].filter(Boolean);
     const markerHtml=markers.map(k=>'<i class="v23-dot v23-dot-'+k+'"></i>').join('');
     const displayNet=S.policyVersion>=24?(cycles.get(iso)?.net??item.net):item.net;
     const flags=[
       displayNet<0?'v23-negative':'v23-positive',
       item.day===today?'v23-today':'',
       item.day===v23SelectedDate?'v23-selected':''
     ].filter(Boolean).join(' ');
     cells.push('<button type="button" class="v23-date '+flags+'" data-v17-date="'+iso+
       '" aria-pressed="'+(iso===v23SelectedDate?'true':'false')+
       '" aria-label="'+escapeHTML(dayTitle(iso))+'; netto fino alla prossima entrata '+escapeHTML(v8Money(displayNet))+'">'+
       '<span class="v23-day-number">'+day+'</span>'+
       '<span class="v23-day-amount">'+v23CompactEuro(displayNet)+'</span>'+
       '<span class="v23-cell-markers">'+markerHtml+'</span></button>');
   }
   while(cells.length%7)cells.push('<span class="v23-calendar-empty" aria-hidden="true"></span>');
   const monthEndCycle=S.policyVersion>=24?(cycles.get(end?.day)?.net??end?.net):end?.net;
   const monthMinCycle=S.policyVersion>=24?(cycles.get(min?.day)?.net??min?.net):min?.net;
   const caption=end?('<div class="v23-month-totals">'+
     '<span>Fino a prossima entrata · fine mese <b>'+v8Money(monthEndCycle)+'</b></span>'+
     '<span>Minimo ciclo <b class="'+(monthMinCycle<0?'v23-low':'')+'">'+v8Money(monthMinCycle)+
     '</b><small>'+min.day.slice(8)+'/'+min.day.slice(5,7)+'</small></span>'+
     '</div>'):'<p class="small-hint">Nessun dato disponibile.</p>';
   return '<article class="v23-calendar-month" data-calendar-month="'+month+'">'+
     '<h2>'+escapeHTML(monthTitle(month))+'</h2>'+
     '<div class="v23-weekhead">'+weekdays.map(w=>'<span>'+w+'</span>').join('')+'</div>'+
     '<div class="v23-calendar-dates">'+cells.join('')+'</div>'+
     caption+'</article>';
 }).join('');
 container.innerHTML=html;
 const first=months[0],last=months.at(-1);
 $('v23CalendarPeriod').textContent=
   'Vista continua: '+monthTitle(first)+' – '+monthTitle(last)+
   '. I valori si ricalcolano dopo ogni spesa, incasso, rata o fondo registrato.';
 v23RenderDateDetail(v23SelectedDate,plan);
}
function v23RenderDateDetail(day,existingPlan){
 const plan=existingPlan||v17DailyPlan();
 const data=plan.days.find(x=>x.day===day);
 const el=$('v17DateDetails');
 if(!el||!data){if(el)el.innerHTML='';return}
 const cycle=S.policyVersion>=24?v24CycleNetForDay(day,plan):{net:data.net,next:null};
 v23SelectedDate=day;
 document.querySelectorAll('#v17CalendarGrid [data-v17-date]').forEach(node=>{
   const selected=node.dataset.v17Date===day;
   node.classList.toggle('v23-selected',selected);
   node.setAttribute('aria-pressed',String(selected));
 });
 const blocks=[
   ['Spese fisse previste',data.fixed,'out'],
   ['Spese extra previste',data.extra,'extra'],
   ['Entrate previste',data.income,'in'],
   ['Fondi vincolati',data.held,'fund'],
   ['Patrimonio totale',data.gross,'gross'],
   ['Netto a fine giornata',data.net,'net'],
   ['Fino alla prossima entrata',cycle.net,'cycle']
 ];
 const summary='<div class="v23-detail-summary">'+blocks.map(([label,cents,kind])=>
   '<div class="v23-detail-metric v23-detail-'+kind+'"><span>'+
     label+'</span><b>'+v8Money(cents)+'</b></div>').join('')+'</div>';
 const pending=data.detail.map(x=>{
   const isIncome=x.kind==='income';
   const isReserve=['taxReserve','goalsReserve','extraReserve'].includes(x.kind);
   const kind=x.kind==='house'?'Fondo casa (previsione, non pagamento certo)':
     x.kind==='fixed'?'Spesa fissa da sostenere':
     x.kind==='extra'?'Spesa extra da sostenere':
     x.kind==='taxBill'?'Imposta prevista':
     isReserve?'Accantonamento previsto':
     isIncome?'Entrata prevista (non ancora ricevuta)':x.kind;
   return '<div class="v23-item"><div><strong>'+escapeHTML(x.label)+
     '</strong><small>'+escapeHTML(kind)+' · '+escapeHTML(x.account||'Conto da verificare')+
     '</small></div><b class="'+(isIncome?'v23-item-in':'v23-item-out')+'">'+
     (isIncome?'+':x.kind==='extra'||x.kind==='fixed'||x.kind==='house'||x.kind==='taxBill'?'−':'')+
     v8Money(x.amount)+'</b></div>';
 }).join('');
 const posted=v23PostedForDate(day);
 const postedHtml=posted.length?'<h4>Movimenti già registrati (non sottratti due volte)</h4>'+
    posted.map(x=>'<div class="v23-item"><div><strong>'+escapeHTML(x.label)+'</strong>'+
     '<small>'+escapeHTML(x.note)+' · '+escapeHTML(x.account)+'</small></div>'+
     '<b class="'+(x.type==='income'?'v23-item-in':'v23-item-out')+'">'+
       (x.type==='income'?'+':'−')+v8Money(x.amount)+'</b></div>').join(''):'';
 el.innerHTML='<h3>'+escapeHTML(dayTitle(day))+
   ' <strong class="'+(cycle.net<0?'v23-day-net-negative':'')+'">'+
   v8Money(cycle.net)+'</strong></h3>'+
   '<p class="v24-cycle-next">Netto fino alla prossima entrata'+
   (cycle.next?' · '+escapeHTML(dayTitle(cycle.next)):' · nessuna entrata successiva nel piano')+
   '</p>'+
   summary+
   '<h4>Scadenze e movimenti previsti</h4>'+
   (pending||'<p class="v23-no-due">Nessuna operazione prevista per questo giorno.</p>')+
   postedHtml+
   '<p class="small-hint">Netto fino alla prossima entrata = disponibilità residua dopo aver protetto le scadenze conosciute prima del prossimo incasso, che non viene anticipato. I movimenti già registrati non vengono sottratti due volte. Il netto a fine giornata è un valore diverso.</p>';
}

function v17RenderCalendar(){
 if(S.policyVersion>=23)return v23RenderSixMonthCalendar();
 const data=v17DailyPlan(),sel=$('v17CalendarMonth');
 if(!sel)return;
 if(!data.months.includes(v17CalendarMonth))v17CalendarMonth=data.months[0];
 sel.innerHTML=data.months.map(m=>'<option value="'+m+'"'+
   (m===v17CalendarMonth?' selected':'')+'>'+escapeHTML(monthTitle(m))+'</option>').join('');
 const arr=data.days.filter(x=>x.month===v17CalendarMonth);
 const heads=arr.map(x=>'<th data-v17-date="'+x.day+'">'+
   escapeHTML(x.day.slice(8))+'</th>').join('');
 const groups=[
   {name:'Spese fisse',key:'fixed',negative:true},
   {name:'Spese extra',key:'extra',negative:true},
   {name:'Entrate',key:'income'},
   {name:'Fondi vincolati',key:'held'},
   {name:'Netto rimanente',key:'net',emphasis:true},
   {name:'Patrimonio totale',key:'gross'}
 ];
 const fmt=x=>x===0?'–':v8Money(x);
 const body=groups.map(g=>'<tr'+(g.emphasis?' class="v17-net-row"':'')+'>'+
   '<th>'+escapeHTML(g.name)+'</th>'+
   arr.map(x=>'<td'+(g.key==='net'&&x.net<0?' class="v17-negative"':'')+
     ' data-v17-date="'+x.day+'">'+
     fmt(x[g.key])+'</td>').join('')+'</tr>').join('');
 $('v17CalendarGrid').innerHTML='<div class="v17-scroll"><table class="v17-day-table">'+
   '<thead><tr><th>Voce / giorno</th>'+heads+'</tr></thead><tbody>'+
   body+'</tbody></table></div>';
 const current=arr.at(-1);
 $('v17CalendarFoot').textContent=
   'Ultimo giorno del mese: patrimonio '+v8Money(current?.gross||0)+
   ', fondi '+v8Money(current?.held||0)+
   ', netto residuo '+v8Money(current?.net||0)+'. '+
   'Tocca un giorno per vedere le singole operazioni.';
 const first=arr.find(x=>x.day===dayLocal())||arr[0];
 v17RenderDateDetail(first?.day);
}
function v17RenderDateDetail(day){
 if(S.policyVersion>=23)return v23RenderDateDetail(day);
 if(!day)return;
 const entry=v17DailyPlan().days.find(x=>x.day===day);
 if(!entry)return;
 $('v17DateDetails').innerHTML='<h3>'+escapeHTML(dayTitle(day))+
   ' · netto '+v8Money(entry.net)+'</h3>'+
   (entry.detail.length?entry.detail.map(x=>
     '<div class="v17-detail"><span>'+escapeHTML(x.label)+
     '<small>'+escapeHTML(x.kind==='house'?'Fondo casa (data di budget, non pagamento certificato)':
       x.kind==='income'?'Entrata prevista e non ancora confermata':x.kind)+
     '</small></span><b>'+v8Money(x.amount)+'</b></div>').join(''):
     '<p class="small-hint">Nessun movimento programmato per questo giorno.</p>')+
   '<p class="small-hint">Netto = patrimonio di tutti i conti meno i fondi vincolati. '+
   'Non anticipa le spese dei giorni successivi.</p>';
}

/* At the start of a projected month, calculate the signed balance
 * remaining before the FIRST still-unreceived income of that month's cycle.
 * Use the end of the previous projected day as the starting equity.
 * Do not count the next income itself, even if fixed bills share its date.
 */
function v19CycleForMonth(month,projection){
 const plan=projection||v17DailyPlan();
 if(!plan.months.includes(month))return null;
 const today=dayLocal(),current=today.slice(0,7);
 if(month===current){
   const safe=v17CycleSafety();
   return {month,net:safe.minimum,cutoff:safe.cutoff};
 }
 const start=month+'-01';
 const previous=plan.days.filter(d=>d.day<start).at(-1);
 const initial=previous?previous.net:plan.initialGross-plan.initialHeld;
 const next=plan.events.find(e=>e.kind==='income'&&e.day>=start);
 const cutoff=next?next.day:v17EndMonth(month);
 let minimum=initial;
 for(const d of plan.days){
   if(d.day<start)continue;
   if(d.day>cutoff)break;
   // Daily plan already includes that day's income: exclude ALL income
   // on the first-income date to avoid spending salary prematurely.
   const beforeIncome=d.net-(next&&d.day===next.day?d.income:0);
   minimum=Math.min(minimum,beforeIncome);
 }
 return {month,net:minimum,cutoff};
}

function v17MonthMetrics(){
 const plan=v17DailyPlan();
 return plan.months.map(month=>{
   const days=plan.days.filter(x=>x.month===month);
   const last=days.at(-1);
   const forward=plan.days.filter(x=>x.day>last.day);
   const minimum=Math.min(last.net,...forward.map(x=>x.net));
   return {month,netFree:Math.max(0,minimum),protectedSum:last.held,
     ending:last.gross,atEnd:last.net};
 });
}

function v17RenderSixMonths(){
 const el=$('v15MonthOverview'),plan=v17DailyPlan();
 if(!el)return;
 const rows=plan.months.map(month=>{
   const days=plan.days.filter(x=>x.month===month),last=days.at(-1);
   const min=days.reduce((a,b)=>b.net<a.net?b:a,days[0]);
   const next=plan.days.filter(x=>x.day>last.day);
   const forward=Math.min(last.net,...next.map(x=>x.net));
   return {month,last,min,netFree:Math.max(0,forward)};
 });
 el.innerHTML='<div class="v15-lead"><b>Proiezioni aggiornate — sei mesi</b>'+
   '<span>Patrimonio, fondi e minimo del netto giornaliero. '+
   'Le entrate non ancora incassate sono solamente previste; il netto libero cumulativo '+
   'protegge le scadenze fino alla fine dei sei mesi visualizzati.</span></div>'+
   '<table class="v15-month-table"><thead><tr>'+
   '<th>Mese</th><th>Patrimonio</th><th>Fondi</th><th>Netto fine</th><th>Netto libero futuro</th><th>Minimo</th>'+
   '</tr></thead><tbody>'+
   rows.map(x=>'<tr><th>'+escapeHTML(monthTitle(x.month))+'</th>'+
     '<td>'+v8Money(x.last.gross)+'</td><td>'+v8Money(x.last.held)+'</td>'+
     '<td>'+v8Money(x.last.net)+'</td><td>'+v8Money(x.netFree)+'</td>'+
     '<td class="'+(x.min.net<0?'v17-negative':'')+'">'+v8Money(x.min.net)+
       '<small>'+escapeHTML(dayTitle(x.min.day))+'</small></td></tr>').join('')+
   '</tbody></table>'+
   '<p class="v15-foot">Il netto di fine mese non è la somma spendibile oggi. '+
   'Usa il valore principale fino al prossimo incasso e segui gli spostamenti tra conti.</p>';
}
function v17RecordThailandTransfer(){
 const travel=v17TravelAllocations();
 const max=travel.Cash||0;
 if(max<=0){notify('Nessun Cash riservato disponibile da trasferire.',true);return}
 const banks=v5AccountBalances();
 if(asCents(banks.Cash)<max){
   notify('Contanti reali inferiori al vincolo: verifica Cash prima del trasferimento.',true);
   return;
 }
 const value=prompt('Quanto hai GIA versato da Cash a Revolut per il fondo viaggio estero (€)?',
   String(euro(max)));
 if(value===null)return;
 const cents=asCents(Number(value.trim().replace(',','.')));
 if(!(cents>0&&cents<=max)){notify('Importo non valido o superiore al fondo.',true);return}
 if(!confirm('Confermi di aver GIA trasferito '+v8Money(cents)+
   ' da Cash a Revolut? La stessa somma resta vincolata al viaggio; non è una nuova entrata.'))return;
 const next=v5Clone(S);
 if(!Array.isArray(next.v9Transfers))next.v9Transfers=[];
 next.v9Transfers.push({id:'v17_thai_'+Date.now(),from:'Cash',to:'Revolut',
   amountCents:cents,date:dayLocal(),recordedAt:new Date().toISOString(),
   fromReconciled:false,toReconciled:false,cancelled:false});
 next.v17TravelReserve.allocations.Cash-=cents;
 next.v17TravelReserve.allocations.Revolut=(next.v17TravelReserve.allocations.Revolut||0)+cents;
 if(v5Save(next))notify('Deposito registrato e fondo viaggio estero mantenuto su Revolut.');
}
function v17RenderAll(){
 v17RenderHome();v17RenderCalendar();v17RenderSixMonths();
}



/* V22: three explicit accounting states. A historical payment is already
 * in the declared bank snapshot: it closes the obligation without changing
 * assets. A payment recorded now changes that account exactly once.
 */
function v22Upgrade(old){
 if((old.policyVersion||0)>=22)return old;
 const next=v5Clone(old);
 next.policyVersion=22;
 return validate(next);
}
function v22CurrentStatus(row){
 const state=v5RowStatus(row),check=state.record;
 if(check?.v22DeclaredStatus)return check.v22DeclaredStatus;
 if(check)return check.charge?'paid':'past';
 return state.done?'past':'pending';
}
function v22RowHtml(row){
 const status=v22CurrentStatus(row);
 const isIncome=row.kind==='income';
 const labels=isIncome?
   [['pending','Da ricevere'],['paid','Incassato'],['past','Già incassato nel saldo']]:
   [['pending','Da pagare'],['paid','Pagato'],['past','Già pagato nel saldo']];
 const title=status==='paid'?(isIncome?'Incassato':'Pagato'):
   status==='past'?(isIncome?'Già incassato nel saldo':'Già pagato in precedenza'):
   (isIncome?'Da ricevere':'Da pagare');
 const account=(v5ManualCheck(row.id)?.account||row.account||'Isybank');
 const desc=row.note?'<small>'+escapeHTML(row.note)+'</small>':'';
 const statusDrop='<label class="v22-status-label">'+
   '<span>Stato</span><select data-v22-status="'+escapeHTML(row.id)+'" aria-label="Stato: '+
    escapeHTML(row.name)+'">'+labels.map(([value,name])=>
    '<option value="'+value+'"'+(value===status?' selected':'')+'>'+name+'</option>').join('')+
   '</select></label>';
 const action=isIncome?'<button type="button" class="v22-edit" data-v22-edit-income="'+
    escapeHTML(row.id)+'">Modifica importo</button>':
    (row.v30FoodFixed||S.firstStart&&row.kind==='fixed'||S.firstStart&&row.kind==='extra')?
      '<button type="button" class="v22-edit" data-v32-edit-row="'+
      escapeHTML(row.id)+'">Modifica importo</button>':'';
 return '<div class="v5-obligation v22-ledger-item'+(status!=='pending'?' done':'')+'">'+
   '<div class="v22-row-main"><div class="v22-description">'+
   '<small>'+escapeHTML(dayTitle(row.date))+' · '+escapeHTML(title)+' · '+
     escapeHTML(account)+'</small><strong>'+escapeHTML(row.name)+'</strong>'+desc+
   '</div><span class="v5-row-amount">'+money(row.amount)+'</span></div>'+
   '<div class="v22-actions">'+statusDrop+action+
   '<button type="button" class="v22-delete" data-v22-delete="'+escapeHTML(row.id)+
    '" aria-label="Elimina '+escapeHTML(row.name)+' dal piano">Elimina</button></div></div>';
}
function v22SetStatus(id,status){
 const row=v7FindRow(id);
 if(!row||!['pending','paid','past'].includes(status)){notify('Voce non trovata.',true);v5Render();return}
 if(row.grocery){notify('Gli alimentari si gestiscono nei fondi casa.',true);v5Render();return}
 const previous=v22CurrentStatus(row);
 if(status===previous){return}
 const existing=v5ManualCheck(id);
 const next=v5Clone(S);
 const reopened=next.v7ReopenedVerified||[];
 const oldAccount=existing?.account||row.account||'Isybank';
 const amount=asCents(row.amount);
 if(status==='pending'){
   const explanation=existing?.charge&&!existing?.reconciled?
      'Annullerò la registrazione del pagamento/incasso effettuato da questa app.':
      'Riaprirò la voce senza modificare il saldo bancario già confermato.';
   if(!confirm((row.kind==='income'?'Riportare tra le entrate da ricevere':'Riportare tra le spese da pagare')+
     ' «'+row.name+'»?\n'+explanation)){v5Render();return}
   next.monthlyChecks=(next.monthlyChecks||[]).filter(x=>x.id!==id);
   if(row.confirmed&&!reopened.includes(id))reopened.push(id);
   next.v7ReopenedVerified=reopened;
   if(v5Save(next))notify('Stato aggiornato: da '+(row.kind==='income'?'ricevere.':'pagare.'));
   return;
 }
 if(status==='past'){
   if(!confirm((row.kind==='income'?'Segnare come già incassata':'Segnare come già pagata')+
     ' «'+row.name+'»?\nUsa questo stato SOLTANTO se '+money(row.amount)+
     ' è già compreso nel saldo dei tuoi conti.\n'+
     'Non aggiungo né sottraggo denaro.')){v5Render();return}
   if(existing){
     // A posted payment must not be silently reversed when changing
     // classification. Preserve its effective original cash movement.
     const check=next.monthlyChecks.find(x=>x.id===id&&x.status==='done');
     check.v22DeclaredStatus='past';
   }else if(row.confirmed&&!v7Reopened(id)){
     // The imported historical record already closed the row.
   }else{
     next.monthlyChecks.push({id,month:row.month,kind:row.kind,
       manual:!!row.manual,status:'done',
       dueCents:amount,cashCents:0,charge:false,reconciled:true,
       account:oldAccount,v22DeclaredStatus:'past',
       paidAt:dayLocal(),recordedAt:new Date().toISOString()});
   }
   if(v5Save(next))notify('Già '+(row.kind==='income'?'incassato':'pagato')+
       ': saldo bancario invariato.');
   return;
 }
 // "Paid now": always create a new money event after explicit confirmation.
 const answer=prompt('Conto '+(row.kind==='income'?'su cui è entrato':'da cui è uscito')+
    ' '+money(row.amount)+' per «'+row.name+'»:\n'+
    (S.firstStart?V8_BANKS.map(v32AccountLabel).join(' / '):
      'Isybank / Intesa / Revolut / Cash'),
    S.firstStart?v32AccountLabel(oldAccount):oldAccount);
 if(answer===null){v5Render();return}
 const account=S.firstStart?v32ResolveAccount(answer):answer.trim();
 if(!V8_BANKS.includes(account)){notify('Conto non valido.',true);v5Render();return}
 if(!confirm('Confermi «'+row.name+'»: '+(row.kind==='income'?'incassati ':'pagati ')+
   money(row.amount)+' su '+account+'?\n'+
   (row.kind==='income'?'AUMENTO':'DIMINUISCO')+' il saldo stimato del conto. '+
   'Se il movimento è già incluso nel saldo reale, scegli invece «Già '+
   (row.kind==='income'?'incassato':'pagato')+' nel saldo».')){v5Render();return}
 next.monthlyChecks=(next.monthlyChecks||[]).filter(x=>x.id!==id);
 if(row.confirmed&&!reopened.includes(id))reopened.push(id);
 next.v7ReopenedVerified=reopened;
 next.monthlyChecks.push({id,month:row.month,kind:row.kind,manual:!!row.manual,
   status:'done',dueCents:amount,cashCents:amount,
   charge:true,reconciled:false,account,
   v22DeclaredStatus:'paid',
   paidAt:dayLocal(),recordedAt:new Date().toISOString()});
 if(v5Save(next))notify(row.kind==='income'?'Entrata ricevuta, saldo aggiornato.':
   'Pagamento registrato, saldo aggiornato.');
}
function v22DeleteRow(id){
 const row=v7FindRow(id);
 if(!row){notify('Voce non trovata.',true);return}
 const check=v5ManualCheck(id);
 const already=!!check?.charge;
 const explanation=already?
   '\nIl pagamento/incasso già registrato resta nel saldo: elimino solo la voce dal piano.':
   '\nLa voce sparirà dalle previsioni senza registrare nuovi movimenti bancari.';
 if(!confirm('Eliminare «'+row.name+'» da '+monthTitle(row.month)+'?'+
    explanation+'\nPotrai ripristinarla nella lista delle voci eliminate.'))return;
 const next=v5Clone(S);
 if(!Array.isArray(next.v7ExcludedRows))next.v7ExcludedRows=[];
 if(next.v7ExcludedRows.some(x=>x.id===id))return;
 next.v7ExcludedRows.push({id,name:row.name,kind:row.kind,month:row.month,
   amount:row.amount,date:row.date,manual:!!row.manual,
   sourceConfirmed:!!row.confirmed,excludedAt:new Date().toISOString(),
   v22Deleted:true,wasPaid:!!check});
 // Crucial: DO NOT remove paid monthlyChecks; that would "refund"
 // a real expense or erase an actual incoming payment.
 if(v5Save(next))notify('Voce eliminata dal piano. Ripristinabile.');
}
function v22EditIncome(id){
 const row=v7FindRow(id);
 if(!row||row.kind!=='income'){notify('Entrata non trovata.',true);return}
 const reply=prompt('Importo PREVISTO o EFFETTIVO per '+row.name+
   ' ('+monthTitle(row.month)+') in euro.\nModifico solo questo mese.',
   String(row.amount).replace('.',','));
 if(reply===null)return;
 const amount=Number(reply.trim().replace(',','.'));
 if(!Number.isFinite(amount)||amount<=0||amount>100000){
   notify('Importo non valido. Inserisci una cifra maggiore di zero.',true);return;
 }
 const previous=asCents(row.amount),current=asCents(amount);
 if(previous===current)return;
 const check=v5ManualCheck(id);
 const actual=check?.charge&&!check?.reconciled;
 const previousEffectiveCash=check?.cashCents??previous;
 const bankDelta=current-previousEffectiveCash;
 const note=actual?
   'L’incasso era già registrato nell’app: correggerò anche il saldo stimato '+
    'del conto '+check.account+' di '+money(euro(bankDelta))+'.':
   'Il saldo del conto NON verrà modificato: la cifra cambia soltanto nella previsione'+
    (check?' o nella registrazione già inclusa nel saldo.':'.');
 if(!confirm('Cambiare '+row.name+' da '+money(row.amount)+' a '+money(euro(current))+
   '?\n'+note))return;
 const next=v5Clone(S);
 if(row.manual){
   const target=next.manualEntries.find(x=>x.id===id&&x.kind==='income');
   if(!target){notify('Non trovo l’entrata manuale.',true);return}
   target.amount=euro(current);
 }else{
   const group=next.months[row.month];
   const entries=[...(group.details?.income||[]),...(group.completed?.income||[])];
   const target=entries.find(x=>v5Key(row.month,'income',x)===id);
   if(!target){notify('Non trovo l’entrata programmata.',true);return}
   target.amount=euro(current);
   group.income=euro(Math.max(0,asCents(group.income||0)+current-previous));
 }
 if(check){
   const saved=next.monthlyChecks.find(x=>x.id===id&&x.status==='done');
   if(saved){
     saved.dueCents=current;
     if(actual)saved.cashCents=current;
   }
 }
 if(v5Save(next))notify('Importo entrata aggiornato, conto e proiezioni ricalcolati.');
}


/* V24 – financial calendar: signed net protected until next unreceived income
 * as-of end-of-day, with income at cutoff excluded from spendable funds.
 * Only today uses the existing cycle engine as the accounting authority. */
function v24Upgrade(old){
 if((old.policyVersion||0)>=24)return old;
 const next=v5Clone(old);
 next.policyVersion=24;
 if(!Array.isArray(next.v24Loans))next.v24Loans=[];
 return validate(next);
}
function v24CycleNetForDay(day,projection){
 const plan=projection||v17DailyPlan();
 const index=plan.days.findIndex(x=>x.day===day);
 if(index<0)return null;
 if(day===dayLocal()){
   const now=v17CycleSafety();
   return {day,net:now.minimum,next:now.next?.day||null,cutoff:now.cutoff};
 }
 // A historical (or projected future) closing balance includes any income
 // on this day; only income strictly AFTER this date is still pending.
 const next=plan.events.find(e=>e.kind==='income'&&e.day>day)?.day||null;
 const cutoff=next||plan.end;
 let lowest=plan.days[index].net;
 for(let i=index+1;i<plan.days.length;i++){
   const row=plan.days[i];
   if(row.day>cutoff)break;
   const beforeIncome=next&&row.day===next?row.net-row.income:row.net;
   lowest=Math.min(lowest,beforeIncome);
 }
 return {day,net:lowest,next,cutoff};
}
function v24CycleAllDays(plan){
 const result=new Map();
 for(const row of plan.days)result.set(row.day,v24CycleNetForDay(row.day,plan));
 return result;
}

/* V24 loan register: strictly debt METADATA, never a new transaction.
 * Linking an existing fixed expense makes its confirmed monthly status
 * increment paid installments, but does not make a duplicate payment. */
let v24EditingId='';
function v24LoanNameKey(value){
 return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
   .toLowerCase().replace(/\([^)]*\)/g,'').replace(/[^a-z0-9]/g,'');
}
function v24MonthShift(iso,months){
 const [y,m,d]=iso.split('-').map(Number);
 const first=new Date(Date.UTC(y,m-1+months,1));
 const targetYear=first.getUTCFullYear(),targetMonth=first.getUTCMonth();
 const last=new Date(Date.UTC(targetYear,targetMonth+1,0)).getUTCDate();
 return String(targetYear).padStart(4,'0')+'-'+String(targetMonth+1).padStart(2,'0')+
   '-'+String(Math.min(d,last)).padStart(2,'0');
}
function v24Loans(){
 return Array.isArray(S.v24Loans)?S.v24Loans:[];
}
function v24LoanCandidates(){
 const current=dayLocal().slice(0,7);
 const months=Object.keys(S.months).sort().filter(m=>m>=current).slice(0,7);
 const all=new Map();
 for(const month of months){
   for(const row of v5Catalog(month,'fixed')){
     if(!/mutuo|agos|cofidis|klarna|alma|katana|prestito|finanziament|rateal|rata\b|scalapay/i.test(row.name))continue;
     const key=v24LoanNameKey(row.name);
     if(!key)continue;
     const old=all.get(key);
     const due=row.date>=dayLocal()&&(!old?.due||row.date<old.due)?
       row.date:old?.due||'';
     all.set(key,{name:row.name,monthlyCents:asCents(row.amount),
       due:due||old?.due||'',key});
   }
 }
 return [...all.values()].sort((a,b)=>a.name.localeCompare(b.name,'it'));
}
function v24LoanMetrics(loan){
 const total=Math.max(1,Number(loan.installmentsTotal)||0);
 const before=Math.max(0,Math.min(total,Number(loan.paidBefore)||0));
 const expected=Math.max(0,total-before);
 const lastDue=expected?v24MonthShift(loan.firstDueDate,expected-1):null;
 let linkedPaid=0;
 if(loan.linkedName&&expected>0){
   const linkedKey=v24LoanNameKey(loan.linkedName);
   for(let i=0;i<expected;i++){
     const due=v24MonthShift(loan.firstDueDate,i),month=due.slice(0,7);
     if(!S.months[month])continue;
     const rows=v5Catalog(month,'fixed').filter(x=>
       v24LoanNameKey(x.name)===linkedKey&&v5RowStatus(x).done);
     if(rows.length>0)linkedPaid++;
   }
 }
 const paid=Math.min(total,before+linkedPaid);
 const remaining=total-paid;
 const monthly=Number(loan.monthlyCents)||0;
 const totalCents=Number.isInteger(loan.totalDueCents)&&loan.totalDueCents>0?
   loan.totalDueCents:total*monthly;
 const basePaid=Number.isInteger(loan.paidTotalCents)&&loan.paidTotalCents>=0?
   loan.paidTotalCents:monthly*before;
 const paidAmount=basePaid+linkedPaid*monthly;
 const residual=paid===total?0:Math.max(0,totalCents-paidAmount);
 // Sum of remaining installments, NOT capital payoff amount.
 return {paid,before,linkedPaid,remaining,totalCents,residual,paidAmount,
   due:lastDue,progress:total>0?Math.round(paid/total*100):0,
   inferred:!(Number.isInteger(loan.totalDueCents)&&loan.totalDueCents>0)};
}
function v24SetLoanForm(values){
 $('v24LoanId').value=values?.id||'';
 $('v24LoanName').value=values?.name||'';
 $('v24LoanKind').value=values?.kind||'Prestito';
 $('v24LoanMonthly').value=values?.monthlyCents?euro(values.monthlyCents):'';
 $('v24LoanCount').value=values?.installmentsTotal??'';
 $('v24LoanPaid').value=values?.paidBefore??'';
 $('v26LoanPaidAmount').value=Number.isInteger(values?.paidTotalCents)?
   euro(values.paidTotalCents):'';
 $('v24LoanNextDate').value=values?.firstDueDate||'';
 $('v24LoanTotal').value=values?.totalDueCents?euro(values.totalDueCents):'';
 $('v24LoanNote').value=values?.note||'';
 $('v27PrincipalOriginal').value=Number.isInteger(values?.principalOriginalCents)?
   euro(values.principalOriginalCents):'';
 $('v27PrincipalRemaining').value=Number.isInteger(values?.principalRemainingCents)?
   euro(values.principalRemainingCents):'';
 $('v24LoanLink').value=values?.linkedName||'';
 $('v24LoanFormTitle').textContent=values?.id?'Modifica finanziamento':'Aggiungi mutuo o finanziamento';
 $('v24LoanSubmit').textContent=values?.id?'Salva modifiche':'Salva finanziamento';
 $('v24LoanCancel').hidden=!values?.id;
}
function v24ResetLoanForm(){
 v24EditingId='';
 $('v24LoanForm').reset();
 v24SetLoanForm(null);
}
function v24OpenLoanEdit(id){
 const loan=v24Loans().find(x=>x.id===id);
 if(!loan)return;
 v24EditingId=id;
 v24RenderLoans();
 v24SetLoanForm(loan);
 $('v24LoanForm')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function v24PresetLoan(key){
 const candidate=v24LoanCandidates().find(x=>x.key===key);
 if(!candidate)return;
 v24ResetLoanForm();
 const kind=/mutuo/i.test(candidate.name)?'Mutuo':
   /katana|klarna|alma/i.test(candidate.name)?'Acquisto rateale':'Prestito';
 v24SetLoanForm({name:candidate.name,kind,monthlyCents:candidate.monthlyCents,
   firstDueDate:candidate.due||v24MonthShift(dayLocal(),1),linkedName:candidate.name});
 $('v24LoanForm')?.scrollIntoView({behavior:'smooth',block:'start'});
}
function v24SaveLoan(event){
 if(event?.preventDefault)event.preventDefault();
 const name=$('v24LoanName').value.trim(),kind=$('v24LoanKind').value;
 const monthly=asCents(Number($('v24LoanMonthly').value));
 const total=Number($('v24LoanCount').value);
 const paid=Number($('v24LoanPaid').value);
 const paidRaw=$('v26LoanPaidAmount').value.trim();
 const paidCents=paidRaw?asCents(Number(paidRaw)):null;
 const firstDue=$('v24LoanNextDate').value;
 const rawTotal=$('v24LoanTotal').value.trim();
 const explicit=rawTotal?asCents(Number(rawTotal)):0;
 const pOriginalRaw=$('v27PrincipalOriginal').value.trim();
 const pRemainingRaw=$('v27PrincipalRemaining').value.trim();
 const pOriginal=pOriginalRaw?asCents(Number(pOriginalRaw)):null;
 const pRemaining=pRemainingRaw?asCents(Number(pRemainingRaw)):null;
 const linkedName=$('v24LoanLink').value;
 const note=$('v24LoanNote').value.trim();
 if(!name||name.length>85||!['Mutuo','Prestito','Acquisto rateale','Altro'].includes(kind)||
   monthly<=0||monthly>10000000||!Number.isInteger(total)||total<1||total>1200||
   !Number.isInteger(paid)||paid<0||paid>total||
   (paidCents!==null&&(!Number.isInteger(paidCents)||paidCents<0))||
   (pOriginal!==null&&(!Number.isInteger(pOriginal)||pOriginal<0))||
   (pRemaining!==null&&(!Number.isInteger(pRemaining)||pRemaining<0))||
   (pOriginal!==null&&pRemaining!==null&&pRemaining>pOriginal)||
   !/^\d{4}-\d{2}-\d{2}$/.test(firstDue)||
   Number.isNaN(new Date(firstDue+'T12:00:00').getTime())||
   (explicit&&explicit<0)||
   (linkedName&&!v24LoanCandidates().some(x=>x.name===linkedName)&&
     !v24Loans().some(x=>x.linkedName===linkedName))){
   notify('Controlla importi, date, rate già pagate e collegamento.',true);return;
 }
 if(rawTotal&&explicit<=0){notify('Il totale da restituire deve essere positivo.',true);return}
 if(linkedName&&v24Loans().some(x=>x.id!==v24EditingId&&
   v24LoanNameKey(x.linkedName)===v24LoanNameKey(linkedName))){
   notify('Questa rata è già collegata a un altro finanziamento: modifica la scheda esistente.',true);
   return;
 }
 const totalFromInstallments=monthly*total;
 if(explicit&&Math.abs(explicit-totalFromInstallments)>monthly&&
   !confirm('Il totale indicato ('+v8Money(explicit)+') differisce dalla somma di '+
     total+' rate da '+v8Money(monthly)+' ('+v8Money(totalFromInstallments)+').\n'+
     'Verifica di aver inserito il TOTALE DA RESTITUIRE (interessi inclusi), non il solo capitale. Continuare?'))return;
 if(paid===total&&firstDue>dayLocal()){
  // A finished loan can have an old next-due date but should not imply
  // a forthcoming payment.
 }
 if(linkedName){
   const ref=v24LoanCandidates().find(x=>x.name===linkedName);
   if(ref&&ref.monthlyCents!==monthly&&!confirm(
     'La rata inserita ('+v8Money(monthly)+
     ') è diversa da quella nelle Spese fisse ('+v8Money(ref.monthlyCents)+
     '). Continuare? L’app NON modificherà gli addebiti esistenti.'))return;
 }
 if(!linkedName&&!confirm(
   'Questo finanziamento NON è collegato alle Spese fisse.\n'+
   'Il registro del debito si aggiornerà manualmente e le nuove rate NON saranno aggiunte al calendario.\n'+
   'Se il pagamento è già nelle Spese fisse, selezionalo nel campo di collegamento.\nContinuare?'))return;
 const previous=v24Loans().find(x=>x.id===v24EditingId);
 const priorPaid=previous?.paidBefore||0;
 const effectivePaid=paidCents!==null?
   (previous&&paidCents===previous.paidTotalCents&&paid!==priorPaid?
     paidCents+(paid-priorPaid)*monthly:paidCents):
   (previous&&Number.isInteger(previous.paidTotalCents)?
     previous.paidTotalCents+(paid-priorPaid)*monthly:paid*monthly);
 const now=new Date().toISOString();
 const entry={id:v24EditingId||('v24loan_'+Date.now()+'_'+Math.random().toString(36).slice(2,8)),
   name,kind,monthlyCents:monthly,installmentsTotal:total,
   paidBefore:paid,paidTotalCents:effectivePaid,firstDueDate:firstDue,
   totalDueCents:explicit||null,linkedName,note,updatedAt:now,
   principalOriginalCents:pOriginal,principalRemainingCents:pRemaining};
 const next=v5Clone(S);
 if(!Array.isArray(next.v24Loans))next.v24Loans=[];
 const index=next.v24Loans.findIndex(x=>x.id===entry.id);
 if(index>=0)next.v24Loans[index]={...next.v24Loans[index],...entry};
 else next.v24Loans.push(entry);
 v24EditingId='';
 if(v5Save(next)){
   v24ResetLoanForm();v24RenderLoans();
   notify('Finanziamento registrato. Nessun nuovo addebito duplicato.');
 }
}
function v24DeleteLoan(id){
 const loan=v24Loans().find(x=>x.id===id);
 if(!loan)return;
 if(!confirm('Eliminare la scheda «'+loan.name+'»?\n'+
   'Le rate già presenti nelle Spese fisse e il saldo bancario RESTANO invariati.'))return;
 const next=v5Clone(S);
 next.v24Loans=next.v24Loans.filter(x=>x.id!==id);
 if(v24EditingId===id)v24EditingId='';
 if(v5Save(next)){v24ResetLoanForm();notify('Scheda del debito eliminata. Rate e bilanci invariati.')}
}
function v24RenderLoans(){
 const summary=$('v24LoanSummary'),cards=$('v24LoanCards'),suggestions=$('v24LoanSuggestions');
 if(!summary||!cards||!suggestions)return;
 const loans=v24Loans(),metrics=loans.map(x=>({loan:x,calc:v24LoanMetrics(x)}));
 const remaining=metrics.reduce((n,x)=>n+x.calc.residual,0);
 const counts=metrics.reduce((n,x)=>n+x.calc.remaining,0);
 summary.innerHTML='<div class="v24-debt-summary"><span>Somma delle rate future · stima, con interessi (mutuo incluso)</span>'+
   '<strong class="v24-debt-amount">'+(loans.length||S.firstStart?v8Money(remaining):'Da configurare')+'</strong>'+
   '<div class="v24-debt-sub"><span>'+loans.length+' finanziamenti registrati</span>'+
   '<span>'+counts+' rate residue complessive</span></div></div>'+
   '<p class="small-hint">È la somma dei pagamenti futuri, NON il capitale bancario residuo. Per il mutuo il capitale stimato è indicato separatamente. Non sottrarre questa somma dal patrimonio: le rate già previste sono conteggiate nel piano.</p>';
 const candidates=v24LoanCandidates();
 suggestions.innerHTML=candidates.length?
   candidates.map(x=>'<button class="v24-preset" type="button" data-v24-preset="'+
     escapeHTML(x.key)+'"><span>'+escapeHTML(x.name)+'</span><b>'+
     v8Money(x.monthlyCents)+'/mese</b></button>').join(''):
   '<p class="small-hint">Nessuna rata riconoscibile nelle spese fisse. Puoi inserire una scheda manuale.</p>';
 const chosen=v24EditingId?loans.find(x=>x.id===v24EditingId):null;
 const additional=chosen?.linkedName&&!candidates.some(x=>x.name===chosen.linkedName)?
  [{name:chosen.linkedName}]:[];
 const options=[...additional,...candidates];
 $('v24LoanLink').innerHTML='<option value="">Nessun collegamento: aggiornamento manuale</option>'+
   options.map(x=>'<option value="'+escapeHTML(x.name)+'">'+
      escapeHTML(x.name)+'</option>').join('');
 if(chosen){
   $('v24LoanLink').value=chosen.linkedName||'';
   $('v24LoanFormTitle').textContent='Modifica finanziamento';
   $('v24LoanSubmit').textContent='Salva modifiche';
   $('v24LoanCancel').hidden=false;
 }
 cards.innerHTML=metrics.length?metrics.map(({loan:x,calc:m})=>
   '<article class="v24-debt-card"><div class="v24-debt-title">'+
   '<div><small>'+escapeHTML(x.principalRemainingCents!==null&&
     Number.isInteger(x.principalRemainingCents)?
     'Mutuo · Capitale residuo stimato al '+(x.principalAsOf?
       dayTitle(x.principalAsOf):'ultimo documento'):x.kind)+'</small>'+
     '<h3>'+escapeHTML(x.name)+'</h3></div>'+
   '<strong>'+v8Money(Number.isInteger(x.principalRemainingCents)?
     x.principalRemainingCents:m.residual)+'</strong></div>'+
   '<div class="v24-debt-progress"><span style="width:'+m.progress+'%"></span></div>'+
   (x.sourceConfidence?'<p class="v26-source-label '+(x.sourceConfidence==='verified'?
     'v26-source-confirmed':'v26-source-check')+'">'+
     (x.sourceConfidence==='verified'?'Importi pagati documentati da Gmail':
       'Alcuni dati dei pagamenti devono essere verificati')+
     ' · '+escapeHTML(x.sourceAsOf||'')+'</p>':'')+
   '<div class="v24-loan-values">'+
     '<div><span>Rata mensile</span><b>'+v8Money(x.monthlyCents)+'</b></div>'+
     '<div><span>'+(x.id==='v27_mutuo_intesa_screenshot'?
       'Rate già versate (stima)':'Già versato')+'</span><b>'+v8Money(m.paidAmount)+'</b></div>'+
     (Number.isInteger(x.principalRemainingCents)?
       '<div class="v27-principal-value"><span>Capitale residuo · stima al '+
       escapeHTML(x.principalAsOf?dayTitle(x.principalAsOf):'ultimo documento')+
       '</span><b>'+v8Money(x.principalRemainingCents)+'</b></div>'+
       (Number.isInteger(x.principalOriginalCents)?
         '<div><span>Capitale iniziale</span><b>'+
         v8Money(x.principalOriginalCents)+'</b></div>'+
         '<div><span>Capitale rimborsato (stima, alla data fonte)</span><b>'+
         v8Money(Math.max(0,x.principalOriginalCents-x.principalRemainingCents))+
         '</b></div>':'')+
       '<div><span>Rate future (interessi inclusi, stima)</span><b>'+
       v8Money(m.residual)+'</b></div>'+
       '<div><span>Prima rata residua prevista</span><b>'+
       escapeHTML(dayTitle(x.firstDueDate))+'</b></div>':'')+
     '<div><span>Rate pagate</span><b>'+m.paid+' di '+x.installmentsTotal+'</b></div>'+
     '<div><span>Rate residue</span><b>'+m.remaining+'</b></div>'+
     '<div><span>Fine prevista</span><b>'+escapeHTML(m.due?dayTitle(m.due):'Terminato')+'</b></div>'+
     '<div><span>Totale da restituire'+(m.inferred?' (stimato)':'')+'</span><b>'+v8Money(m.totalCents)+'</b></div>'+
     '<div><span>Collegamento</span><b>'+escapeHTML(x.linkedName||'Solo manuale')+'</b></div>'+
   '</div>'+
   (x.note?'<p class="v24-loan-note">'+escapeHTML(x.note)+'</p>':'')+
   (m.linkedPaid?'<p class="v24-loan-note">'+m.linkedPaid+
    ' rate aggiuntive riconosciute automaticamente nelle Spese fisse.</p>':'')+
   (!x.linkedName?'<p class="v24-loan-alert">Non collegato: inserisci anche la rata nelle Spese fisse per farla comparire nelle previsioni.</p>':'')+
   '<div class="v24-loan-actions"><button type="button" data-v24-edit="'+escapeHTML(x.id)+
     '">Modifica</button><button type="button" data-v24-delete="'+escapeHTML(x.id)+
     '">Elimina scheda</button></div></article>').join(''):
   '<p class="small-hint">Nessun finanziamento ancora registrato. Scegli una rata riconosciuta sopra, oppure compila il modulo.</p>';
}


/* V25 — itemization directly from each monthly projection's existing entries.
 * Only presentation changes: account and reserve calculations remain untouched. */
function v25Upgrade(old){
 if((old.policyVersion||0)>=25)return old;
 const next=v5Clone(old);
 next.policyVersion=25;
 return validate(next);
}
function v25RowItems(rows){
 return (rows||[]).map(r=>({
   label:r.name||'Voce non denominata',
   cents:asCents(r.amount),
   date:r.reserveDate||r.date||'',
   account:r.account||'',
   note:r.reserveDate&&r.reserveDate!==r.date?
     'Data di accantonamento prevista; scadenza '+dayTitle(r.date):''
 }));
}
function v25ExtraFundSnapshot(until){
 const reserved=new Map();
 for(const event of S.v8ExtraSavings||[]){
   const row=v8ExtraRow(event.expenseId);
   if(row&&!v5RowStatus(row).done&&!v7IsExcluded(row.id))
     reserved.set(row.id,(reserved.get(row.id)||0)+event.amountCents);
 }
 const months=Object.keys(S.months).sort().filter(x=>x>=S.baseline.snapshotMonth);
 let contributions=[];
 for(const month of months){
   contributions=[];
   for(const plan of S.v8ExtraPlans||[]){
     const row=v8ExtraRow(plan.expenseId);
     if(!row||v5RowStatus(row).done||v7IsExcluded(row.id)||
       month<plan.startMonth||month>row.month)continue;
     const amount=Math.min(Math.max(0,asCents(row.amount)-(reserved.get(row.id)||0)),
       plan.monthlyCents);
     if(amount>0){
       reserved.set(row.id,(reserved.get(row.id)||0)+amount);
       contributions.push({label:row.name,cents:amount,account:row.account||'',
         note:'Quota mensile programmata, non bonifico'});
     }
   }
   const monthRows=v5Catalog(month,'extra').filter(x=>
     !v5RowStatus(x).done&&v13IsForecastCurrent(x));
   for(const row of monthRows)reserved.delete(row.id);
   if(month===until)break;
 }
 return {contributions,reserved:[...reserved].filter(([id,amount])=>amount>0)
   .map(([id,cents])=>({label:v8ExtraRow(id)?.name||'Spesa extra',
     cents,note:'Fondo extra previsto non ancora consumato'}))};
}
function v25BreakdownLine(label,cents,items,foot='',mode='sum'){
 const active=(items||[]).filter(x=>x.cents!==0);
 const sum=active.reduce((n,x)=>n+(Number(x.cents)||0),0);
 if(mode==='sum'&&sum!==cents){
   active.push({label:'Raccordo alle previsioni',cents:cents-sum,
     note:'Differenza tra dettagli disponibili e totale calcolato; non è un pagamento aggiuntivo'});
 }
 const rendered=active.length?active.map(x=>
   '<div class="v25-breakdown-item"><div><strong>'+
      escapeHTML(String(x.label||'Voce'))+'</strong>'+
      '<small>'+escapeHTML([x.date?dayTitle(x.date):'',x.account||'',x.note||'']
        .filter(Boolean).join(' · '))+'</small></div>'+
      '<b>'+v8Money(x.cents)+'</b></div>').join(''):
   '<p class="v25-empty">Nessun movimento o importo programmato per questa voce.</p>';
 const total='<div class="v25-breakdown-total"><span>Totale voce</span><b>'+
    v8Money(cents)+'</b></div>';
 return '<details class="v25-projection-detail" data-v25-projection="'+
   escapeHTML(label)+'"><summary><span>'+escapeHTML(label)+
   '</span><b>'+v8Money(cents)+'</b></summary>'+
   '<div class="v25-breakdown-body">'+rendered+
   (foot?'<p class="v25-breakdown-note">'+escapeHTML(foot)+'</p>':'')+
   total+'</div></details>';
}
function v25MonthCards(){
 const data=v8Plans().filter(x=>x.month>=visibleMonth()).slice(0,6);
 const cashRows=v17MonthMetrics(),plan=v17DailyPlan();
 $('v5MonthCards').innerHTML=data.map(m=>{
   const cash=cashRows.find(x=>x.month===m.month);
   const fundState=v25ExtraFundSnapshot(m.month);
   const taxFunds=v25RowItems(v8DueTax(m.month));
   const currentMonth=m.month===dayLocal().slice(0,7);
   const initial=currentMonth?
     V8_BANKS.map(account=>({label:account==='Cash'?'Contanti':account,
       cents:asCents(v5AccountBalances()[account]||0),
       note:'Saldo corrente registrato nell’app'})):
     [{label:'Patrimonio previsto a fine mese precedente',cents:m.opening,
       note:'Valore complessivo riportato. Non è un nuovo incasso'}];
   // Six concise expandable groups. Actual outflows and earmarks are
   // deliberately separated: savings/reserves do not debit bank balances.
   const plannedGoalItems=[
     {label:'Obiettivo casa futura',cents:asCents(m.base.goals?.casa||0)},
     {label:'Obiettivo viaggi',cents:asCents(m.base.goals?.viaggi||0)}
   ];
   const reserveItems=[
     ...v25RowItems(m.rows.house).map(x=>({...x,note:'Uscita casa prevista, sottratta dal patrimonio'})),
     ...taxFunds.map(x=>({...x,note:'Accantonamento tasse: denaro ancora nel patrimonio'})),
     ...fundState.contributions.map(x=>({...x,note:'Accantonamento extra: non è una nuova uscita'})),
     ...plannedGoalItems.map(x=>({...x,note:'Risparmio destinato a obiettivo, resta nel patrimonio'}))
   ];
   const monthlySavings=m.grossEnd-m.opening;
   const overview=[
     {label:'Patrimonio iniziale',cents:m.opening,items:initial,
       note:'Saldi iniziali del mese o patrimonio ereditato dal mese precedente.'},
     {label:'Entrate in attesa',cents:m.income,items:v25RowItems(m.rows.income),
       note:'Le entrate non ancora incassate sono soltanto previste.'},
     {label:'Spese fisse',cents:m.fixed,items:v25RowItems(m.rows.fixed),
       note:'Comprende rate, abbonamenti, mutuo e alimentari del 19.'},
     {label:'Spese extra',cents:m.variable+m.taxBills,
       items:[...v25RowItems(m.rows.extra),
         ...v25RowItems(m.taxDue).map(x=>({...x,note:'F24 da verificare'}))],
       note:'Uscite una tantum, viaggio e F24, alla rispettiva scadenza.'},
     {label:'Accantonamenti per le uscite',
       cents:m.homeFunds+m.plannedTax+m.plannedExtra+m.plannedSavings,
       items:reserveItems,
       note:'Le spese delle case escono dal patrimonio. I fondi per tasse, extra e obiettivi invece lo vincolano, senza addebitarlo due volte.'},
     {label:'Risparmi',cents:monthlySavings,
       items:[
         {label:'Entrate previste nel mese',cents:m.income},
         {label:'Spese fisse',cents:-m.fixed},
         {label:'Spese extra e F24',cents:-(m.variable+m.taxBills)},
         {label:'Uscite case',cents:-m.homeFunds}
       ],
       note:'Variazione del patrimonio nel mese, positiva o negativa. Non è il netto spendibile di oggi: quello rimane in alto.'}
   ];
   const cycle=v19CycleForMonth(m.month,plan);
   return '<article class="month-card v25-month-card" data-month="'+escapeHTML(m.month)+'">'+
     '<div class="month-header"><div><small>PREVISIONE</small><h3>'+
       escapeHTML(monthTitle(m.month))+'</h3></div>'+
       '<div class="month-net v19-month-net">'+
       '<div class="v19-cycle-value"><small>Netto fino alla prossima entrata</small>'+
       '<strong class="v19-cycle-amount">'+v8Money(cycle?.net||0)+'</strong></div>'+
       '<div class="v19-month-end"><small>Netto libero a fine mese</small><strong>'+
       v8Money(cash?.atEnd||0)+'</strong></div></div></div>'+
       '<div class="month-lines v25-month-lines">'+
         overview.map(x=>v25BreakdownLine(x.label,x.cents,x.items,x.note,x.mode)).join('')+
         (m.month==='2027-01'?'<p class="small-hint">Alimentari del 19 gennaio: quota fissa separata dai 1.000 € viaggio estero. Modificala nelle Spese fisse se necessario.</p>':'')+
       '</div></article>';
 }).join('')||'<div class="panel">Nessuna proiezione disponibile.</div>';
}

/* V26: reviewed contract metadata imported once on upgrade.
 * This is NOT live Gmail sync and creates NO bank transaction or bill.
 * Source PDFs and sensitive IDs are intentionally not embedded. */
const V26_EMAIL_CONTRACTS=[];
function v26Upgrade(old){
 if(old.firstStart){const n=v5Clone(old);n.policyVersion=26;return validate(n)}
 if((Number(old.policyVersion)||0)>=26)return old;
 const next=v5Clone(old);
 if(!Array.isArray(next.v24Loans))next.v24Loans=[];
 const seen=new Set(next.v24Loans.map(x=>v24LoanNameKey(x.linkedName||x.name)));
 for(const source of V26_EMAIL_CONTRACTS){
   const key=v24LoanNameKey(source.linkedName||source.name);
   if(seen.has(key))continue;
   next.v24Loans.push({...source,updatedAt:'2026-11-20T20:10:00+01:00'});
   seen.add(key);
 }
 next.policyVersion=26;
 return validate(next);
}

/* V27 · Mutuo Intesa: supplied SCREENSHOT of a previously calculated
 * ESTIMATE as of 20 Nov 2026; not an authoritative Intesa amortization.
 * Distinguish capital residual from future installments with interest.
 * Never add another bill: this is metadata linked to 'Mutuo' in fixed.
 */
const V27_MUTUO_ESTIMATE={};
function v27Upgrade(old){
 if(old.firstStart){const n=v5Clone(old);n.policyVersion=27;return validate(n)}
 if((Number(old.policyVersion)||0)>=27)return old;
 const next=v5Clone(old);
 if(!Array.isArray(next.v24Loans))next.v24Loans=[];
 const savedMortgage=next.v24Loans.find(x=>x.kind==='Mutuo'||/\bmutuo\b/i.test(x.name||'')||
   v24LoanNameKey(x.linkedName)==='mutuo');
 if(!savedMortgage){
   next.v24Loans.push({...V27_MUTUO_ESTIMATE,updatedAt:'2026-11-20T20:24:00+01:00'});
 }
 // A user-edited mortgage contract is authoritative over this screenshot.
 // Never change its due amounts behind their back if its monthly figure differs.
 const mayCorrectFixed=!savedMortgage||savedMortgage.monthlyCents===41587;
 let changed=0;
 for(const month of Object.keys(next.months)){
  if(month<'2026-12'||!mayCorrectFixed)continue;
  for(const row of next.months[month]?.details?.fixed||[]){
   if(v24LoanNameKey(row.name)!=='mutuo'||asCents(row.amount)!==42000)continue;
   const id=v5Key(month,'fixed',row);
   const settled=(next.monthlyChecks||[]).some(x=>x.id===id&&x.status==='done');
   if(settled)continue; // preserve actual past/confirmed payments
   row.amount=415.87;
   if(asCents(row.original_budget)===42000)row.original_budget=415.87;
   row.v27Source='Stima rata mutuo Intesa, screenshot 20/11/2026';
   changed++;
  }
 }
 next.v27MortgageFutureRowsAdjusted=changed;
 next.policyVersion=27;
 return validate(next);
}

/* V28 · Presentation-only: explanations go into a single end-of-tab guide.
 * No mutation of payments, funding, account balances or financial forecasts.
 * Keep value labels, validation controls, payment warnings and data details.
 */
function v28Upgrade(old){
 if((Number(old.policyVersion)||0)>=28)return old;
 const next=v5Clone(old);
 next.policyVersion=28;
 return validate(next);
}
const V28_GUIDES={
 accounts:{
  title:'Legenda conti',
  rows:[
   ['Disponibile','Saldo stimato del singolo conto, aggiornato con i movimenti che registri. Verificalo periodicamente con la banca.'],
   ['Da proteggere','Importo da lasciare su quel conto per le uscite previste fino al prossimo incasso.'],
   ['Eccedenza','Parte del saldo non necessaria alle scadenze note su quel singolo conto. Prima di spenderla considera il netto generale in Panoramica.'],
   ['Verifica saldo reale','Registra il saldo effettivo dopo un controllo. Non effettua una transazione bancaria.'],
   ['Conti abituali','Isybank: spese fisse. Intesa: mutuo e affitto. Revolut: spese libere. Cash: contanti. Il cointestato alimentari è esterno.'],
   ['Trasferimenti','Bonifici e versamenti si effettuano nell’app bancaria: qui si registrano soltanto dopo averli effettuati.']
  ]
 },
 home:{
  title:'Come leggere i numeri',
  rows:[
   ['Netto', 'Spesa massima prima del prossimo incasso, dopo le scadenze e i fondi protetti. Le entrate future non sono anticipabili.'],
   ['Patrimonio e fondi', 'Il patrimonio include conti, contanti e fondi già posseduti. Accantonare o trasferire denaro non crea nuove entrate.'],
   ['Proiezioni', 'Le sei righe si aprono per vedere scadenze e calcoli. Risparmi indica la variazione del patrimonio del mese; il netto spendibile resta il numero principale.'],
   ['viaggio estero', 'A gennaio alimentari 300 € il 19 e viaggio 1.000 € sono due voci separate. Puoi modificare solo il mese di gennaio nelle Spese fisse.'],
   ['Obiettivi', 'Casa futura e Viaggi sono somme programmate, non necessariamente già accantonate.']
  ]
 },
 income:{
  title:'Legenda entrate',
  rows:[
   ['Da ricevere','L’importo è soltanto previsto. Non aumenta i saldi prima dell’incasso.'],
   ['Incassato','Entrata realmente ricevuta: aumenta il conto selezionato una volta.'],
   ['Già incassato nel saldo','Entrata presente nel saldo reale: chiude la voce senza aggiungere soldi una seconda volta.'],
   ['Modifica ed elimina','Correggi l’importo atteso quando lo conosci; puoi ripristinare le voci eliminate.']
  ]
 },
 funds:{
  title:'Legenda fondi',
  rows:[
   ['Accantonato','Denaro protetto sul conto: non è un addebito né un bonifico automatico.'],
   ['Pagato','Segna questa voce soltanto quando l’uscita è effettiva; il saldo si aggiorna una sola volta.'],
   ['Fondi casa','Dal 18 dicembre, dopo gli accrediti: due condomìni da 50 € e luce stimata 150 €. I 300 € alimentari sono invece nelle Spese fisse del 19.'],
   ['viaggio estero','A gennaio la quota alimentare 300 € del 19 è separata dal viaggio di 1.000 €. Modifica il valore in Spese fisse se vuoi ridurlo.'],
   ['Tasse','I valori F24 sono stime da verificare con il commercialista. Accantonare non equivale a pagare una tassa.'],
   ['Spese extra','Accantona subito una cifra o pianifica una quota mensile. Il totale disponibile cambia solo dopo l’accantonamento effettivo.']
  ]
 },
 fixed:{
  title:'Legenda spese fisse',
  rows:[
   ['Da pagare','Scadenza ancora aperta; resta nelle proiezioni.'],
   ['Pagato','Addebita una volta il conto selezionato.'],
   ['Già pagato nel saldo','Chiude la spesa senza addebitarla di nuovo: è già nel saldo registrato.'],
   ['Alimentari','300 € il 19 di ogni mese, compreso gennaio 2027, sul cointestato esterno. Novembre già pagato. Puoi cambiare l’importo di un singolo mese.'],
   ['Elimina','Toglie la voce dal piano; puoi ripristinarla. I fondi per le due case restano nel tab Fondi.']
  ]
 },
 extra:{
  title:'Legenda spese extra',
  rows:[
   ['Da pagare','È una spesa ancora prevista nel piano.'],
   ['Pagato','Scala l’importo dal conto una sola volta.'],
   ['Già pagato nel saldo','Non modifica il conto perché il pagamento è già incluso.'],
   ['Accantona e quota mensile','Proteggi il denaro prima della scadenza tramite Fondi; non equivale a pagare la spesa.']
  ]
 },
 installments:{
  title:'Legenda rateizzazioni',
  rows:[
   ['Debito residuo','È la somma stimata delle rate future, comprensive di interessi ove previsti. Non sottrarla di nuovo dal patrimonio.'],
   ['Mutuo','Il capitale residuo Intesa è una stima al 20 novembre 2026: non equivale alla somma delle rate e richiede un nuovo piano ufficiale per essere aggiornato.'],
   ['Collegamento','Le rate già presenti nelle Spese fisse aggiornano il numero pagato, senza generare un doppio addebito.'],
   ['Già versato','Può includere acconti diversi dalle rate successive.'],
   ['Fonti','Alma/Klarna: conferme Gmail. Agos/Cofidis: alcuni pagamenti da verificare. Findomestic: totale teorico. Mutuo: screenshot non certificato da Intesa.'],
   ['Aggiornamenti','I contratti non vengono sincronizzati continuamente: correggili quando ricevi documenti nuovi.']
  ]
 },
 calendar:{
  title:'Legenda calendario',
  rows:[
   ['Valore del giorno','Netto protetto fino alla prossima entrata, arrotondato all’euro. Tocca una data per i centesimi e le singole voci.'],
   ['Colori','<i class="v23-dot v23-dot-in"></i> Entrate &nbsp; <i class="v23-dot v23-dot-out"></i> Fisse &nbsp; <i class="v23-dot v23-dot-extra"></i> Extra &nbsp; <i class="v23-dot v23-dot-fund"></i> Fondi'],
   ['Movimenti pagati','Sono già inclusi nel patrimonio e non si sottraggono una seconda volta.'],
   ['Previsioni','Gli incassi futuri non sono anticipati; il netto può essere negativo. I giorni anteriori alla base del piano non sono ricostruiti.']
  ]
 },
 analytics:{
  title:'Come leggere l’analisi',
  rows:[
   ['Situazione attuale','Riepiloga patrimonio, spese registrate, scadenze e incassi previsti.'],
   ['Analisi nel tempo','Per il dettaglio giornaliero e il netto prima dell’incasso usa Calendario.'],
   ['Aggiornamenti','I numeri vengono ricalcolati quando confermi pagamenti, incassi e saldi.']
  ]
 },
 backup:{
  title:'Istruzioni e sicurezza',
  rows:[
   ['Esporta','Salva il file JSON prima di ogni aggiornamento importante o cambio telefono. Contiene i tuoi dati finanziari.'],
   ['Importa','Ripristina un JSON senza aggiungere automaticamente incassi o pagamenti bancari. Verifica sempre i saldi dopo il ripristino.'],
   ['Estratti','Servono a verificare i movimenti, non vengono addebitati automaticamente.'],
   ['Privacy','I dati sono conservati sul dispositivo. Non disinstallare l’app prima di aver esportato il backup.']
  ]
 }
};
function v28GuideMarkup(tab,guide){
 const entries=guide.rows.map(([label,note])=>
  '<li><b>'+escapeHTML(label)+'</b><span>'+
  (tab==='calendar'&&label==='Colori'?note:escapeHTML(note))+'</span></li>').join('');
 return '<details class="v28-guide" id="v28Guide-'+tab+'">'+
  '<summary><span class="v28-guide-icon">?</span><span>'+escapeHTML(guide.title)+
   '</span><span class="v28-guide-chevron">›</span></summary>'+
  '<div class="v28-guide-content"><ul>'+entries+'</ul></div></details>';
}
function v28TidyAllTabs(){
 if(S.policyVersion<28)return;
 // Static introductory and repetitive explanations in all nine tabs.
 document.querySelectorAll('main.tab-page .welcome>p').forEach(x=>x.remove());
 document.querySelectorAll('#home .v13-baseline-note,#home .quick-panel>p.small-hint,'+
   '#home .goal-panel>p.small-hint,#home .v25-breakdown-note,'+
   '#home .month-lines>p.small-hint,'+
   '#calendar .v23-legend-hint,#calendar .v23-legend,'+
   '#calendar>p.small-hint,#calendar .v23-day-detail>p.small-hint,'+
   '#fixed .food-tracker>p.small-hint,'+
   '#funds .v11-house-section>p.small-hint,'+
   '#funds>section.panel>p.small-hint,'+
   '#installments .v24-loans-summary>p.small-hint,'+
   '#installments .v24-loan-register>p.small-hint,'+
   '#installments #v24LoanForm>p.small-hint,'+
   '#installments .v27-principal-editor>p.small-hint,'+
   '#installments>p.small-hint,'+
   '#analytics #v5Analytics>p.small-hint,'+
   '#backup .info-panel>p,#backup>p.safety').forEach(x=>x.remove());
 // These DOM IDs are referenced by renderers: keep them but hide verbose content.
 const food=$('v6ExternalFoodNote');if(food)food.hidden=true;
 const accountPanel=$('walletAccounts')?.closest('section.panel');
 if(accountPanel)accountPanel.querySelectorAll(':scope>p.small-hint').forEach(x=>{
   if(x.id!=='v6ExternalFoodNote')x.remove();
 });
 const period=$('v23CalendarPeriod');if(period)period.hidden=true;
 document.querySelectorAll('#home .v25-empty').forEach(x=>x.textContent='Nessuna voce');
 document.querySelectorAll('#v5FoodStatus>p.small-hint').forEach(x=>x.remove());
 document.querySelectorAll('#funds #v8TaxRows .v5-check-info>small:last-child').forEach(x=>{
   if(x.textContent.includes('Fondo interno'))x.remove();
 });
 document.querySelectorAll('#funds #v11HouseList .v11-house-info>small:last-child').forEach(x=>{
   if(x.textContent.includes('Fondo fisso previsto:'))x.remove();
 });
 document.querySelectorAll('#funds #v11HouseList .v11-auto').forEach(x=>{
   if(x.textContent.includes('Alimentari: quota prevista'))x.textContent='Versamento al cointestato da confermare';
 });
 document.querySelectorAll('#funds .v8-extra-item .v8-progress').forEach(x=>{
   x.textContent=x.textContent.replace('Effettivamente riservati','Riservati:')
     .replace('/mese programmati','/mese previsti');
 });
 const january=$('v16JanuaryHouseNote');
 if(january)january.innerHTML='<b>Gennaio:</b> alimentari del 19 separati dal budget viaggio estero.';
 const coverage=$('v8FundCoverage');
 if(coverage){
   const c=v8TaxMinimum();
   coverage.innerHTML=c.month?
    '<div class="v28-tax-overview">'+
      '<div><span>Prossimi F24</span><b>'+v8Money(c.total)+'</b>'+
      '<small>'+escapeHTML(monthTitle(c.month))+'</small></div>'+
      '<div><span>Quota indicativa</span><b>'+v8Money(c.need)+'</b><small>al mese</small></div>'+
      '<div><span>Piano previsto</span><b>'+v8Money(c.planned)+'</b><small>accantonamenti futuri</small></div>'+
    '</div>'+
    (c.shortfall>0?'<p class="v28-tax-alert">Fondi previsti insufficienti: mancano '+
       v8Money(c.shortfall)+'.</p>':''):
    '<p class="v28-tax-empty">Nessun F24 futuro nel piano.</p>';
 }
 // Loan-specific notes are not discarded: collapse them inside each loan.
 document.querySelectorAll('#v24LoanCards .v24-debt-card').forEach(card=>{
   const status=card.querySelector('.v26-source-label');
   if(status){
     const old=status.textContent.trim();
     const date=old.split('·').slice(-1)[0].trim();
     status.textContent=(status.classList.contains('v26-source-confirmed')?
       'Documentato':'Da verificare')+(date?' · '+date:'');
   }
   const notes=[...card.querySelectorAll(':scope>p.v24-loan-note')];
   if(notes.length){
     const wrapper=document.createElement('details');
     wrapper.className='v28-loan-notes';
     const summary=document.createElement('summary');
     summary.textContent='Dettagli e note';
     wrapper.append(summary);
     notes[0].before(wrapper);
     notes.forEach(note=>wrapper.append(note));
   }
   const alert=card.querySelector('.v24-loan-alert');
   if(alert)alert.textContent='Rata non collegata alle Spese fisse.';
 });
 const source=document.querySelector('#installments .v26-source-note');
 if(source)source.remove();
 const statement=$('v5StatementReview');
 if(statement){
   const note=statement.querySelector('p.small-hint');
   if(note)note.textContent=(S.bankStatement||[]).length+' movimenti in archivio.';
 }
 // Controls with empty results should still say so, without paragraphs.
 document.querySelectorAll('#funds #v8TaxRows>p.small-hint,'+
  '#funds #v8TaxBillRows>p.small-hint,'+
  '#funds #v8ExtraFundRows>p.small-hint,'+
  '#funds #v8ExtraFundEvents>p.small-hint,'+
  '#funds #v11HouseList>p.small-hint').forEach(x=>x.textContent='Nessuna voce prevista.');
 // Always append exactly one compact, closed guide at the END of every tab.
 for(const [tab,guide] of Object.entries(V28_GUIDES)){
   const page=$(tab);if(!page)continue;
   let box=$('v28Guide-'+tab);
   if(!box){
     page.insertAdjacentHTML('beforeend',v28GuideMarkup(tab,guide));
   }else if(page.lastElementChild!==box){
     page.append(box);
   }
 }
}

/* V29 presentation-only navigation & Conti tab. Financial data unchanged. */
function v29Upgrade(old){
 if((Number(old.policyVersion)||0)>=29)return old;
 const next=v5Clone(old);
 next.policyVersion=29;
 return validate(next);
}
/* V30: move the existing recurring EUR 300 groceries allocation from an
 * automatic household reserve (18th) to an explicit fixed obligation (19th).
 * November 2026 is already paid in the historical baseline, with no debit.
 * January 2027: already included in Thailand EUR 1000, no second payment.
 * Preserve individual saved payments/exclusions via ID migration.
 */
const V30_FOOD_NAME='Alimentari · conto cointestato';
const V30_FOOD_NOTE='Versamento di 300 € al conto cointestato esterno, solo quando eseguito.';
function v30OldFoodRow(row,month){
 const name=String(row?.name||'');
 return (month==='2026-11'&&/^Alimentari novembre - quota già uscita$/i.test(name))||
   /^Quota alimentare su conto cointestato$/i.test(name)||
   (row?.externalFood===true&&/alimentar/i.test(name)&&
    ['HOUSE_FUND','BUDGET_VITA'].includes(row.type));
}
function v30Upgrade(old){
 if((Number(old.policyVersion)||0)>=30)return old;
 const next=v5Clone(old);
 const converted=[];
 const skipped=[];
 let historical=0;
 for(const [month,m] of Object.entries(next.months||{})){
   const oldRows=[...(m.details?.fixed||[]),...(m.completed?.fixed||[])];
   for(const row of oldRows){
     if(!v30OldFoodRow(row,month))continue;
     const oldId=v5Key(month,'fixed',row);
     const settled=(next.monthlyChecks||[]).some(x=>x.id===oldId&&x.status==='done');
     if(month==='2027-01'){
       // The 300 euros already live inside the Thailand budget; no bill on
       // the 19th and no additional "already paid" designation.
       if((m.details?.fixed||[]).includes(row))
         m.details.fixed=m.details.fixed.filter(x=>x!==row);
       else if((m.completed?.fixed||[]).includes(row))
         m.completed.fixed=m.completed.fixed.filter(x=>x!==row);
       skipped.push(month);
       continue;
     }
     row.name=V30_FOOD_NAME;
     row.date=month+'-19';
     row.account=month==='2026-11'?
       (row.account||'Esterno'):'Isybank';
     row.type='PAGAMENTO';
     row.v30FoodFixed=true;
     row.grocery=false;
     row.externalFood=true;
     row.original_budget=row.amount;
     if(month==='2026-11'){
       row.status='GIÀ_PAGATO_NEL_SALDO';
       row.note='Già versato a novembre al conto cointestato; incluso nei saldi disponibili.';
       // November is historic, not a new transaction. Existing real checks
       // remain authoritative if user has one.
       if((m.details?.fixed||[]).includes(row)){
         m.details.fixed=m.details.fixed.filter(x=>x!==row);
         m.completed.fixed=m.completed.fixed||[];
         m.completed.fixed.push(row);
       }
       historical++;
     }else{
       row.status=settled?'PAGAMENTO_CONFERMATO':'DA_PAGARE';
       row.note=V30_FOOD_NOTE;
     }
     const newId=v5Key(month,'fixed',row);
     v11MigrateKeys(next,oldId,newId);
     // Fixed-expense forecast now reserves the money itself. Stale flags in
     // the former house-fund view cannot protect it a second time.
     next.v11HouseSetAside=(next.v11HouseSetAside||[])
       .filter(x=>x!==oldId&&x!==newId);
     converted.push(month);
   }
   // These cached totals are used by legacy views/export; current forecasts
   // recompute from the detailed rows. Historical completed items are not due.
   m.fixed=euro((m.details?.fixed||[]).reduce((n,x)=>n+asCents(x.amount),0));
 }
 // Existing legacy automatic "out of patrimony" food events remain archived
 // but NO LONGER create a second virtual debit. The explicit 19th payment
 // controls the actual bank balance and upcoming forecast.
 next.v30FoodMigration={doneAt:'2026-11-21',converted,skipped,
   novemberAlreadyPaid:historical>0,
   legacyVirtualEvents:(next.v6ExternalFood||[]).length};
 next.policyVersion=30;
 return validate(next);
}

/* V31: requested FOOD on the 19th EVEN in Jan 2027, and a per-month
 * amount editor that changes ONLY a pending groceries installment.
 * A future monthly row is a projected charge, not an immediate debit.
 */
function v31Upgrade(old){
 if((Number(old.policyVersion)||0)>=31)return old;
 const next=v5Clone(old),month='2027-01';
 const m=next.months?.[month];
 if(m){
  const existing=[
   ...(m.details?.fixed||[]),...(m.completed?.fixed||[]),
   ...(next.manualEntries||[]).filter(x=>x.month===month&&x.kind==='fixed')
  ].find(x=>x.v30FoodFixed===true||/^(Alimentari · conto cointestato|Quota alimentare su conto cointestato)$/i.test(x.name||''));
  if(!existing){
   const row={
    name:V30_FOOD_NAME,amount:300,original_budget:300,
    date:'2027-01-19',account:'Isybank',
    type:'PAGAMENTO',v30FoodFixed:true,grocery:false,
    externalFood:true,status:'DA_PAGARE',note:V30_FOOD_NOTE
   };
   m.details.fixed.push(row);
   const newId=v5Key(month,'fixed',row);
   // Migrate existing checks attached to the old January food item, if any.
   const oldIds=new Set([
    ...next.monthlyChecks.map(x=>x.id),
    ...(next.v7ExcludedRows||[]).map(x=>x.id),
    ...(next.v11HouseSetAside||[]),
    ...Object.keys(next.v9AccountOverrides||{})
   ].filter(id=>id.startsWith(month+'|fixed|')&&/alimentar/i.test(id)));
   for(const oldId of oldIds){
     if(oldId!==newId)v11MigrateKeys(next,oldId,newId);
   }
   next.v31FoodJanuaryMigration='2027-01-19';
  }else{
   next.v31FoodJanuaryMigration='already-present';
  }
  m.fixed=euro((m.details.fixed||[]).reduce((n,x)=>n+asCents(x.amount),0));
 }
 next.policyVersion=31;
 return validate(next);
}
function v31EditFoodFixedAmount(id){
 const row=v7FindRow(id);
 if(!row||row.kind!=='fixed'||!row.v30FoodFixed){
  notify('Quota alimentare non trovata.',true);return;
 }
 if(v5RowStatus(row).done){
  notify('Questa rata risulta già pagata. Riportala prima su Da pagare per modificarne la previsione.',true);
  return;
 }
 const answer=prompt('Quanto prevedi di versare per gli alimentari di '+
   monthTitle(row.month)+'? (solo questo mese, in euro).\\n'+
   'Il conto e la data del 19 restano invariati.\\n'+
   'Il budget viaggio estero rimane separato e invariato.',
   String(row.amount).replace('.',','));
 if(answer===null)return;
 const number=Number(answer.trim().replace(',','.'));
 if(!Number.isFinite(number)||number<0||number>10000){
   notify('Importo non valido: inserisci una cifra fra 0 e 10.000 €.',true);
   return;
 }
 const cents=asCents(number),before=asCents(row.amount);
 if(before===cents)return;
 if(!confirm('Cambiare soltanto gli alimentari di '+monthTitle(row.month)+
   ' da '+money(row.amount)+' a '+money(euro(cents))+'?\\n'+
   'Nessun saldo bancario viene toccato finché la spesa non viene segnata Pagato.'))return;
 const next=v5Clone(S);
 if(row.manual){
   const target=next.manualEntries.find(x=>x.id===row.id&&x.month===row.month);
   if(!target){notify('Voce manuale non trovata.',true);return}
   target.amount=euro(cents);
 }else{
   const m=next.months[row.month];
   const target=(m.details?.fixed||[]).find(x=>v5Key(row.month,'fixed',x)===id);
   if(!target){notify('Quota alimentare non trovata nel mese.',true);return}
   target.amount=euro(cents);target.original_budget=euro(cents);
   m.fixed=euro((m.details.fixed||[]).reduce((n,x)=>n+asCents(x.amount),0));
 }
 if(v5Save(next))notify('Alimentari modificati solo per '+monthTitle(row.month)+
   '. Netto, calendario e proiezioni aggiornati.');
}

/* FINANZA OFFLINE – FIRST START
 * Independent general-purpose profile. These are INTERNAL storage keys,
 * never account defaults: all opening balances and schedules start at zero.
 */
const V32_BANK_LABEL_DEFAULTS={
 Isybank:'Conto principale',Intesa:'Secondo conto',
 Revolut:'Carta / prepagata',Cash:'Contanti'
};
const V32_GENERIC_GUIDES={
 home:{title:'Come leggere i numeri',rows:[
  ['Patrimonio','Somma dei saldi reali inseriti nei Conti.'],
  ['Netto spendibile','Minimo stimato prima della prossima entrata, dopo le uscite programmate e i fondi già accantonati. Può essere negativo.'],
  ['Scadenze','Sono contate soltanto le voci che inserisci e non hai ancora segnato come pagate.'],
  ['Proiezioni','Le sei righe mensili si aprono per vedere i singoli movimenti. Risparmi è la variazione del patrimonio del mese, non il denaro spendibile oggi.']
 ]},
 accounts:{title:'Legenda conti',rows:[
  ['Saldo reale','Rinomina il conto e usa Verifica saldo reale per registrare l’importo effettivo.'],
  ['Da proteggere','Impegni ancora da pagare sul conto, prima del prossimo incasso atteso.'],
  ['Eccedenza','Saldo non richiesto dalle scadenze di quello specifico conto. Considera anche il netto complessivo.'],
  ['Spostamenti','Esegui bonifici o versamenti fuori dall’app. Qui puoi registrare i movimenti, senza creare nuove entrate.']
 ]},
 income:{title:'Legenda entrate',rows:[
  ['Da ricevere','È un incasso previsto. Non aumenta i saldi finché non viene ricevuto.'],
  ['Incassato','Aumenta il saldo del conto selezionato una sola volta.'],
  ['Già incassato nel saldo','Conferma l’entrata senza aggiungere denaro già incluso nel saldo reale.'],
  ['Ricorrenza','Puoi aggiungere entrate singole o mensili e modificare un mese alla volta.']
 ]},
 fixed:{title:'Legenda spese fisse',rows:[
  ['Da pagare','Resta nelle uscite previste alla data scelta.'],
  ['Pagato','Scala l’importo dal conto indicato una sola volta.'],
  ['Già pagato nel saldo','Chiude la voce senza sottrarla di nuovo.'],
  ['Ricorrenza','Aggiungi una spesa mensile o singola, con conto e data. Puoi correggere l’importo del singolo mese.']
 ]},
 extra:{title:'Legenda spese extra',rows:[
  ['Da pagare','Spesa non ancora sostenuta; compare nelle proiezioni e nel calendario.'],
  ['Pagato','Scala l’importo dal conto selezionato.'],
  ['Già pagato nel saldo','Non crea un secondo addebito.'],
  ['Accantonamenti','Puoi proteggere parte dei soldi nelle sezioni Fondi e Spese extra; la riserva non è una nuova spesa.']
 ]},
 funds:{title:'Legenda fondi',rows:[
  ['Riserva','Una quota accantonata resta nel patrimonio ma non è libera da spendere.'],
  ['Spese extra','Prima crea una spesa extra: qui potrai accantonare un importo o programmare la quota mensile.'],
  ['Pagamento','Quando paghi una spesa, scegli Pagato nella relativa sezione. Non sottrarre due volte.'],
  ['Nessuna quota automatica','In questa versione vuota non esistono accantonamenti, imposte o spese per abitazioni preimpostate.']
 ]},
 installments:{title:'Legenda rateizzazioni',rows:[
  ['Finanziamenti','Aggiungi ogni contratto e, se vuoi proiettarne le uscite, collega la scheda a una spesa fissa già creata.'],
  ['Rate future','L’importo stimato comprende gli interessi incorporati nelle rate. Non è automaticamente il capitale residuo.'],
  ['Nessun automatismo','Inserire il finanziamento non crea automaticamente nuove uscite.'],
  ['Capitale residuo','Si aggiorna soltanto quando lo correggi usando un estratto o un piano ufficiale.']
 ]},
 calendar:{title:'Legenda calendario',rows:[
  ['Giorni','Mostra il netto stimato fino alla prossima entrata; tocca una data per le singole scadenze.'],
  ['Colori','<i class="v23-dot v23-dot-in"></i> Entrate &nbsp; <i class="v23-dot v23-dot-out"></i> Fisse &nbsp; <i class="v23-dot v23-dot-extra"></i> Extra &nbsp; <i class="v23-dot v23-dot-fund"></i> Fondi'],
  ['Aggiornamento','Pagamenti, incassi e importi cambiati si riflettono automaticamente nel calendario.'],
  ['Date','Le entrate future non vengono anticipate. Le date fuori dal piano non sono incluse nelle proiezioni.']
 ]},
 analytics:{title:'Come leggere l’analisi',rows:[
  ['Movimenti','L’analisi usa soltanto i saldi e le voci registrate.'],
  ['Proiezioni','L’equity quotidiana è nel Calendario, i mesi nel riepilogo Panoramica.']
 ]},
 backup:{title:'Istruzioni e sicurezza',rows:[
  ['Esporta','Salva il backup JSON prima di aggiornamenti importanti o del cambio telefono.'],
  ['Importa','Ripristina un file creato da First start. Il backup della vecchia app non viene usato automaticamente.'],
  ['Privacy','Tutti i dati finanziari restano nel dispositivo. Non disinstallare l’app senza backup.']
 ]}
};
function v32AccountLabel(key){
 return S?.v32AccountNames?.[key]||V32_BANK_LABEL_DEFAULTS[key]||key;
}
function v32ResolveAccount(label){
 const value=String(label||'').trim();
 return V8_BANKS.find(k=>k.toLocaleLowerCase('it-IT')===value.toLocaleLowerCase('it-IT')||
   v32AccountLabel(k).toLocaleLowerCase('it-IT')===value.toLocaleLowerCase('it-IT'))||null;
}
function v32NamesForm(){
 const root=$('v32NamesFields');
 if(!root)return;
 // Don't recreate fields during in-progress editing.
 if(root.querySelectorAll('input').length===V8_BANKS.length)return;
 root.innerHTML=V8_BANKS.map((key,i)=>
  '<label>Conto '+(i+1)+
   '<input data-v32-name="'+escapeHTML(key)+'" maxlength="26" required value="'+
   escapeHTML(v32AccountLabel(key))+'"></label>').join('');
}
function v32SaveNames(event){
 event.preventDefault();
 const next=v5Clone(S),labels={};
 for(const input of $('v32NamesFields')?.querySelectorAll('[data-v32-name]')||[]){
  const label=input.value.trim();
  if(!label||label.length>26){notify('Inserisci nomi di 1-26 caratteri.',true);return}
  labels[input.dataset.v32Name]=label;
 }
 const array=Object.values(labels).map(s=>s.toLocaleLowerCase('it-IT'));
 if(array.length!==4||new Set(array).size!==4){
  notify('Usa quattro nomi diversi.',true);return;
 }
 next.v32AccountNames=labels;
 if(v5Save(next))notify('Nomi aggiornati. Sono etichette: i saldi non cambiano.');
}
function v32ApplyLabels(){
 const names=Object.fromEntries(V8_BANKS.map(k=>[k,v32AccountLabel(k)]));
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
 while(walker.nextNode()){
  const node=walker.currentNode;
  if(['SCRIPT','STYLE','TEXTAREA'].includes(node.parentElement?.tagName))continue;
  if(!node.__v32Original&&V8_BANKS.some(k=>node.nodeValue?.includes(k)))
   node.__v32Original=node.nodeValue;
  const original=node.__v32Original;
  if(original){
   let str=original;
   for(const k of V8_BANKS)str=str.replaceAll(k,names[k]);
   if(node.nodeValue!==str)node.nodeValue=str;
  }
 }
}
function v32GenericRender(){
 // All historical personal guides are replaced, not merely collapsed.
 for(const [key,guide] of Object.entries(V32_GENERIC_GUIDES)){
  const page=$(key),existing=$('v28Guide-'+key);
  if(!page)continue;
  if(existing){
   const opened=existing.open;
   existing.outerHTML=v28GuideMarkup(key,guide);
   $('v28Guide-'+key).open=opened;
  }else{
   page.insertAdjacentHTML('beforeend',v28GuideMarkup(key,guide));
  }
 }
 // "First start" starts with 36 blank months; no personal policies.
 const all=v5Months(),first=all[0],last=all.at(-1);
 for(const select of document.querySelectorAll('.period-month')){
  if(select.id==='v8FundMonth')continue;
  select.min=first;select.max=last;
 }
 const date=$('v5AddDate');
 if(date){date.min=first+'-01';date.max=v17EndMonth(last)}
 const end=$('v32AddUntil');
 if(end){end.min=first;end.max=last}
 v32NamesForm();
 v32ApplyLabels();
 const help=$('v32EmptyNotice');
 if(help){
  const hasEntries=S.manualEntries?.length||S.v24Loans?.length||
    S.transactions?.length||Object.values(v5AccountBalances()).some(v=>v!==0);
  help.hidden=!!hasEntries;
 }
}
function v32EditAmount(id){
 const row=v7FindRow(id);
 if(!row||!['fixed','extra'].includes(row.kind)){notify('Voce non trovata.',true);return}
 if(v5RowStatus(row).done){notify('Questa voce è già pagata. Riaprila prima di correggere la previsione.',true);return}
 const input=prompt('Nuovo importo per «'+row.name+'» nel mese '+
   monthTitle(row.month)+' (€). Modifica soltanto questo mese:',
   String(row.amount).replace('.',','));
 if(input===null)return;
 const val=Number(input.trim().replace(',','.'));
 if(!Number.isFinite(val)||val<0.01||val>100000){
  notify('Inserisci un importo maggiore di zero e inferiore a 100.000 €.',true);return;
 }
 const cents=asCents(val);
 if(cents===asCents(row.amount))return;
 if(!confirm('Cambiare solo questa scadenza da '+money(row.amount)+
   ' a '+money(euro(cents))+'? Nessun pagamento sarà registrato.'))return;
 const next=v5Clone(S);
 if(row.manual){
  const item=next.manualEntries.find(x=>x.id===id);
  if(!item){notify('Voce non trovata in archivio.',true);return}
  item.amount=euro(cents);
 }else{
  const item=[...(next.months[row.month].details?.[row.kind==='fixed'?'fixed':'variable']||[])]
    .find(x=>v5Key(row.month,row.kind,x)===id);
  if(!item){notify('Voce in archivio non trovata.',true);return}
  item.amount=euro(cents);item.original_budget=euro(cents);
 }
 if(v5Save(next))notify('Importo corretto solo per '+monthTitle(row.month)+'.');
}

/* V32 - FINANZE OFFLINE: Interactive offline analysis charts
 * STRICT READ-ONLY projections using authoritative V17 and V8 engines.
 * Never write monetary events, changes to policyVersion only on upgrade.
 * No CDN, storage, network or third-party chart library.
 */
const V32_GRAPH_START='2026-11-01';
const V32_GRAPH_MODES={
 cycle:{title:'Netto fino alla prossima entrata',axis:'Giorni',money:true,unit:'€',
   detail:'Disponibilità prudente prima del successivo incasso. La linea inizia oggi: lo storico dei saldi giornalieri anteriori non è ricostruibile con sicurezza.'},
 cash:{title:'Patrimonio e denaro non vincolato',axis:'Giorni',money:true,unit:'€',
   detail:'Patrimonio e saldo dopo i fondi: valori previsti dal calendario, non accrediti già ricevuti.'},
 spending:{title:'Uscite cumulate dal 1° novembre',axis:'Giorni',money:true,unit:'€',
   detail:'Parte da 0 € il 1° novembre. Prima di oggi considera soltanto i pagamenti registrati nell’app (storico eventualmente incompleto); da oggi aggiunge le scadenze previste. Non conta gli accantonamenti come spese.'},
 fixed:{title:'Spese fisse mese per mese',axis:'Mesi',money:true,unit:'€',
   detail:'Rate, mutuo, abbonamenti e spese fisse del piano. Le spese per le abitazioni sono riportate separatamente. I mesi già trascorsi possono non rappresentare il totale effettivamente pagato.'},
 all:{title:'Tutte le uscite mese per mese',axis:'Mesi',money:true,unit:'€',
   detail:'Totale delle uscite ancora previste: fisse, casa, extra e F24. Gli accantonamenti, essendo soldi ancora tuoi, non vengono contati una seconda volta.'},
 loans:{title:'Rate mensili previste negli anni',axis:'Anni',money:true,unit:'€',
   detail:'Scenario basato esclusivamente sulle schede di finanziamento registrate e sulle date di fine. Non comprende utenze, affitti, nuovi prestiti né altre spese fisse. Le scadenze di prestiti senza documentazione restano stime.'},
 margin:{title:'Netto teorico liberato dalla fine delle rate',axis:'Anni',money:true,unit:'€',
   detail:'SIMULAZIONE, non previsione di liquidità bancaria: il netto prudente di oggi aumenta solo per le rate che finiscono, supponendo che entrate, altre spese, fondi e condizioni restino invariati. Non sostituisce il netto ufficiale in Panoramica.'}
};
const V32_GRAPH_COLORS=['#78e5b7','#7fbeff','#ffcf80','#dbb5ff'];
let v32GraphMode='cycle',v32GraphWindow='6m',v32GraphData=null,v32GraphIndex=-1;
const v32DateInt=d=>Math.round(Date.parse(d+'T12:00:00Z')/86400000);
function v32HistorySpending(today){
 const map=new Map(),begin=V32_GRAPH_START;
 function add(day,cents){
   if(typeof day!=='string'||day<begin||day>today||!Number.isFinite(cents)||cents<=0)return;
   map.set(day,(map.get(day)||0)+cents);
 }
 for(const x of S.transactions||[]){
   if(x.category==='income')continue;
   add(x.date,asCents(x.amount));
 }
 for(const x of S.monthlyChecks||[]){
   if(x.status!=='done'||!x.charge||x.kind==='income')continue;
   add(x.paidAt,Number(x.cashCents)||0);
 }
 for(const x of S.foodCashEvents||[]){
   if(x.reconciled)continue;
   add(x.date,Number(x.amountCents)||0);
 }
 return map;
}
function v32LoanMonthlyTimeline(){
 const today=dayLocal(),startYear=Number(today.slice(0,4));
 const loans=(Array.isArray(S.v24Loans)?S.v24Loans:[])
  .filter(l=>l&&Number(l.monthlyCents)>0&&l.firstDueDate&&
    Number(l.installmentsTotal)>0);
 const byMonth=new Map();
 let lastYear=startYear+2;
 for(const l of loans){
   const before=Math.max(0,Number(l.paidBefore)||0);
   const count=Math.max(0,Number(l.installmentsTotal)||0-before);
   const paidKeys=l.linkedName?v24LoanNameKey(l.linkedName):'';
   for(let i=0;i<Math.min(count,600);i++){
     const date=v24MonthShift(l.firstDueDate,i);
     const month=date.slice(0,7);
     // Known paid linked installments are not projected as unpaid again.
     if(paidKeys&&S.months[month]){
       const linked=v5Catalog(month,'fixed').some(x=>
         v24LoanNameKey(x.name)===paidKeys&&v5RowStatus(x).done);
       if(linked)continue;
     }
     if(date<today.slice(0,7)+'-01')continue;
     if(Number(date.slice(0,4))>2065)continue;
     byMonth.set(month,(byMonth.get(month)||0)+Number(l.monthlyCents));
     lastYear=Math.max(lastYear,Number(month.slice(0,4))+1);
   }
 }
 lastYear=Math.min(lastYear,2065);
 return {loans,byMonth,startYear,lastYear};
}
function v32GraphRows(mode=v32GraphMode,windowId=v32GraphWindow){
 const today=dayLocal(),start=V32_GRAPH_START,info=V32_GRAPH_MODES[mode]||V32_GRAPH_MODES.cycle;
 let rows=[],series=[],sourceNote='';
 const daily=['cycle','cash','spending'].includes(mode);
 if(daily){
   const plan=v17DailyPlan();
   const future=new Map(plan.days.map(x=>[x.day,x]));
   const cycles=mode==='cycle'?v24CycleAllDays(plan):null;
   const recorded=v32HistorySpending(today);
   const projected=mode==='spending'?new Map(
     plan.events.filter(e=>['fixed','house','extra','taxBill'].includes(e.kind))
      .map(e=>[e.day,e])):null;
   let actualCumulative=0,allCumulative=0;
   const last=plan.end||today;
   // Important: Nov 1 is a historical zero anchor for expenditure, NOT
   // an invented past bank balance. The latter has null data until today.
   for(let day=start;day<=last;day=v17AddDays(day,1)){
     const item=future.get(day),actualDay=day<=today;
     if(mode==='cycle'){
       rows.push({date:day,values:[item?(cycles.get(day)?.net??null):null],
         region:day<today?'unknown':'forecast',items:item?.detail||[]});
     }else if(mode==='cash'){
       rows.push({date:day,values:[item?.gross??null,item?.net??null],
         region:day<today?'unknown':'forecast',items:item?.detail||[]});
     }else{
       if(day>start){
         const prior=v17AddDays(day,-1);
         actualCumulative+=(recorded.get(prior)||0);
       }
       const current=day>today&&item
         ?(item.fixed+item.extra):0;
       if(day===start)allCumulative=0;
       if(day===today)allCumulative=actualCumulative+
         (recorded.get(today)||0)+(item?.fixed||0)+(item?.extra||0);
       else if(day>today)allCumulative+=current;
       const value=day<today?actualCumulative:allCumulative;
       rows.push({date:day,values:[value],region:day<today?'recorded':'forecast',
         items:item?.detail||[],actualOnly:day<=today});
     }
   }
   if(mode==='cycle')series=['Netto fino alla prossima entrata'];
   if(mode==='cash')series=['Patrimonio totale','Dopo fondi vincolati'];
   if(mode==='spending')series=['Uscite registrate + previste'];
   sourceNote=mode==='spending'?'Storico: soltanto uscite registrate. Dal giorno successivo a oggi: scadenze previste.':'I giorni precedenti alla prima rilevazione non hanno un saldo giornaliero attendibile.';
   if(windowId==='30'||windowId==='90'){
     const threshold=v17AddDays(today,-Number(windowId)+1);
     // User's requested Nov 1 remains the starting baseline for all-time
     // view, while short windows are explicit alternate views.
     rows=rows.filter(x=>x.date>=threshold);
   }
 }else if(mode==='fixed'||mode==='all'){
   const plans=v8Plans();
   rows=plans.map(m=>({
     date:m.month+'-15',month:m.month,region:m.month<today.slice(0,7)?'recorded':'forecast',
     values:mode==='fixed'?
       [m.fixed,m.homeFunds]:
       [m.fixed+m.homeFunds+m.variable+m.taxBills,m.fixed+m.homeFunds],
     items:mode==='fixed'?[...m.rows.fixed,...m.rows.house]:
       [...m.rows.fixed,...m.rows.house,...m.rows.extra,...m.taxDue]
   }));
   series=mode==='fixed'?['Spese fisse','Spese casa']:
     ['Tutte le uscite previste','Di cui fisse e casa'];
   sourceNote='I valori dei mesi sono uscite ancora aperte e non ricostruiscono retroattivamente tutte le spese già pagate.';
   if(windowId==='30'||windowId==='90'){
     const limit=windowId==='30'?2:4;
     rows=rows.filter(x=>x.month>=today.slice(0,7)).slice(0,limit);
   }
 }else{
   const timeline=v32LoanMonthlyTimeline();
   const annual=[];
   const mainStart=timeline.startYear;
   const baselineMonth=String(mainStart)+'-12';
   const base=timeline.byMonth.get(baselineMonth)||0;
   const currentNet=v17CycleSafety().minimum;
   for(let year=mainStart;year<=timeline.lastYear;year++){
     const dec=timeline.byMonth.get(year+'-12')||0;
     annual.push({
       date:year+'-12-31',year,region:'scenario',
       values:mode==='loans'?[dec]:[currentNet+(base-dec)],
       monthlyLoans:dec,freed:base-dec,
       items:timeline.loans
     });
   }
   rows=annual;
   series=[mode==='loans'?'Rate attive a dicembre':'Netto teorico a condizioni costanti'];
   sourceNote=timeline.loans.length?
     'Scenario contrattuale, non previsione contabile oltre il piano. Confronto sul mese di dicembre di ogni anno.':
     'Nessun finanziamento con durata inserita: aggiungi le schede in Rateizzazioni per vedere la fine delle rate.';
 }
 return {mode,info,today,rows,series,sourceNote,
   hasData:rows.some(x=>x.values.some(v=>Number.isFinite(v))),
   units:daily?'daily':mode==='fixed'||mode==='all'?'monthly':'annual'};
}
function v32GraphEuro(cents,compact=false){
 if(!Number.isFinite(cents))return '—';
 if(!compact)return v8Money(cents);
 const abs=Math.abs(cents),sign=cents<0?'−':'';
 if(abs>=100000000)return sign+(abs/100000000).toFixed(1).replace('.',',')+' M€';
 if(abs>=100000)return sign+(abs/100000).toFixed(abs<1000000?1:0).replace('.',',')+' mila €';
 return sign+Math.round(abs/100).toLocaleString('it-IT')+' €';
}
function v32GraphTimeLabel(date,units){
 if(!date)return '';
 if(units==='annual')return date.slice(0,4);
 if(units==='monthly')return monthTitle(date.slice(0,7));
 return date.slice(8,10)+'/'+date.slice(5,7)+'/'+date.slice(2,4);
}
function v32GraphSvg(data){
 const compact=window.innerWidth<=600;
 const W=compact?400:850,H=compact?300:330;
 const left=compact?76:84,top=27,right=compact?12:22,bottom=compact?52:58;
 const plotW=W-left-right,plotH=H-top-bottom;
 const N=data.rows.length;
 const drawn=data.rows.flatMap(r=>r.values.filter(Number.isFinite));
 if(!N||!drawn.length)return '<div class="v32-no-series">Non ci sono ancora dati per questa visualizzazione.</div>';
 const minData=Math.min(0,...drawn),maxData=Math.max(0,...drawn);
 const diff=Math.max(10000,maxData-minData);
 const low=Math.floor((minData-diff*.10)/10000)*10000;
 const high=Math.ceil((maxData+diff*.10)/10000)*10000;
 const range=Math.max(10000,high-low);
 const x=i=>left+(N<=1?plotW/2:i/(N-1)*plotW);
 const y=n=>top+plotH-(n-low)/range*plotH;
 const lineGroups=[];
 data.series.forEach((name,s)=>{
   const segments=[];
   let seg=[];
   let prevRegion='';
   data.rows.forEach((row,i)=>{
     const value=row.values[s];
     if(!Number.isFinite(value)){
       if(seg.length)segments.push({values:seg,region:prevRegion});
       seg=[];prevRegion='';return;
     }
     if(prevRegion&&row.region!==prevRegion){
       // Different stroke between observed and projected intervals.
       if(seg.length)segments.push({values:seg,region:prevRegion});
       seg=seg.length?[seg.at(-1)]:[];
     }
     seg.push([x(i),y(value)]);
     prevRegion=row.region;
   });
   if(seg.length)segments.push({values:seg,region:prevRegion});
   const color=V32_GRAPH_COLORS[s%V32_GRAPH_COLORS.length];
   lineGroups.push(segments.map(seg=>
     '<path d="'+seg.values.map(([px,py],i)=>(i?'L':'M')+px.toFixed(2)+' '+py.toFixed(2)).join(' ')+
     '" fill="none" stroke="'+color+'" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"'+
     (seg.region==='forecast'||seg.region==='scenario'?' stroke-dasharray="7 6"':'')+'/>' ).join(''));
 });
 const tickCount=compact?4:5;
 const ticks=Array.from({length:tickCount},(_,i)=>
   Math.round(low+(high-low)*i/(tickCount-1)));
 const grid=ticks.map(v=>
   '<line x1="'+left+'" x2="'+(W-right)+'" y1="'+y(v)+'" y2="'+y(v)+
   '" stroke="'+(v===0?'#65998b':'#304f5e')+'" stroke-opacity="'+(v===0?'.85':'.65')+
   '" stroke-width="'+(v===0?'1.7':'1')+'"/>'+
   '<text x="'+(left-12)+'" y="'+(y(v)+5)+'" text-anchor="end" font-size="'+(compact?16:14)+'" fill="#a7c1ce">'+
   escapeHTML(v32GraphEuro(v,true))+'</text>'
 ).join('');
 const steps=Math.min(compact?3:5,Math.max(1,N-1));
 const xLabels=Array.from({length:steps+1},(_,i)=>Math.floor(i*(N-1)/steps))
  .filter((v,i,a)=>a.indexOf(v)===i).map(i=>
   '<text x="'+x(i)+'" y="'+(top+plotH+27)+'" text-anchor="'+(i===0?'start':i===N-1?'end':'middle')+
   '" font-size="'+(compact?16:14)+'" fill="#b8d0d8">'+escapeHTML(v33GraphAxisLabel(data.rows[i].date,data.units))+
   '</text>').join('');
 const firstForecast=data.rows.findIndex(r=>r.region==='forecast');
 const todayX=firstForecast>0&&firstForecast<N-1?(
   '<line x1="'+x(firstForecast)+'" x2="'+x(firstForecast)+
   '" y1="'+top+'" y2="'+(top+plotH)+'" stroke="#a0bbba" stroke-dasharray="4 7" opacity=".8"/>'+
   '<text x="'+(x(firstForecast)+6)+'" y="'+(top+14)+'" font-size="12" fill="#d9f7ea">Oggi</text>'):'';
 const dots=data.rows.map((row,i)=>({
   row,i,value:row.values[0]
 })).filter(({row,i,value})=>Number.isFinite(value)&&
   (i===v32GraphIndex||i===0||i===N-1||i%Math.max(1,Math.round(N/24))===0))
  .map(({i,value})=>
   '<circle cx="'+x(i)+'" cy="'+y(value)+'" r="'+(i===v32GraphIndex?'8':'5')+
   '" fill="'+(i===v32GraphIndex?'#e0fff0':V32_GRAPH_COLORS[0])+
   '" fill-opacity="'+(i===v32GraphIndex?'1':'.85')+'" stroke="#173346" stroke-width="2"'+
   ' data-v32-point="'+i+'" role="button" tabindex="0" aria-label="'+
   escapeHTML(v32GraphTimeLabel(data.rows[i].date,data.units)+' '+v32GraphEuro(value))+'"/>' ).join('');
 return '<svg class="v32-chart-svg" viewBox="0 0 '+W+' '+H+'" role="img"'+
  ' aria-label="'+escapeHTML(data.info.title)+'; asse verticale euro, asse orizzontale '+data.info.axis+'">'+
  '<rect x="'+left+'" y="'+top+'" width="'+plotW+'" height="'+plotH+'" fill="#10283b" rx="8"/>'+
  grid+todayX+lineGroups.join('')+dots+xLabels+'</svg>';
}
function v32AnalysisPointHtml(data,index){
 if(!data.rows.length)return 'Nessun elemento selezionato.';
 const selected=data.rows[Math.max(0,Math.min(index,data.rows.length-1))];
 const vals=selected.values.map((v,i)=>
  '<div class="v32-point-metric"><span>'+escapeHTML(data.series[i])+'</span>'+
  '<strong>'+v32GraphEuro(v)+'</strong></div>').join('');
 let detail='';
 if(data.units==='annual'){
   detail='<p class="v32-point-note">Rate attive a dicembre: '+
     v32GraphEuro(selected.monthlyLoans||0)+
     '. Margine mensile teorico liberato: '+v32GraphEuro(selected.freed||0)+'.</p>';
 }else if(selected.region==='unknown'){
   detail='<p class="v32-point-note">Non esiste una rilevazione giornaliera attendibile di questa data. Non viene stimata retroattivamente.</p>';
 }else{
   const movements=(selected.items||[]).filter(x=>x&&x.amount>0);
   if(movements.length){
     detail='<details class="v32-day-detail"><summary>Movimenti previsti della data ('+
       movements.length+')</summary><div>'+
       movements.map(e=>'<div class="v32-day-row"><span>'+
         escapeHTML(e.label||e.name||'Movimento')+'</span><b>'+
         v32GraphEuro(data.units==='daily'?Number(e.amount):asCents(e.amount))+'</b></div>').join('')+'</div></details>';
   }
 }
 return '<div class="v32-selected-date">'+escapeHTML(v32GraphTimeLabel(selected.date,data.units))+
  (selected.region==='scenario'?' · Scenario':selected.region==='forecast'?' · Previsione':
    selected.region==='unknown'?' · Storico non disponibile':' · Registrato')+
  '</div><div class="v32-point-values">'+vals+'</div>'+detail;
}
function v32GraphSelectIndex(next){
 const data=v32GraphData;if(!data?.rows?.length)return;
 const n=Math.max(0,Math.min(data.rows.length-1,Number(next)||0));
 v32GraphIndex=n;
 const info=$('v32SelectedPoint');
 if(info)info.innerHTML=v32AnalysisPointHtml(data,n);
 const range=$('v32GraphSlider');
 if(range)range.value=String(n);
 const date=$('v32GraphSliderDate');
 if(date)date.textContent=v32GraphTimeLabel(data.rows[n].date,data.units);
 const svg=$('v32GraphSvg');
 if(svg)svg.innerHTML=v32GraphSvg(data);
}
function v32RenderAnalysis(){
 const root=$('v32AnalyticsChart');if(!root)return;
 const data=v33GraphRows();
 v32GraphData=data;
 const previous=v32GraphIndex;
 if(data.rows.length)
   v32GraphIndex=(previous<0||previous>=data.rows.length)?
     (data.rows.findIndex(r=>r.date>=data.today&&r.values.some(Number.isFinite))>=0?
       data.rows.findIndex(r=>r.date>=data.today&&r.values.some(Number.isFinite)):
       data.rows.length-1):previous;
 else v32GraphIndex=-1;
 const selected=data.rows[v32GraphIndex];
 const lastVisible=[...data.rows].reverse().find(x=>x.values.some(Number.isFinite));
 const firstVisible=data.rows.find(x=>x.values.some(Number.isFinite));
 const headlineRow=['cycle','cash'].includes(data.mode)?
   (data.rows.find(x=>x.date===data.today)||firstVisible):lastVisible;
 const total=headlineRow?.values[0]??null;
 const sub=firstVisible?('Dal '+v32GraphTimeLabel(data.rows[0].date,data.units)+
   ' al '+v32GraphTimeLabel(data.rows.at(-1).date,data.units)):'Nessun dato';
 $('v32GraphHeading').textContent=data.info.title;
 $('v32GraphValue').textContent=v32GraphEuro(total);
 $('v32GraphRange').textContent=sub;
 $('v32GraphUnits').textContent=data.units==='annual'?'anno':
   data.units==='monthly'?'mese':'giorni';
 $('v32GraphIntro').textContent=data.info.detail;
 $('v32GraphSource').textContent=data.sourceNote;
 $('v32GraphSvg').innerHTML=v32GraphSvg(data);
 const windowSel=$('v32GraphWindow');
 const annual=data.units==='annual';
 windowSel.disabled=annual;
 windowSel.innerHTML=annual?'<option value="all">Tutti gli anni</option>':
   '<option value="1m">1 mese</option>'+
   '<option value="3m">3 mesi</option>'+
   '<option value="6m">6 mesi</option>';
 windowSel.value=annual?'all':v32GraphWindow;
 const modes=$('v32GraphMode');
 if(modes)modes.value=v32GraphMode;
 $('v32GraphLegend').innerHTML=data.series.map((s,i)=>
  '<span><i style="background:'+V32_GRAPH_COLORS[i%V32_GRAPH_COLORS.length]+
  '"></i>'+escapeHTML(s)+'</span>').join('');
 const slider=$('v32GraphSlider');
 slider.min='0';slider.max=String(Math.max(0,data.rows.length-1));
 slider.disabled=data.rows.length<2;
 if(selected){
   slider.value=String(v32GraphIndex);
   $('v32SelectedPoint').innerHTML=v32AnalysisPointHtml(data,v32GraphIndex);
   $('v32GraphSliderDate').textContent=v32GraphTimeLabel(selected.date,data.units);
 }else{
   $('v32SelectedPoint').innerHTML='<p class="v32-point-note">Nessun dato da esaminare.</p>';
   $('v32GraphSliderDate').textContent='—';
 }
}
function v32GraphUiChange(event){
 if(event.target.id==='v32GraphMode'){
   v32GraphMode=event.target.value in V32_GRAPH_MODES?event.target.value:'cycle';
   v32GraphIndex=-1;
   v32RenderAnalysis();
 }
 if(event.target.id==='v32GraphWindow'){
   v32GraphWindow=['1m','3m','6m'].includes(event.target.value)?event.target.value:'6m';
   v32GraphIndex=-1;v32RenderAnalysis();
 }
}
function v32GraphUiInput(event){
 if(event.target.id==='v32GraphSlider')v32GraphSelectIndex(event.target.value);
}
function v32GraphUiClick(event){
 const hit=event.target.closest?.('[data-v32-point]');
 if(hit)v32GraphSelectIndex(hit.dataset.v32Point);
}
function v32GraphUiKey(event){
 const hit=event.target.closest?.('[data-v32-point]');
 if(hit&&(event.key==='Enter'||event.key===' ')){
   event.preventDefault();v32GraphSelectIndex(hit.dataset.v32Point);
 }
}
function v32Upgrade(old){
 if((Number(old.policyVersion)||0)>=32)return old;
 const next=v5Clone(old);
 next.policyVersion=32;
 return validate(next);
}

/* V33: short, precise numeric timelines and 1/3/6 month horizons.
 * Read-only. Calculations reuse V17 daily plan and V8 monthly cashflows.
 * Do not generate fictitious payments, income, interest or fund movements.
 */
Object.assign(V32_GRAPH_MODES,{
 gross:{
  title:'Patrimonio lordo',
  axis:'Giorni',money:true,unit:'€',
  detail:'Patrimonio complessivo dei quattro conti previsto a fine giornata, prima delle riserve. Gli incassi futuri restano ipotesi.'
 },
 extra:{
  title:'Spese extra mese per mese',
  axis:'Mesi',money:true,unit:'€',
  detail:'Totale delle spese extra ancora aperte in ciascun mese; le quote accantonate non sono nuove uscite.'
 },
 funds:{
  title:'Fondi protetti nel tempo',
  axis:'Giorni',money:true,unit:'€',
  detail:'Denaro riservato: tasse, uscite extra e altre quote protette. Non è un costo aggiuntivo né un saldo separato dal patrimonio.'
 }
});
function v33GraphAxisLabel(date,units){
 if(!date)return '';
 if(units==='annual')return date.slice(0,4);
 if(units==='monthly')return date.slice(5,7)+'/'+date.slice(2,4);
 return date.slice(8,10)+'/'+date.slice(5,7);
}
function v33GraphPeriodLimit(today,monthCount){
 const end=v24MonthShift(today,monthCount);
 return v17AddDays(end,-1);
}
function v33GraphRows(mode=v32GraphMode,windowId=v32GraphWindow){
 const today=dayLocal();
 const valid=['1m','3m','6m'];
 const window=valid.includes(windowId)?windowId:'6m';
 const count=Number(window[0]);
 // Keep the contractual year-by-year views separate from the 1/3/6
 // month windows. Contract horizon, not a bank-cashflow prediction.
 if(mode==='loans'||mode==='margin'){
  const data=v32GraphRows(mode,'all');
  return {...data,horizon:window,sourceNote:data.sourceNote+
   ' Gli importi annuali si riferiscono al mese di dicembre.'};
 }
 const daily=['cycle','cash','gross','funds','spending'].includes(mode);
 if(daily){
  const core=mode==='gross'||mode==='funds'?'cash':mode;
  const data=v32GraphRows(core,'all');
  const plans=mode==='funds'?new Map(v17DailyPlan().days.map(r=>[r.day,r])):null;
  const cutoff=v33GraphPeriodLimit(today,count);
  let rows=data.rows.filter(r=>r.date<=cutoff&&(mode==='spending'?
    r.date>=V32_GRAPH_START:r.date>=today));
  if(mode==='gross')rows=rows.map(x=>({...x,values:[x.values[0]]}));
  if(mode==='funds')rows=rows.map(x=>({...x,values:[
    plans.has(x.date)?plans.get(x.date).held:null]}));
  const info=V32_GRAPH_MODES[mode];
  const series=mode==='gross'?['Patrimonio lordo']:
    mode==='funds'?['Fondi protetti']:data.series;
  const actualEnd=rows.at(-1)?.date;
  const complete=actualEnd&&actualEnd>=cutoff;
  let note=data.sourceNote;
  if(mode==='gross')note='Valori del piano, non denaro già incassato. Per oggi il punto rappresenta il saldo a fine giornata prevista.';
  if(mode==='funds')note='Fondi trattenuti all’interno del patrimonio; cambiano solo dopo i relativi movimenti e accantonamenti.';
  if(!complete)note+=' La previsione si ferma all’ultimo giorno disponibile nel piano.';
  return {...data,mode,info,rows,series,sourceNote:note,horizon:window,
    hasData:rows.some(x=>x.values.some(Number.isFinite))};
 }
 if(['fixed','extra','all'].includes(mode)){
  const core=mode==='extra'?'all':mode;
  const data=v32GraphRows(core,'all');
  const from=today.slice(0,7);
  const allowedMonths=v8Plans().filter(x=>x.month>=from).slice(0,count);
  const allowed=new Set(allowedMonths.map(x=>x.month));
  let rows=data.rows.filter(r=>allowed.has(r.month));
  if(mode==='extra'){
   const extraByMonth=new Map(allowedMonths.map(x=>[x.month,x]));
   rows=rows.map(r=>({...r,
    values:[extraByMonth.get(r.month)?.variable??0],
    items:extraByMonth.get(r.month)?.rows?.extra||[]}));
  }
  const info=V32_GRAPH_MODES[mode];
  const series=mode==='extra'?['Spese extra previste']:data.series;
  return {...data,mode,info,series,rows,horizon:window,
    sourceNote:mode==='extra'?'Solo extra ancora da pagare. Le spese confermate in banca non sono addebitate nuovamente.':
       data.sourceNote,
    hasData:rows.some(x=>x.values.some(Number.isFinite))};
 }
 return v33GraphRows('cycle',window);
}
function v33Upgrade(old){
 if((Number(old.policyVersion)||0)>=33)return old;
 const next=v5Clone(old);
 next.policyVersion=33;
 return validate(next);
}

safeSave=v5Save;
document.addEventListener('click',v5Click);
document.addEventListener('change',v5Change);
document.addEventListener('change',v32GraphUiChange);
document.addEventListener('input',v32GraphUiInput);
document.addEventListener('click',v32GraphUiClick);
document.addEventListener('keydown',v32GraphUiKey);
$('v5QuickForm').addEventListener('submit',v5QuickAdd);
$('v5AddForm').addEventListener('submit',v5AddEntry);
$('v24LoanForm').addEventListener('submit',v24SaveLoan);
$('v32NamesForm').addEventListener('submit',v32SaveNames);
$('exportButton').addEventListener('click',exportData);
$('importButton').addEventListener('click',importData);
window.FinanzeTest={getState:()=>S,forecast:v5Plans,v5Now,v5QuickSpent,v5Catalog,
  v5AccountBalances,v5Upgrade,mergeImported,dayLocal,v5FoodUsed,v5Save,
  v6Upgrade,v6ExternalPending,v6AutoFood,v7Upgrade,v7SetChecked,
  v7Exclude,v7Restore,v7UndoDaily,v8Upgrade,v8Plans,v8Now,
  v8TaxFunds,v8TaxBills,v8TaxActiveCents,v8TaxMinimum,v8Advisory,
  v8ExtraFundActual,v8ExtraFundActive,v8ExtraTotalActive,v8ReserveDistribution,
  v8TaxEstimateEdit,v9Plan,v9WalletDisplay,v9Upgrade,
  v9RecordTransfer,v9UndoTransfer,v9ReconcileTransferLegs,v9AssignAccount,
  v10Upgrade,v11Upgrade,v11HouseRows,v11HouseDue,v11IsFundSetAside,
  v11ReserveHouse,v11PayHouse,v11AddTenantBill,v11AddTenantRefund,
  v12Upgrade,v12FixedBank,v13Upgrade,v13WindowStart,v13FollowingIncome,
  v14Upgrade,v14SafeLiquidity,v14LiquiditySummary,
  v15Upgrade,v15SixMonthRows,
  v16Upgrade,v16SixMonthRows,v16RenderSixMonths,
  v17Upgrade,v17TravelAllocations,v17DailyPlan,v17CycleSafety,
  v17RenderAll,v17RenderSixMonths,v17RenderCalendar,
  v18Upgrade,v17RenderHome,v19Upgrade,v19CycleForMonth,
  v20Upgrade,v14RenderRisk,v5RenderQuickHistory,
  v21Upgrade,v21CycleFundBreakdown,v21RenderHeroBreakdown,
  v22Upgrade,v22SetStatus,v22CurrentStatus,v22DeleteRow,v22EditIncome,
  v23Upgrade,v23RenderSixMonthCalendar,v23RenderDateDetail,
  v24Upgrade,v24RenderLoans,v24LoanMetrics,v24CycleNetForDay,v24CycleAllDays,v24SaveLoan,v24DeleteLoan,
  v25Upgrade,v25MonthCards,v25ExtraFundSnapshot,
  v26Upgrade,V26_EMAIL_CONTRACTS,v27Upgrade,V27_MUTUO_ESTIMATE,
  v28Upgrade,v28TidyAllTabs,V28_GUIDES,v29Upgrade,
  v30Upgrade,V30_FOOD_NAME,v31Upgrade,v31EditFoodFixedAmount,
  v32AccountLabel,v32ResolveAccount,v32EditAmount,v32GenericRender,
  v32GraphRows,v33GraphRows,v32RenderAnalysis,v32HistorySpending,
  v33GraphAxisLabel,v33GraphPeriodLimit,v33Upgrade,v24CycleAllDays,
  V32_GRAPH_MODES};
v5Load().catch(err=>notify('Impossibile aprire l’archivio: '+err.message,true));
})();
