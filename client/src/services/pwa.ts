// PWA install prompt helper & standalone mode detector

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
  prompt(): Promise<void>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<(canInstall: boolean) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    installListeners.forEach((fn) => fn(true));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installListeners.forEach((fn) => fn(false));
  });
}

export function isPwaInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function canInstallPwa(): boolean {
  return deferredPrompt !== null;
}

export function subscribePwaInstallState(callback: (canInstall: boolean) => void): () => void {
  installListeners.add(callback);
  callback(canInstallPwa());
  return () => {
    installListeners.delete(callback);
  };
}

export async function promptPwaInstall(): Promise<boolean> {
  if (!deferredPrompt) {
    return false;
  }
  await deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  installListeners.forEach((fn) => fn(false));
  return choice.outcome === 'accepted';
}

/** Phones and tablets from Apple: no install button there, the Share menu is the way. */
export function isAppleTouchDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/**
 * Asks the browser to look for a newer version of the app. 'updated' means a new version was found and has
 * taken over (reload to use it); 'current' means this is the latest; 'unsupported' means there is no service
 * worker here (for example a private window).
 */
export async function checkForUpdate(timeoutMs = 6000): Promise<'updated' | 'current' | 'unsupported'> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return 'unsupported';
  await reg.update();
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return 'current';
  if (worker.state === 'activated') return 'updated';
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      resolve('updated');
    };
    const timer = setTimeout(done, timeoutMs);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated' || worker.state === 'installed') done();
    });
  });
}
