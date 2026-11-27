// System notifications, shown through the service worker (DESIGN §7.1).

export type AlertKind = 'away' | 'nothing' | 'server' | 'sound' | 'test';

export interface NotificationContent {
  title: string;
  body: string;
  actions?: { action: string; title: string }[];
  data?: unknown;
}

/** NotificationOptions as Chrome accepts them: TypeScript's DOM types leave these out. */
interface ChromeNotificationOptions extends NotificationOptions {
  actions?: { action: string; title: string }[];
  renotify?: boolean;
}

export const notify = {
  permission(): NotificationPermission | 'unsupported' {
    return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  },

  /** Asks Chrome for the permission. Call it from a click. */
  async requestPermission(): Promise<NotificationPermission> {
    if (typeof Notification === 'undefined') {
      return 'denied';
    }
    return Notification.requestPermission();
  },

  /** Registers the service worker. Call once, at start. */
  async register(): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch (err) {
      console.error('Service worker registration failed', err);
    }
  },

  /**
   * Shows a notification that stays until clicked. One per kind: a new one replaces the old
   * and alerts again. Does nothing if the permission isn't granted.
   */
  async show(kind: AlertKind, n: NotificationContent): Promise<void> {
    if (notify.permission() !== 'granted' || !('serviceWorker' in navigator)) {
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const options: ChromeNotificationOptions = {
        body: n.body,
        tag: kind,
        requireInteraction: true,
        actions: n.actions,
        data: n.data,
        icon: '/favicon.svg',
        renotify: true,
      };
      await registration.showNotification(n.title, options);
    } catch (err) {
      console.error('Showing a notification failed', err);
    }
  },

  /** Closes the notification of that kind, if one is showing. */
  async close(kind: AlertKind): Promise<void> {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const shown = (await registration?.getNotifications({ tag: kind })) ?? [];
      for (const notification of shown) {
        notification.close();
      }
    } catch {
      // Nothing to close.
    }
  },
};
