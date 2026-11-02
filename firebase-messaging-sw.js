importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Initialize Firebase in the Service Worker
firebase.initializeApp({
  apiKey: "AIzaSyAGoGpjPJKuA7QEjvVrlhPaK27w2Qbjpec",
  authDomain: "campusmobility-fa67f.firebaseapp.com",
  projectId: "campusmobility-fa67f",
  storageBucket: "campusmobility-fa67f.firebasestorage.app",
  messagingSenderId: "403227116037",
  appId: "1:403227116037:web:c28470ada360102ee5526c"
});

const messaging = firebase.messaging();

// This handles notifications when the app is in the background or closed
messaging.onBackgroundMessage((payload) => {
  console.log('[sw] Received background message ', payload);

  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/assets/rec_thandalam_bus_map.jpg' // Path to your app icon
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});