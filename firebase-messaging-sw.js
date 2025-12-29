importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCjIggzBA4NaMNm1FSfTUzvZLBquvd9P40",
  authDomain: "pakora-automations-chat.firebaseapp.com",
  projectId: "pakora-automations-chat",
  storageBucket: "pakora-automations-chat.firebasestorage.app",
  messagingSenderId: "281325034328",
  appId: "1:281325034328:web:e05c04bac6b8558560632d"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Neue Nachricht";
  const options = {
    body: payload.notification?.body || "",
    icon: "/logo.png",
    tag: payload?.data?.messageId || payload?.fcmOptions?.link || "pakora-message",
    data: {
      link: payload?.fcmOptions?.link || "/kommunikation.html"
    }
  };

  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification?.data?.link || "/kommunikation.html";
  event.waitUntil(clients.openWindow(link));
});
