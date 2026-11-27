// Keeps the browser tab's title and icon in step with the store (R2.4, R11.3).
import { store } from './state.svelte';
import { faviconHref, tabTitle } from './tab';

/** The page's `<link rel="icon">`, created if the HTML doesn't have one. */
function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  return link;
}

/**
 * Call once while App initialises. `warning` says whether a health check is failing, which puts
 * `⚠ ` in front of the title (M5 supplies it). The DOM is only touched when a value changes.
 */
export function useTabTitle(warning: () => boolean = () => false): void {
  const running = $derived(store.state?.running != null);

  $effect(() => {
    const title = tabTitle(store.state, store.now, warning());
    if (document.title !== title) {
      document.title = title;
    }
  });

  $effect(() => {
    const href = faviconHref(running);
    const link = iconLink();
    if (link.getAttribute('href') !== href) {
      link.type = 'image/svg+xml';
      link.setAttribute('href', href);
    }
  });
}
