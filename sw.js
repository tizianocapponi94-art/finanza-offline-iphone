/* Finanza Offline iPhone First Start V33 — offline shell.
 * Only public static code and zero data are cached. User money stays in
 * the iPhone storage and is never sent to the MSI/Tailscale origin.
 */
'use strict';
const CACHE='finanza-iphone-firststart-v33-cache-2';
const SHELL=[
 './',
 './index.html',
 './logic.js',
 './style.css',
 './seed.json',
 './iphone.js',
 './manifest.webmanifest',
 './apple-touch-icon.png',
 './icon-192.png',
 './icon-512.png'
];
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(SHELL.map(url=>new Request(url,{cache:'reload'})));
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('finanza-iphone-firststart-')&&k!==CACHE)
   .map(k=>caches.delete(k)));
  await self.clients.claim();
 })());
});
self.addEventListener('fetch',event=>{
 const req=event.request;
 if(req.method!=='GET')return;
 const url=new URL(req.url);
 if(url.origin!==self.location.origin)return;
 const scope=new URL(self.registration.scope);
 if(!url.pathname.startsWith(scope.pathname))return;
 if(req.mode==='navigate'){
  event.respondWith((async()=>{
   try{
    const res=await fetch(req);
    if(res.ok){
     const cache=await caches.open(CACHE);
     cache.put(new Request('./index.html'),res.clone()).catch(()=>{});
    }
    return res;
   }catch(_err){
    const cache=await caches.open(CACHE);
    return (await cache.match('./index.html'))||
      new Response('App offline non ancora installata',{status:503});
   }
  })());
  return;
 }
 event.respondWith((async()=>{
  const cached=await caches.match(req);
  if(cached)return cached;
  return fetch(req);
 })());
});
