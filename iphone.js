/* Offline onboarding: Safari on iPhone, no analytics or external network. */
(function(){
 'use strict';
 const installPanel=document.getElementById('iosInstallPanel');
 const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||
   (navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
 const standalone=window.navigator.standalone===true||
   (window.matchMedia&&window.matchMedia('(display-mode: standalone)').matches);
 try{
  if(installPanel&&isIOS&&!standalone&&!sessionStorage.getItem('finanza-ios-banner-dismissed')){
   installPanel.hidden=false;
  }
  document.getElementById('iosInstallDismiss')?.addEventListener('click',()=>{
   if(installPanel)installPanel.hidden=true;
   try{sessionStorage.setItem('finanza-ios-banner-dismissed','1')}catch(_e){}
  });
 }catch(_e){}

 // Apple browsers have different versions of native month inputs.
 // If unsupported, provide a normal month dropdown with the same ID,
 // so the original finance engine uses exactly the same month strings.
 try{
  const test=document.createElement('input');test.setAttribute('type','month');
  if(test.type!=='month'){
   const original=document.getElementById('v32AddUntil');
   if(original){
    const select=document.createElement('select');
    select.id=original.id;
    const months=Object.keys(window.FinanzeTest?.getState()?.months||{}).sort();
    select.add(new Option('Fino a quando (facoltativo)',''));
    for(const month of months){
     const [y,m]=month.split('-');
     select.add(new Option(m+'/'+y,month));
    }
    original.replaceWith(select);
   }
  }
 }catch(error){console.warn('Selettore mese alternativo non disponibile:',error?.message||error)}
 if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
   navigator.serviceWorker.register('./sw.js',{scope:'./'}).catch(err=>{
    console.warn('Offline cache non disponibile:',err?.message||err);
   });
  });
 }
})();
