// Notifications only: Android Chrome and installed (home-screen) apps can show page
// notifications only through a service worker. No fetch handler, no caching.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>list[0]?.focus()));
});
