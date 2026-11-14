import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import { Sidebar } from './components/Sidebar.js';
import { Logo } from './components/Logo.js';
import { MobileTabBar, type PhoneTab } from './components/MobileTabBar.js';
import { ShortcutsSheet } from './components/ShortcutsSheet.js';
import { LabelsManager } from './components/LabelsManager.js';
import { labelsApi, labelErrorText, type Label, type LabelColour } from './services/labels.js';
import { snoozeApi } from './services/snooze.js';
import { threadsApi, type ThreadInfo } from './services/threads.js';
import { Presence } from './components/Presence.js';
import { realUid } from './services/uidKey.js';
import { loadView, parseViewPath, STARRED_PATH, labelPath } from './services/views.js';
import { PendingActions } from './services/pendingActions.js';
import { LruCache, Limiter } from './services/cache.js';
import { actionForKey } from './services/shortcuts.js';
import { snoozeText } from './services/time.js';
import type { ListFilter } from './services/api.js';
import { ConnectionsPanel } from './components/ConnectionsPanel.js';
import { NotificationsPanel } from './components/NotificationsPanel.js';
import {
  currentSubscription,
  pushApi,
  setAppBadge,
  takeOpenTargetFromHash,
  type OpenMessageTarget
} from './services/push.js';
import { MessageList } from './components/MessageList.js';
import { MessageViewer } from './components/MessageViewer.js';
import { ComposerModal, type ComposerReplyMeta } from './components/ComposerModal.js';
import { clearMessageLinkHash, parseMessageLinkHash } from './services/deeplink.js';
import { planReply } from './services/reply.js';
import { ConnectModal } from './components/ConnectModal.js';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog.js';
import { friendlyError } from './services/errors.js';
import { useDialog } from './hooks/useDialog.js';
import { escapeHtml, quoteHtml, bodyOfHtmlDocument } from './services/richtext.js';
import {
  api,
  getActiveHandle,
  setActiveHandle,
  getStoredAccounts,
  syncStoredAccounts,
  findStoredAccount,
  removeStoredAccount,
  touchStoredAccount,
  updateStoredAccountUnread,
  onSessionExpired,
  isSessionEndedError,
  type SearchFilterParams,
  type SessionExpiredDetail
} from './services/api.js';
import {
  showDesktopNotification,
  requestNotificationPermission,
  getNotificationPermission,
  playNotificationChime
} from './services/notifications.js';
import {
  subscribePwaInstallState,
  promptPwaInstall,
  canInstallPwa,
  isPwaInstalled
} from './services/pwa.js';
import type {
  MailboxFolder,
  MessageHeader,
  ParsedEmailMessage,
  UserAccount,
  StoredAccountProfile
} from './types.js';

export const App: React.FC = () => {
  // Authentication & Multi-Account State
  const [account, setAccount] = useState<UserAccount | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [savedAccounts, setSavedAccounts] = useState<StoredAccountProfile[]>([]);
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  // Set when an account's server session ended: shows a sign-in prompt over the app
  // (no reload, so an open composer keeps its text).
  const [reauth, setReauth] = useState<SessionExpiredDetail | null>(null);

  // Mailboxes & Navigation
  const [folders, setFolders] = useState<MailboxFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('INBOX');
  const [filter, setFilter] = useState<ListFilter>('all');
  const [labels, setLabels] = useState<Label[]>([]);
  const [showLabelsManager, setShowLabelsManager] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [menu, setMenu] = useState<'label' | 'snooze' | null>(null);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  // Rows that are leaving (fade and collapse) and rows already gone from the screen but not yet from the server.
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [thread, setThread] = useState<ThreadInfo | null>(null);
  const pending = useRef(new PendingActions()).current;
  const [undoLatest, setUndoLatest] = useState<{ id: number; label: string } | null>(null);
  // In-memory caches: lists per folder and opened messages, so switching back and J/K feel instant.
  const listCache = useRef(new LruCache<{ messages: MessageHeader[]; total: number }>(40)).current;
  const detailCache = useRef(new LruCache<{ detail: ParsedEmailMessage; peeked: boolean }>(40)).current;
  const prefetcher = useRef(new Limiter(2)).current;
  const messagesRef = useRef<MessageHeader[]>([]);
  const visibleRef = useRef<MessageHeader[]>([]);

  // Messages in Current Folder
  const [messages, setMessages] = useState<MessageHeader[]>([]);
  messagesRef.current = messages;
  const visibleMessages = useMemo(() => messages.filter((m) => !hidden.has(m.uid)), [messages, hidden]);
  visibleRef.current = visibleMessages;
  const [totalMessages, setTotalMessages] = useState(0);
  const [page, setPage] = useState(1);
  // What the user typed (searchInput/filterInput) is applied 300 ms after typing stops.
  const [searchInput, setSearchInput] = useState('');
  const [filterInput, setFilterInput] = useState<SearchFilterParams>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilterParams>({});
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const prevUnreadRef = useRef<number | null>(null);

  // Selected Message
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<ParsedEmailMessage | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const detailSeq = useRef(0);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);

  // Selection & Batch Operations
  const [selectedUids, setSelectedUids] = useState<Set<number>>(new Set());

  // Composer
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  // Push notifications are on for this device and the active account: the in-tab poll then stays quiet
  // (the service worker already shows a notification for the same mail).
  const pushActiveRef = useRef(false);
  // A notification was tapped: open that mailbox, folder and message once the account is ready.
  // "#/m/<Message-ID>": a link to one message (Work OS tasks, shared links). Resolved after sign-in.
  const [messageLink, setMessageLink] = useState<string | null>(() => parseMessageLinkHash(window.location.hash));
  const [openTarget, setOpenTarget] = useState<OpenMessageTarget | null>(() => takeOpenTargetFromHash());
  const [composerInitial, setComposerInitial] = useState<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    /** Quoted original / forwarded text as editor HTML (shown below the signature). */
    html?: string;
    meta?: ComposerReplyMeta;
    isDraft?: boolean;
  }>({});
  const [composeId, setComposeId] = useState(0);

  // Toast feedback
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Mobile responsive state
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [mobileView, setMobileView] = useState<'list' | 'message'>('list');
  const drawerRef = useRef<HTMLDivElement>(null);
  useDialog(drawerRef, { open: showMobileSidebar, onEscape: () => setShowMobileSidebar(false) });

  // PWA & Browser Notifications State
  const [isInstalled, setIsInstalled] = useState(() => isPwaInstalled());
  const [notificationPerm, setNotificationPerm] = useState<NotificationPermission>(() => getNotificationPermission());

  useEffect(() => {
    const unsub = subscribePwaInstallState(() => {
      setIsInstalled(isPwaInstalled());
    });
    return unsub;
  }, []);

  const handleInstallApp = async () => {
    if (canInstallPwa()) {
      const success = await promptPwaInstall();
      if (success) {
        showToast('Mailloom app installed successfully!');
        setIsInstalled(true);
      }
    } else {
      const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);
      const isSafari = typeof navigator !== 'undefined' && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      if (isSafari && isMac) {
        showToast('To install in Safari: click File > "Add to Dock".');
      } else {
        showToast('To install: click the Install icon (computer with down arrow) in your browser address bar.');
      }
    }
  };

  const handleRequestNotifications = async () => {
    const perm = await requestNotificationPermission();
    setNotificationPerm(perm);
    if (perm === 'granted') {
      playNotificationChime();
      showDesktopNotification({
        title: 'Notifications Enabled',
        body: 'You will now receive alerts for new incoming emails.'
      });
      showToast('Desktop notifications enabled!');
    } else {
      showToast('Notification permission was not granted.', 'error');
    }
  };

  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), type === 'error' ? 7000 : 3500);
  };

  // 1. Initial Authentication Check: ask the server which accounts this browser is signed in to.
  useEffect(() => {
    setSavedAccounts(getStoredAccounts());
    api
      .getAccounts()
      .then(({ accounts }) => {
        const synced = syncStoredAccounts(accounts);
        setSavedAccounts(synced);
        if (accounts.length === 0) {
          setActiveHandle(null);
          setAccount(null);
          return;
        }
        const current = getActiveHandle();
        const active =
          accounts.find((a) => a.handle === current) ||
          accounts.find((a) => a.handle === synced[0]?.handle) ||
          accounts[0];
        setActiveHandle(active.handle);
        setAccount(active);
      })
      .catch((err: unknown) => {
        setAccount(null);
        showToast(err instanceof Error ? err.message : 'Cannot reach Mailloom.', 'error');
      })
      .finally(() => {
        setIsAuthChecking(false);
      });
  }, []);

  // Session ended on the server (expired, signed out elsewhere): prompt to sign in again.
  useEffect(
    () =>
      onSessionExpired((detail) => {
        setReauth((prev) => (prev && prev.handle === detail.handle ? prev : detail));
      }),
    []
  );

  // 2. Fetch Folders (isolated from selectedFolder changes to prevent duplicate concurrent IMAP locks)
  const selectedFolderRef = useRef(selectedFolder);
  selectedFolderRef.current = selectedFolder;
  /** The real folder a message lives in (views such as Starred hold messages from several folders). */
  const boxOf = (uid: number): string =>
    messagesRef.current.find((m) => m.uid === uid)?.mailbox ??
    (parseViewPath(selectedFolderRef.current) ? 'INBOX' : selectedFolderRef.current);

  const loadFolders = useCallback(async () => {
    if (!account) return;
    try {
      const res = await api.getMailboxes();
      setFolders(res.folders);
      setSyncedAt(new Date());

      // Compute total unread for account badge
      const totalUnread = res.folders.reduce((acc, f) => acc + (f.unreadCount || 0), 0);
      updateStoredAccountUnread(account.email, totalUnread);
      setSavedAccounts(getStoredAccounts());

      if (prevUnreadRef.current === null) {
        const inbox = res.folders.find((f) => f.specialUse === 'Inbox' || f.name.toLowerCase() === 'inbox');
        prevUnreadRef.current = inbox ? inbox.unreadCount || 0 : 0;
      }

      // If selectedFolder doesn't exist in folder list, default to first or INBOX
      if (res.folders.length > 0) {
        const currentPath = selectedFolderRef.current;
        const hasCurrent =
          parseViewPath(currentPath) !== null ||
          res.folders.some(
          (f) => f.path.toLowerCase() === currentPath.toLowerCase()
        );
        if (!hasCurrent) {
          const inbox = res.folders.find((f) => f.specialUse === 'Inbox') || res.folders[0];
          setSelectedFolder(inbox.path);
        }
      }
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The folder list could not be loaded. Try again.'), 'error');
    }
  }, [account]);

  useEffect(() => {
    if (account) {
      loadFolders();
    }
  }, [account, loadFolders]);

  const loadLabels = useCallback(async () => {
    if (!account) return;
    try {
      setLabels(await labelsApi.list());
    } catch {
      // Labels are optional: an older server may not have them, and the rest of the app works without.
    }
  }, [account]);
  useEffect(() => {
    void loadLabels();
  }, [loadLabels]);

  // 3. Fetch Messages for Selected Folder. "silent" reloads (polling) keep the list as it is while loading.
  // A list seen before is shown at once from memory and refreshed quietly behind it.
  const loadSeq = useRef(0);
  const loadMessages = useCallback(
    async (silent = false) => {
      if (!account || !selectedFolder) return;
      const seq = ++loadSeq.current;
      const key = `${account.handle}|${selectedFolder}|${page}|${filter}|${searchTerm}|${JSON.stringify(searchFilters)}`;
      const cached = listCache.get(key);
      if (cached && !silent) {
        setMessages(cached.messages);
        setTotalMessages(cached.total);
      }
      const showLoading = !silent && !cached;
      if (showLoading) setIsMessagesLoading(true);
      try {
        const view = parseViewPath(selectedFolder);
        const res = view
          ? await loadView(view, page, 50)
          : await api.getMessages(selectedFolder, page, 50, searchTerm, searchFilters, filter);
        if (seq !== loadSeq.current) return; // a newer request replaced this one
        listCache.set(key, res);
        setMessages(res.messages);
        setTotalMessages(res.total);
        setSyncedAt(new Date());
      } catch (err: unknown) {
        if (!silent && seq === loadSeq.current) {
          showToast(friendlyError(err, 'The messages could not be loaded. Try again.'), 'error');
        }
      } finally {
        if (showLoading && seq === loadSeq.current) setIsMessagesLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, selectedFolder, page, searchTerm, searchFilters, filter]
  );

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Always-current copies for timers (the 60 s poll must not use stale closures).
  const loadMessagesRef = useRef(loadMessages);
  loadMessagesRef.current = loadMessages;

  // Search waits 300 ms after typing stops.
  const appliedSearchKey = useRef('');
  useEffect(() => {
    const t = setTimeout(() => {
      const key = JSON.stringify([searchInput, filterInput]);
      if (key === appliedSearchKey.current) return;
      appliedSearchKey.current = key;
      setSearchTerm(searchInput);
      setSearchFilters(filterInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filterInput]);

  // Reset pagination & message detail when switching folders
  const handleSelectFolder = (folderPath: string) => {
    if (folderPath.toLowerCase() === selectedFolder.toLowerCase()) return;
    detailSeq.current++; // any detail request still in flight belongs to the old folder
    setIsDetailLoading(false);
    setSelectedFolder(folderPath);
    setFilter('all');
    setMenu(null);
    setThread(null);
    setPage(1);
    setSearchInput('');
    setFilterInput({});
    setSelectedUid(null);
    setSelectedMessage(null);
    setSelectedUids(new Set());
    setShowMobileSidebar(false); // Close sidebar on mobile after folder pick
    setMobileView('list'); // Go back to list view on mobile
  };

  // 4. Select and View Message Detail. Selection moves at once; the body comes from memory when it is there.
  const prefetchAround = (uid: number) => {
    const list = visibleRef.current;
    const i = list.findIndex((m) => m.uid === uid);
    if (i < 0 || !account) return;
    for (const n of [list[i + 1], list[i - 1]]) {
      if (!n) continue;
      const box = n.mailbox ?? boxOf(n.uid);
      const k = `${account.handle}|${box}|${n.uid}`;
      if (detailCache.has(k)) continue;
      // peek: read without marking as read. Bodies only, never attachments.
      void prefetcher
        .run(() => api.getMessageDetail(box, n.uid, { peek: true }))
        .then((d) => detailCache.set(k, { detail: d, peeked: true }))
        .catch(() => undefined);
    }
  };

  const handleSelectMessage = async (uid: number) => {
    const seq = ++detailSeq.current;
    const box = boxOf(uid);
    setSelectedUid(uid);
    setMobileView('message'); // Switch to message view on mobile
    setMenu(null);
    const wasUnread = messagesRef.current.find((m) => m.uid === uid)?.isSeen === false;

    // Optimistically mark as seen in message list
    setMessages((prev) => prev.map((m) => (m.uid === uid ? { ...m, isSeen: true } : m)));

    const ck = `${account?.handle}|${box}|${uid}`;
    const cached = detailCache.get(ck);
    if (cached) {
      setIsDetailLoading(false);
      setSelectedMessage({ ...cached.detail, uid });
      if (cached.peeked && wasUnread) {
        detailCache.set(ck, { detail: cached.detail, peeked: false });
        api.toggleFlag(box, uid, 'isSeen', true).then(() => loadFolders()).catch(() => undefined);
      }
      prefetchAround(uid);
      return;
    }

    setIsDetailLoading(true);
    try {
      const detail = await api.getMessageDetail(box, uid);
      if (seq !== detailSeq.current) return; // the user already opened another message
      detailCache.set(ck, { detail, peeked: false });
      setSelectedMessage({ ...detail, uid });
      // Refresh folder counts
      loadFolders();
      prefetchAround(uid);
    } catch (err: unknown) {
      if (seq === detailSeq.current) {
        showToast(friendlyError(err, 'This message could not be opened. Try again.'), 'error');
      }
    } finally {
      if (seq === detailSeq.current) setIsDetailLoading(false);
    }
  };
  useEffect(() => {
    setThread(null);
    const m = messagesRef.current.find((x) => x.uid === selectedUid);
    if (!account || !selectedMessage || !m?.threadId || !m.threadCount || m.threadCount < 2) return;
    let alive = true;
    threadsApi
      .get(m.threadId, boxOf(m.uid))
      .then((t) => alive && setThread(t))
      .catch(() => undefined); // the conversation is a bonus: the message itself is already shown
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMessage?.uid, selectedUid, account]);

  const handleSelectMessageRef = useRef(handleSelectMessage);
  handleSelectMessageRef.current = handleSelectMessage;

  const handleShowImages = async (uid: number) => {
    const seq = detailSeq.current; // same guard as handleSelectMessage: a newer open or folder switch wins
    const folder = boxOf(uid);
    setIsLoadingImages(true);
    try {
      const detail = await api.getMessageDetail(folder, uid, { showImages: true });
      if (seq !== detailSeq.current) return;
      setSelectedMessage({ ...detail, uid });
    } catch (err: unknown) {
      if (seq === detailSeq.current) {
        showToast(friendlyError(err, 'The images could not be loaded. Try again.'), 'error');
      }
    } finally {
      setIsLoadingImages(false);
    }
  };

  // 5. Toggle Flag (Star or Read/Unread)
  const handleToggleFlag = async (
    uid: number,
    flag: 'isSeen' | 'isFlagged',
    e?: React.MouseEvent
  ) => {
    if (e) e.stopPropagation();

    const targetMsg = messages.find((m) => m.uid === uid);
    const currentValue = flag === 'isSeen' ? targetMsg?.isSeen : targetMsg?.isFlagged;
    const newValue = !currentValue;

    detailCache.clear();
    listCache.clear();
    // Optimistic UI updates
    setMessages((prev) =>
      prev.map((m) => (m.uid === uid ? { ...m, [flag]: newValue } : m))
    );
    if (selectedMessage && selectedMessage.uid === uid) {
      setSelectedMessage({ ...selectedMessage, [flag]: newValue });
    }

    try {
      await api.toggleFlag(boxOf(uid), uid, flag, newValue);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The change could not be saved. Try again.'), 'error');
      // Revert on failure
      loadMessages();
    }
  };

  useEffect(() => {
    const unsub = pending.subscribe(() => setUndoLatest(pending.latest));
    const flush = () => void pending.flush();
    window.addEventListener('pagehide', flush);
    return () => {
      unsub();
      window.removeEventListener('pagehide', flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedFolderKind = folders.find((f) => f.path === selectedFolder)?.specialUse;

  const clearSelectionIf = (uids: number[]) => {
    if (selectedUid !== null && uids.includes(selectedUid)) {
      setSelectedUid(null);
      setSelectedMessage(null);
      setMobileView('list'); // the message is gone: on a phone, go back to the list
    }
  };

  // Optimistic removal (archive, delete, snooze, move): the row fades and collapses at once, the next mail opens,
  // and an Undo toast stays for 6 s. The server call waits for that window; if it fails the row comes back.
  const scheduleRemoval = (uids: number[], label: string, run: () => Promise<void>, failText?: (err: unknown) => string | null) => {
    const reopen =
      selectedUid !== null && uids.includes(selectedUid)
        ? (() => {
            const list = visibleRef.current;
            const i = list.findIndex((m) => uids.includes(m.uid));
            const rest = list.filter((m) => !uids.includes(m.uid));
            return rest[Math.min(i, rest.length - 1)]?.uid ?? null;
          })()
        : undefined;
    let undone = false;
    const drop = (set: Set<number>) => {
      const n = new Set(set);
      uids.forEach((u) => n.delete(u));
      return n;
    };
    pending.schedule({
      label,
      apply: () => {
        setLeaving((p) => new Set([...p, ...uids]));
        setTimeout(() => {
          if (undone) return;
          setHidden((p) => new Set([...p, ...uids]));
          setLeaving(drop);
        }, 170);
      },
      restore: () => {
        undone = true;
        setLeaving(drop);
        setHidden(drop);
      },
      run,
      onDone: () => {
        listCache.clear();
        setMessages((prev) => prev.filter((m) => !uids.includes(m.uid)));
        setHidden(drop);
        setTotalMessages((t) => Math.max(0, t - uids.length));
        loadFolders();
        void loadLabels();
      },
      onFail: (err) =>
        showToast(failText?.(err) ?? friendlyError(err, 'That did not work, so the message is back. Try again.'), 'error')
    });
    if (reopen !== undefined) {
      if (reopen !== null) void handleSelectMessage(reopen);
      else {
        detailSeq.current++;
        setSelectedUid(null);
        setSelectedMessage(null);
        setMobileView('list');
      }
    }
  };

  const archiveFolder = folders.find((f) => f.specialUse === 'Archive');
  const inStarredView = selectedFolder === STARRED_PATH;
  const handleArchive = (uid: number, mailbox?: string) => {
    if (!archiveFolder) {
      showToast('There is no Archive folder in this mailbox.', 'error');
      return;
    }
    const box = mailbox ?? boxOf(uid);
    if (box.toLowerCase() === archiveFolder.path.toLowerCase()) return;
    scheduleRemoval([uid], 'Archived', async () => {
      const r = await api.moveMessage(box, uid, archiveFolder.path);
      if (!r.success) throw new Error('The message could not be archived.');
    });
  };

  const handleSnooze = (uid: number, until: Date, mailbox?: string) => {
    const box = mailbox ?? boxOf(uid);
    setMenu(null);
    scheduleRemoval([uid], `Snoozed until ${snoozeText(until)}`, async () => {
      const r = await snoozeApi.snooze(box, [uid], until);
      if (!r.success) throw new Error('The message could not be snoozed.');
    }, (err) => ((err as { status?: number } | null)?.status === 422 ? "This mail can't be snoozed" : null));
  };

  const handleToggleLabel = async (labelId: string, turnOn: boolean, uid: number | null = selectedUid) => {
    if (uid === null) return;
    const box = boxOf(uid);
    const apply = (on: boolean) =>
      setMessages((prev) =>
        prev.map((m) => {
          if (m.uid !== uid) return m;
          const rest = (m.labels ?? []).filter((id) => id !== labelId);
          return { ...m, labels: on ? [...rest, labelId] : rest };
        })
      );
    apply(turnOn);
    try {
      const r = await labelsApi.apply(box, [uid], turnOn ? [labelId] : [], turnOn ? [] : [labelId]);
      if (!r.success) throw new Error('The label could not be changed.');
      listCache.clear();
      void loadLabels();
    } catch (err: unknown) {
      apply(!turnOn);
      showToast(friendlyError(err, 'The label could not be changed. Try again.'), 'error');
    }
  };

  const handleCreateLabel = async (name: string, colour: LabelColour, applyToOpen = true): Promise<string | null> => {
    try {
      const l = await labelsApi.create(name, colour);
      setLabels((p) => [...p, { ...l, count: l.count ?? 0 }]);
      setMenu(null);
      if (applyToOpen && selectedUid !== null) await handleToggleLabel(l.id, true);
      return null;
    } catch (err: unknown) {
      return labelErrorText(err, friendlyError(err, 'The label could not be created. Try again.'));
    }
  };

  const handleRenameLabel = async (id: string, name: string): Promise<string | null> => {
    try {
      await labelsApi.update(id, { name });
      await loadLabels();
      return null;
    } catch (err: unknown) {
      void loadLabels();
      return labelErrorText(err, friendlyError(err, 'The label could not be renamed. Try again.'));
    }
  };
  const handleMoveLabel = async (id: string, position: number) => {
    const before = labels;
    const from = before.findIndex((l) => l.id === id);
    if (from < 0 || position < 0 || position >= before.length) return;
    const next = [...before];
    const [item] = next.splice(from, 1);
    next.splice(position, 0, item);
    setLabels(next);
    try {
      await labelsApi.update(id, { order: position });
    } catch (err: unknown) {
      setLabels(before);
      showToast(friendlyError(err, 'The labels could not be reordered. Try again.'), 'error');
    }
  };
  const handleRecolourLabel = async (id: string, colour: LabelColour) => {
    setLabels((p) => p.map((l) => (l.id === id ? { ...l, colour } : l)));
    try {
      await labelsApi.update(id, { colour });
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The colour could not be changed. Try again.'), 'error');
      void loadLabels();
    }
  };
  const handleDeleteLabel = async (id: string) => {
    try {
      await labelsApi.remove(id);
      listCache.clear();
      if (selectedFolder === labelPath(id)) handleSelectFolder('INBOX');
      await loadLabels();
      loadMessages(true);
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The label could not be deleted. Try again.'), 'error');
    }
  };

  /** "Not delivered": reopen the original (from Sent) as a new message. */
  const handleRetryBounce = async () => {
    const b = messagesRef.current.find((m) => m.uid === selectedUid)?.bounce;
    // Only the server-supplied location of the original is used. The bounce's own subject and
    // recipient text can be spoofed, so the new mail is never built from them.
    if (!b || !b.retryable || !b.sentMailbox || typeof b.sentUid !== 'number') {
      showToast('The original message could not be found in Sent.', 'error');
      return;
    }
    try {
      const d = await api.getMessageDetail(b.sentMailbox, b.sentUid, { peek: true });
      openComposer({
        to: d.to.map((a) => a.address).filter(Boolean),
        cc: (d.cc || []).map((a) => a.address).filter(Boolean),
        subject: d.subject,
        body: d.text || '',
        html: d.html ? bodyOfHtmlDocument(d.html) : undefined
      });
    } catch {
      showToast('The original message could not be found in Sent.', 'error');
    }
  };

  // 6. Delete Message: to Trash; inside Trash it is permanent and asks first.
  const performDeleteNow = async (uid: number) => {
    try {
      const r = await api.deleteMessage(boxOf(uid), uid);
      if (!r.success) throw new Error('The message could not be deleted.');
      showToast(r.permanent ? 'Message deleted permanently' : 'Moved to Trash');
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      clearSelectionIf([uid]);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The message could not be deleted. Try again.'), 'error');
      loadMessages(true);
    }
  };

  const performDelete = (uid: number) => {
    if (selectedFolderKind === 'Trash') return performDeleteNow(uid);
    const box = boxOf(uid);
    scheduleRemoval([uid], 'Moved to Trash', async () => {
      const r = await api.deleteMessage(box, uid);
      if (!r.success) throw new Error('The message could not be deleted.');
    });
  };

  const handleDeleteMessage = (uid: number) => {
    if (selectedFolderKind === 'Trash') {
      setConfirmRequest({
        title: 'Delete forever?',
        message: 'This message will be permanently deleted. This cannot be undone.',
        confirmLabel: 'Delete forever',
        danger: true,
        onConfirm: () => performDelete(uid)
      });
    } else {
      performDelete(uid);
    }
  };

  const handleRestoreMessage = async (uid: number) => {
    try {
      const r = await api.restoreMessage(boxOf(uid), uid);
      if (!r.success) throw new Error('The message could not be restored.');
      showToast('Restored to Inbox');
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      clearSelectionIf([uid]);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The message could not be restored. Try again.'), 'error');
      loadMessages(true);
    }
  };

  const handleNotSpam = async (uid: number) => {
    try {
      const r = await api.notSpam(boxOf(uid), uid);
      if (!r.success) throw new Error('The message could not be moved.');
      showToast('Moved back to Inbox');
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      clearSelectionIf([uid]);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The message could not be moved. Try again.'), 'error');
      loadMessages(true);
    }
  };

  const handleEmptyFolder = () => {
    const folderName = folders.find((f) => f.path === selectedFolder)?.name || selectedFolder;
    setConfirmRequest({
      title: `Empty ${folderName}?`,
      message: `Every message in ${folderName} will be permanently deleted. This cannot be undone.`,
      confirmLabel: `Delete all`,
      danger: true,
      onConfirm: async () => {
        try {
          const r = await api.emptyFolder(selectedFolder);
          if (!r.success) throw new Error('The folder could not be emptied.');
          showToast(`${r.deleted} message${r.deleted === 1 ? '' : 's'} deleted permanently`);
          setSelectedUid(null);
          setSelectedMessage(null);
        } catch (err: unknown) {
          showToast(friendlyError(err, 'The folder could not be emptied. Try again.'), 'error');
        } finally {
          loadMessages();
          loadFolders();
        }
      }
    });
  };

  // 7. Move Message
  const handleMoveMessage = (uid: number, targetFolder: string) => {
    const box = boxOf(uid);
    const name = folders.find((f) => f.path === targetFolder)?.name || targetFolder;
    scheduleRemoval([uid], `Moved to ${name}`, async () => {
      const r = await api.moveMessage(box, uid, targetFolder);
      if (!r.success) throw new Error('The message could not be moved.');
    });
  };

  // 8. Batch Operations. Each message is tried; the result says exactly what happened.
  const handleToggleSelectUid = (uid: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const handleSelectAll = () => {
    const allSelected = messages.length > 0 && messages.every((m) => selectedUids.has(m.uid));
    if (allSelected) {
      setSelectedUids(new Set());
    } else {
      setSelectedUids(new Set(messages.map((m) => m.uid)));
    }
  };

  const runBatch = async (uids: number[], op: (uid: number) => Promise<{ success?: boolean } | unknown>) => {
    const done: number[] = [];
    const failed: number[] = [];
    const errors: string[] = [];
    for (const uid of uids) {
      try {
        const r = (await op(uid)) as { success?: boolean } | undefined;
        if (r && r.success === false) throw new Error('The server did not do it.');
        done.push(uid);
      } catch (err: unknown) {
        failed.push(uid);
        errors.push(friendlyError(err, 'Try again in a moment.'));
      }
    }
    return { done, failed, errors };
  };

  // Says exactly what happened: all done, some done (the failed ones stay selected to retry), or none.
  const finishBatch = (
    past: string,
    total: number,
    r: { done: number[]; failed: number[]; errors: string[] },
    remove = true
  ) => {
    const n = (c: number) => `${c} message${c === 1 ? '' : 's'}`;
    if (r.failed.length === 0) showToast(`${past}: ${n(r.done.length)}.`);
    else if (r.done.length === 0) showToast(`Nothing was changed for ${n(total)}. ${r.errors[0]}`, 'error');
    else showToast(`${past}: ${r.done.length} of ${n(total)}. ${r.failed.length} could not be done and stay selected. ${r.errors[0]}`, 'error');
    setSelectedUids(new Set(r.failed));
    if (remove) {
      setMessages((prev) => prev.filter((m) => !r.done.includes(m.uid)));
      clearSelectionIf(r.done);
    }
    loadMessages();
    loadFolders();
  };

  const performBatchDelete = async (uids: number[], permanent: boolean) => {
    const r = await runBatch(uids, (uid) => api.deleteMessage(boxOf(uid), uid));
    finishBatch(permanent ? 'Deleted forever' : 'Moved to Trash', uids.length, r);
  };

  const handleBatchDelete = () => {
    const uids = Array.from(selectedUids);
    if (uids.length === 0) return;
    if (selectedFolderKind === 'Trash') {
      setConfirmRequest({
        title: `Delete ${uids.length} message${uids.length === 1 ? '' : 's'} forever?`,
        message: 'They will be permanently deleted. This cannot be undone.',
        confirmLabel: 'Delete forever',
        danger: true,
        onConfirm: () => performBatchDelete(uids, true)
      });
    } else {
      performBatchDelete(uids, false);
    }
  };

  const handleBatchMarkRead = async (isSeen: boolean) => {
    const uids = Array.from(selectedUids);
    const r = await runBatch(uids, (uid) => api.toggleFlag(boxOf(uid), uid, 'isSeen', isSeen));
    finishBatch(isSeen ? 'Marked as read' : 'Marked as unread', uids.length, r, false);
    setMessages((prev) => prev.map((m) => (r.done.includes(m.uid) ? { ...m, isSeen } : m)));
  };

  const getJunkFolderPath = () => {
    return (
      folders.find(
        (f) =>
          f.specialUse === 'Junk' ||
          f.name.toLowerCase() === 'junk' ||
          f.name.toLowerCase() === 'spam'
      )?.path || 'Junk'
    );
  };

  const handleMarkSpam = async (uid: number) => {
    try {
      const junkFolder = getJunkFolderPath();
      const r = await api.markSpam(boxOf(uid), uid, junkFolder);
      if (!r.success) throw new Error('The message could not be moved to Junk.');
      showToast('Moved to Junk & marked as read');
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      clearSelectionIf([uid]);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The message could not be moved to Junk. Try again.'), 'error');
      loadMessages(true);
    }
  };

  const handleBatchSpam = async () => {
    const uids = Array.from(selectedUids);
    const junkFolder = getJunkFolderPath();
    const r = await runBatch(uids, (uid) => api.markSpam(boxOf(uid), uid, junkFolder));
    finishBatch('Moved to Junk', uids.length, r);
  };

  const handleBatchRestore = async () => {
    const uids = Array.from(selectedUids);
    if (uids.length === 0) return;
    const r = await runBatch(uids, (uid) => api.restoreMessage(boxOf(uid), uid));
    finishBatch('Restored to Inbox', uids.length, r);
  };

  const handleBatchNotSpam = async () => {
    const uids = Array.from(selectedUids);
    if (uids.length === 0) return;
    const r = await runBatch(uids, (uid) => api.notSpam(boxOf(uid), uid));
    finishBatch('Moved back to Inbox', uids.length, r);
  };

  // 9. Reply & Forward Composer Hooks
  const openComposer = (initial: typeof composerInitial) => {
    setComposerInitial(initial);
    setComposeId((n) => n + 1); // fresh form: nothing left from the previous message
    setIsComposerOpen(true);
  };

  const handleReply = (message: ParsedEmailMessage, replyAll = false) => {
    const plan = planReply(message, account?.email || '', replyAll);
    const dateStr = new Date(message.date).toLocaleString();
    const quote = `\n\n--- On ${dateStr}, ${message.from.name || message.from.address} wrote: ---\n> ${
      message.text ? message.text.replace(/\n/g, '\n> ') : ''
    }`;

    openComposer({
      to: plan.to,
      cc: plan.cc,
      subject: plan.subject,
      body: quote,
      html:
        `<p>${escapeHtml(`On ${dateStr}, ${message.from.name || message.from.address} wrote:`)}</p>` +
        quoteHtml(message.text || ''),
      meta: { inReplyTo: plan.inReplyTo, references: plan.references }
    });
  };

  const handleForward = (message: ParsedEmailMessage) => {
    const dateStr = new Date(message.date).toLocaleString();
    const forwardHeader = `\n\n---------- Forwarded message ---------\nFrom: ${message.from.name || ''} <${
      message.from.address
    }>\nDate: ${dateStr}\nSubject: ${message.subject}\nTo: ${message.to
      .map((t) => t.address)
      .join(', ')}\n\n${message.text || ''}`;

    const real = message.attachments.filter((a) => !a.isInline);
    openComposer({
      to: [],
      subject: /^fwd?:/i.test(message.subject) ? message.subject : `Fwd: ${message.subject}`,
      body: forwardHeader,
      html:
        `<p>${[
          '---------- Forwarded message ---------',
          `From: ${message.from.name || ''} <${message.from.address}>`,
          `Date: ${dateStr}`,
          `Subject: ${message.subject}`,
          `To: ${message.to.map((t) => t.address).join(', ')}`
        ]
          .map(escapeHtml)
          .join('<br>')}</p>` + quoteHtml(message.text || ''),
      meta: {
        forwardOf: { folder: boxOf(message.uid), uid: realUid(message.uid) },
        forwardedAttachmentNames: real.map((a) => a.filename)
      }
    });
  };

  const handleEditDraft = (message: ParsedEmailMessage) => {
    const refs = message.references || [];
    openComposer({
      to: message.to.map((a) => a.address).filter(Boolean),
      cc: (message.cc || []).map((a) => a.address).filter(Boolean),
      bcc: (message.bcc || []).map((a) => a.address).filter(Boolean),
      subject: message.subject === '(No Subject)' ? '' : message.subject,
      body: message.text || '',
      // A draft written in the rich editor comes back as HTML (with its pictures); a plain one stays plain.
      html: message.html ? bodyOfHtmlDocument(message.html) : undefined,
      isDraft: true,
      meta: {
        draftUid: realUid(message.uid),
        inReplyTo: refs.length > 0 ? refs[refs.length - 1] : undefined,
        references: refs.length > 0 ? refs : undefined
      }
    });
  };

  // 10. Multi-Account Management
  const resetMailView = () => {
    setFolders([]);
    setMessages([]);
    setSelectedUid(null);
    setSelectedMessage(null);
    setSelectedFolder('INBOX');
    prevUnreadRef.current = null;
  };

  const handleConnected = (acc: UserAccount, _rememberMe: boolean) => {
    // api.connect() already stored the profile and made this account active.
    const wasReauth = reauth !== null;
    const sameAccount = account?.email.toLowerCase() === acc.email.toLowerCase();
    if (!sameAccount) resetMailView();
    setAccount(acc);
    setSavedAccounts(getStoredAccounts());
    setIsAddingAccount(false);
    setReauth(null);
    showToast(wasReauth ? 'Signed in again' : isAddingAccount ? `Added mailbox ${acc.email}` : 'Connected successfully');
  };

  const handleSwitchAccount = async (targetEmail: string) => {
    const target = findStoredAccount(targetEmail);
    if (!target) return;

    setIsMessagesLoading(true);
    try {
      const res = await api.getCurrentUser(target.handle);
      setActiveHandle(res.account.handle);
      touchStoredAccount(res.account.handle);
      resetMailView();
      setAccount(res.account);
      setSavedAccounts(getStoredAccounts());
      showToast(`Switched to ${targetEmail}`);
    } catch (err) {
      // A 401 also raises the sign-in prompt for that account.
      showToast(`Couldn't sign in to ${targetEmail}. ${friendlyError(err)}`, 'error');
    } finally {
      setIsMessagesLoading(false);
    }
  };

  /** Signs one account out on the server. Returns false (and says why) if that failed. */
  const signOutAccount = async (handle: string, email: string): Promise<boolean> => {
    try {
      const endpoint = (await currentSubscription())?.endpoint ?? null;
      await api.logout(handle, endpoint);
      return true;
    } catch (err) {
      showToast(`Could not sign out of ${email}: ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
      return false;
    }
  };

  const showRemainingOrSignIn = (remaining: StoredAccountProfile[]) => {
    setSavedAccounts(remaining);
    if (remaining.length > 0) {
      handleSwitchAccount(remaining[0].email);
    } else {
      setActiveHandle(null);
      setAccount(null);
      resetMailView();
    }
  };

  const handleRemoveAccount = async (targetEmail: string) => {
    const target = findStoredAccount(targetEmail);
    if (!target) return;
    if (!(await signOutAccount(target.handle, targetEmail))) return;
    showToast(`Signed out of ${targetEmail}`);

    // If the active account was removed, switch to the next one or show sign-in.
    if (account?.email.toLowerCase() === targetEmail.toLowerCase()) {
      showRemainingOrSignIn(getStoredAccounts());
    } else {
      setSavedAccounts(getStoredAccounts());
    }
  };

  // Closing the re-sign-in prompt without signing in: forget that account in this browser.
  const handleCancelReauth = () => {
    const ended = reauth;
    setReauth(null);
    if (!ended) return;
    removeStoredAccount(ended.handle);
    const endedIsActive = !ended.email || account?.email.toLowerCase() === ended.email.toLowerCase();
    if (endedIsActive) {
      showRemainingOrSignIn(getStoredAccounts());
    } else {
      setSavedAccounts(getStoredAccounts());
    }
  };

  // 11. Desktop Notifications & 60s Background Polling
  useEffect(() => {
    if (!account) return;

    const interval = setInterval(async () => {
      try {
        const folderRes = await api.getMailboxes();
        const inbox = folderRes.folders.find(
          (f) => f.specialUse === 'Inbox' || f.name.toLowerCase() === 'inbox'
        );
        const currentUnread = inbox ? inbox.unreadCount || 0 : 0;

        // If unread count has increased compared to last poll
        if (prevUnreadRef.current !== null && currentUnread > prevUnreadRef.current) {
          const freshInbox = await api.getMessages('INBOX', 1, 1);
          const newest = freshInbox.messages[0];
          if (newest && !newest.isSeen && !pushActiveRef.current) {
            showDesktopNotification({
              title: `New Email from ${newest.from.name || newest.from.address}`,
              body: newest.subject || '(No subject)',
              onClick: () => {
                setSelectedFolder('INBOX');
                handleSelectMessageRef.current(newest.uid);
              }
            });
          }
        }

        prevUnreadRef.current = currentUnread;
        setFolders(folderRes.folders);
        const totalUnread = folderRes.folders.reduce((acc, f) => acc + (f.unreadCount || 0), 0);
        updateStoredAccountUnread(account.email, totalUnread);
        setSavedAccounts(getStoredAccounts());
        // New mail appears in the open list without a manual refresh (always the latest loader).
        await loadMessagesRef.current(true);
      } catch {
        // Silently ignore background polling errors
      }
    }, 60000); // 60 seconds interval

    return () => clearInterval(interval);
  }, [account]);

  // 11b. Unread count of the active account's inbox in the tab title and on the app icon.
  const inboxUnread = folders.find((f) => f.specialUse === 'Inbox' || f.path.toUpperCase() === 'INBOX')?.unreadCount ?? 0;
  useEffect(() => {
    const base = 'Mailloom · Delpat Webmail';
    document.title = account && inboxUnread > 0 ? `(${inboxUnread}) ${base}` : base;
    if (account) setAppBadge(inboxUnread);
  }, [account, inboxUnread]);

  // 11c. Is push on for this device and account? Checked on account change and after the settings close.
  useEffect(() => {
    pushActiveRef.current = false;
    if (!account || showNotifications) return;
    let cancelled = false;
    void (async () => {
      const sub = await currentSubscription();
      if (!sub) return;
      try {
        const { device } = await pushApi.device(sub.endpoint);
        if (!cancelled) pushActiveRef.current = device?.status === 'on';
      } catch {
        // Not important: worst case a second notification while the tab is open.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, showNotifications]);

  // 11d. Messages from the service worker: a notification was tapped, or new mail arrived.
  const loadFoldersRef = useRef(loadFolders);
  loadFoldersRef.current = loadFolders;
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; mailbox?: unknown; folder?: unknown; uid?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'mailloom:open' && typeof data.mailbox === 'string') {
        setOpenTarget({
          mailbox: data.mailbox,
          folder: typeof data.folder === 'string' ? data.folder : 'INBOX',
          uid: typeof data.uid === 'number' && data.uid > 0 ? data.uid : null
        });
      } else if (data.type === 'mailloom:new-mail') {
        void loadFoldersRef.current();
        void loadMessagesRef.current(true);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const id = parseMessageLinkHash(window.location.hash);
      if (id) setMessageLink(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!messageLink || isAuthChecking || !account) return;
    let cancelled = false;
    (async () => {
      try {
        const where = await api.locateMessage(messageLink);
        if (cancelled) return;
        clearMessageLinkHash();
        setMessageLink(null);
        if (where) setOpenTarget({ mailbox: account.email, folder: where.folder, uid: where.uid });
        else setToast({ message: 'This message was moved or deleted', type: 'error' });
      } catch (err) {
        if (cancelled || isSessionEndedError(err)) return; // the sign-in prompt runs; the link stays for afterwards
        clearMessageLinkHash();
        setMessageLink(null);
        setToast({ message: 'Could not look up this message. Please try again.', type: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [messageLink, account, isAuthChecking]);

  useEffect(() => {
    if (!openTarget || isAuthChecking || !account) return;
    if (account.email.toLowerCase() !== openTarget.mailbox.toLowerCase()) {
      if (findStoredAccount(openTarget.mailbox)) void handleSwitchAccount(openTarget.mailbox);
      else setOpenTarget(null); // not signed in to that mailbox in this browser
      return;
    }
    if (selectedFolder.toLowerCase() !== openTarget.folder.toLowerCase()) {
      handleSelectFolder(openTarget.folder);
      return;
    }
    const uid = openTarget.uid;
    setOpenTarget(null);
    if (uid) void handleSelectMessageRef.current(uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTarget, account, selectedFolder, isAuthChecking]);

  // 12. Logout Active Account (this browser only; other devices stay signed in)
  const handleLogout = async () => {
    if (!account) return;
    if (!(await signOutAccount(account.handle, account.email))) return;
    showRemainingOrSignIn(getStoredAccounts());
  };

  // Keyboard shortcuts. Always-current handler; the listener is added once.
  const kbRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  kbRef.current = (e: KeyboardEvent) => {
    if (!account) return;
    const blocked =
      isComposerOpen || !!confirmRequest || showConnections || showNotifications || showLabelsManager ||
      isAddingAccount || !!reauth || showShortcuts || menu !== null || showMobileSidebar;
    const action = actionForKey(e, { blocked });
    if (!action) return;
    const uid = selectedUid;
    const list = visibleRef.current;
    const go = (delta: number) => {
      const i = uid === null ? (delta > 0 ? -1 : list.length) : list.findIndex((m) => m.uid === uid);
      const target = list[Math.max(0, Math.min(list.length - 1, i + delta))];
      if (!target || target.uid === uid) return;
      void handleSelectMessage(target.uid);
      requestAnimationFrame(() =>
        document.querySelector(`[data-row-open="${target.uid}"]`)?.scrollIntoView({ block: 'nearest' })
      );
    };
    switch (action) {
      case 'write':
        openComposer({});
        break;
      case 'search':
        setMobileView('list');
        document.querySelector<HTMLInputElement>('[data-search-input]')?.focus();
        break;
      case 'help':
        setShowShortcuts((v) => !v);
        break;
      case 'next':
        go(1);
        break;
      case 'prev':
        go(-1);
        break;
      case 'open':
        if (uid !== null) setMobileView('message');
        break;
      case 'close':
        if (mobileView === 'message') setMobileView('list');
        else return;
        break;
      case 'undo':
        pending.undo();
        break;
      default: {
        if (uid === null) return;
        if (action === 'archive') {
          if (inStarredView) return;
          handleArchive(uid);
        } else if (action === 'snooze') setMenu('snooze');
        else if (action === 'label') setMenu('label');
        else if (action === 'star') void handleToggleFlag(uid, 'isFlagged');
        else if (action === 'unread') void handleToggleFlag(uid, 'isSeen');
        else if (action === 'delete') handleDeleteMessage(uid);
        else if (selectedMessage && selectedMessage.uid === uid) {
          if (action === 'reply') handleReply(selectedMessage, false);
          else if (action === 'replyAll') handleReply(selectedMessage, true);
          else if (action === 'forward') handleForward(selectedMessage);
        }
      }
    }
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => kbRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (isAuthChecking) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-rail text-rail-ink">
        <div className="flex flex-col items-center gap-3">
          <Logo size={40} />
          <span className="text-xs font-semibold text-rail-2">Launching Mailloom...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden bg-surface text-ink font-sans"
      style={{ height: '100dvh' }}
    >
      {!account ? (
        <ConnectModal
          onConnected={handleConnected}
          canInstall={!isInstalled}
          onInstallApp={handleInstallApp}
          notificationPermission={notificationPerm}
          onRequestNotifications={handleRequestNotifications}
        />
      ) : (
        <div className="flex-1 flex overflow-hidden relative">
          {/* Mobile/Tablet Sidebar Overlay */}
          {showMobileSidebar && (
            <div
              className="fixed inset-0 bg-scrim anim-scrim z-40 lg:hidden"
              onClick={() => setShowMobileSidebar(false)}
            />
          )}

          {/* Left Pane: Mailbox Navigation & Multi-Account Switcher */}
          <div
            ref={drawerRef}
            role={showMobileSidebar ? 'dialog' : undefined}
            aria-modal={showMobileSidebar ? true : undefined}
            aria-label={showMobileSidebar ? 'Folders and accounts' : undefined}
            className={`
              fixed inset-y-0 left-0 z-50 w-56 transform transition-[transform,visibility] duration-[220ms] ease-out shadow-2xl lg:shadow-none
              lg:relative lg:translate-x-0 lg:z-auto
              ${showMobileSidebar ? 'translate-x-0' : '-translate-x-full max-lg:invisible'}
            `}
          >
            <Sidebar
              labels={labels}
              onManageLabels={() => {
                setShowLabelsManager(true);
                setShowMobileSidebar(false);
              }}
              syncedAt={syncedAt}
              account={account}
              folders={folders}
              selectedFolder={selectedFolder}
              onSelectFolder={handleSelectFolder}
              onOpenComposer={() => {
                openComposer({});
                setShowMobileSidebar(false);
              }}
              onLogout={handleLogout}
              savedAccounts={savedAccounts}
              onSwitchAccount={handleSwitchAccount}
              onAddAccount={() => setIsAddingAccount(true)}
              onRemoveAccount={handleRemoveAccount}
              canInstall={!isInstalled}
              onInstallApp={handleInstallApp}
              notificationPermission={notificationPerm}
              onRequestNotifications={handleRequestNotifications}
              onCloseMobileSidebar={() => setShowMobileSidebar(false)}
              onOpenConnections={() => {
                setShowConnections(true);
                setShowMobileSidebar(false);
              }}
              onOpenNotifications={() => {
                setShowNotifications(true);
                setShowMobileSidebar(false);
              }}
            />
          </div>

          <main className="flex-1 flex min-w-0 overflow-hidden relative">
          {/* Middle Pane: Message List */}
          <div
            className={`
              list-pane flex-1 md:flex-none md:w-[320px] lg:w-[360px] xl:w-[408px] min-w-0 h-full block
            `}
            data-covered={mobileView === 'message'}
          >
            <MessageList
              folderName={
                folders.find((f) => f.path.toLowerCase() === selectedFolder.toLowerCase())?.name ||
                selectedFolder
              }
              messages={visibleMessages}
              leavingUids={leaving}
              labels={labels}
              filter={filter}
              onFilterChange={
                parseViewPath(selectedFolder)
                  ? undefined
                  : (f) => {
                      setFilter(f);
                      setPage(1);
                    }
              }
              unreadCount={folders.find((f) => f.path.toLowerCase() === selectedFolder.toLowerCase())?.unreadCount ?? 0}
              onArchive={archiveFolder && !inStarredView ? handleArchive : undefined}
              onSnooze={handleSnooze}
              totalMessages={totalMessages}
              selectedUid={selectedUid}
              onSelectMessage={handleSelectMessage}
              selectedUids={selectedUids}
              onToggleSelectUid={handleToggleSelectUid}
              onSelectAll={handleSelectAll}
              onToggleFlag={handleToggleFlag}
              onRefresh={() => {
                loadMessages();
                loadFolders();
              }}
              folderKind={selectedFolderKind}
              onEmptyFolder={handleEmptyFolder}
              isLoading={isMessagesLoading}
              searchTerm={searchInput}
              onSearchChange={setSearchInput}
              filters={filterInput}
              onFiltersChange={setFilterInput}
              onBatchDelete={handleBatchDelete}
              onBatchMarkRead={handleBatchMarkRead}
              onBatchSpam={handleBatchSpam}
              onBatchRestore={handleBatchRestore}
              onBatchNotSpam={handleBatchNotSpam}
              isVisible={mobileView === 'list'}
              page={page}
              limit={50}
              onPageChange={setPage}
              onOpenMobileSidebar={() => setShowMobileSidebar(true)}
            />
          </div>

          {/* Right Pane: Message Viewer */}
          <div
            className="reader-pane flex-1 min-w-0 flex bg-sheet"
            data-open={mobileView === 'message'}
          >
            <MessageViewer
              folderPath={selectedUid !== null ? boxOf(selectedUid) : selectedFolder}
              message={selectedMessage}
              isLoading={isDetailLoading}
              onToggleFlag={(uid, flag) => handleToggleFlag(uid, flag)}
              onDelete={handleDeleteMessage}
              onMove={handleMoveMessage}
              onMarkSpam={handleMarkSpam}
              folderKind={selectedFolderKind}
              onRestore={handleRestoreMessage}
              onNotSpam={handleNotSpam}
              onEditDraft={handleEditDraft}
              onShowImages={handleShowImages}
              isLoadingImages={isLoadingImages}
              onReply={handleReply}
              onForward={handleForward}
              folders={folders}
              onBackToList={() => setMobileView('list')}
              onArchive={archiveFolder && !inStarredView ? (uid) => handleArchive(uid) : undefined}
              onSnooze={(uid, until) => handleSnooze(uid, until)}
              labels={labels}
              messageLabelIds={messages.find((m) => m.uid === selectedUid)?.labels ?? []}
              onToggleLabel={(id, on) => void handleToggleLabel(id, on)}
              onCreateLabel={(name, colour) => handleCreateLabel(name, colour)}
              menu={menu}
              onMenuChange={setMenu}
              position={(() => {
                const i = visibleMessages.findIndex((m) => m.uid === selectedUid);
                return i < 0 ? null : { index: (page - 1) * 50 + i + 1, total: Math.max(totalMessages, (page - 1) * 50 + visibleMessages.length) };
              })()}
              onNewer={() => {
                const i = visibleMessages.findIndex((m) => m.uid === selectedUid);
                if (i > 0) void handleSelectMessage(visibleMessages[i - 1].uid);
              }}
              onOlder={() => {
                const i = visibleMessages.findIndex((m) => m.uid === selectedUid);
                if (i >= 0 && i < visibleMessages.length - 1) void handleSelectMessage(visibleMessages[i + 1].uid);
              }}
              thread={thread}
              bounce={messages.find((m) => m.uid === selectedUid)?.bounce}
              onRetryBounce={() => void handleRetryBounce()}
              myAddress={account.email}
            />
          </div>
          </main>
        </div>
      )}

      {account && (
        <MobileTabBar
          active={
            selectedFolder === STARRED_PATH
              ? 'starred'
              : folders.find((f) => f.path.toLowerCase() === selectedFolder.toLowerCase())?.specialUse === 'Inbox'
                ? 'inbox'
                : null
          }
          onSelect={(tab: PhoneTab) => {
            if (tab === 'write') openComposer({});
            else if (tab === 'inbox') handleSelectFolder(folders.find((f) => f.specialUse === 'Inbox')?.path ?? 'INBOX');
            else if (tab === 'starred') handleSelectFolder(STARRED_PATH);
            else if (tab === 'folders') setShowMobileSidebar(true);
            else document.querySelector<HTMLInputElement>('[data-search-input]')?.focus();
          }}
        />
      )}

      <Presence show={showLabelsManager}>
      {showLabelsManager && (
        <LabelsManager
          labels={labels}
          onRename={handleRenameLabel}
          onMove={(id, pos) => void handleMoveLabel(id, pos)}
          onRecolour={(id, c) => void handleRecolourLabel(id, c)}
          onDelete={(id) => void handleDeleteLabel(id)}
          onCreate={(name, c) => handleCreateLabel(name, c, false)}
          requestConfirm={setConfirmRequest}
          onClose={() => setShowLabelsManager(false)}
        />
      )}
      </Presence>
      <Presence show={showShortcuts}>{showShortcuts && <ShortcutsSheet onClose={() => setShowShortcuts(false)} />}</Presence>

      {/* Add Account Modal (Overlay on active session) */}
      {isAddingAccount && (
        <ConnectModal
          isAddingAccount={true}
          onConnected={handleConnected}
          onCancel={() => setIsAddingAccount(false)}
          canInstall={!isInstalled}
          onInstallApp={handleInstallApp}
          notificationPermission={notificationPerm}
          onRequestNotifications={handleRequestNotifications}
        />
      )}

      {/* Session ended: sign in again without reloading (open drafts are kept) */}
      {reauth && !isAddingAccount && account && (
        <ConnectModal
          isAddingAccount={true}
          reauthEmail={reauth.email ?? ''}
          onConnected={handleConnected}
          onCancel={handleCancelReauth}
        />
      )}

      <Presence show={showNotifications && !!account}>
      {showNotifications && account && (
        <NotificationsPanel
          key={account.handle}
          email={account.email}
          otherAccounts={Math.max(0, savedAccounts.length - 1)}
          onClose={() => {
            setShowNotifications(false);
            setNotificationPerm(getNotificationPermission());
          }}
        />
      )}

      </Presence>
      <Presence show={showConnections && !!account}>
      {showConnections && account && (
        <ConnectionsPanel key={account.handle} email={account.email} onClose={() => setShowConnections(false)} />
      )}
      </Presence>

      {/* Floating Composer Modal */}
      <ComposerModal
        key={composeId}
        isOpen={isComposerOpen}
        onClose={() => {
          setIsComposerOpen(false);
          loadFolders();
          if (selectedFolderRef.current.toLowerCase().includes('draft')) loadMessages(true);
        }}
        requestConfirm={setConfirmRequest}
        onSentSuccess={(info) => {
          if (info?.error) showToast(info.error, 'error');
          else if (info?.warning) showToast(info.warning, 'error');
          else showToast('Email sent successfully');
          loadFolders();
          if (selectedFolder.toLowerCase().includes('sent')) {
            loadMessages();
          }
        }}
        initialTo={composerInitial.to}
        initialCc={composerInitial.cc}
        initialBcc={composerInitial.bcc}
        isDraft={composerInitial.isDraft}
        initialSubject={composerInitial.subject}
        initialBody={composerInitial.body}
        initialHtml={composerInitial.html}
        replyMeta={composerInitial.meta}
        accountEmail={account?.email}
        accountName={account?.name}
      />

      <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />

      {/* Toast Notification: the live regions are always present so screen readers announce changes */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {toast && toast.type === 'success' ? toast.message : undoLatest ? undoLatest.label + '. Press Z to undo.' : ''}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {toast && toast.type === 'error' ? toast.message : ''}
      </div>
      <div className="fixed z-[70] flex flex-col gap-2 items-start bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-3 right-3 md:bottom-5 md:left-4 lg:left-[15rem] md:right-auto md:max-w-[min(26rem,calc(100vw-2rem))] pointer-events-none">
        {toast && (
          <div
            aria-hidden="true"
            className={`anim-toast pointer-events-auto w-full px-4 py-3 rounded shadow-xl text-[13.5px] font-bold flex items-start gap-3 ${
              toast.type === 'error'
                ? 'bg-warn-bg text-ink border border-warn-line'
                : 'bg-toast-bg text-toast-ink border border-line'
            }`}
          >
            {toast.type === 'error' ? (
              <AlertTriangle className="w-5 h-5 shrink-0 text-warn-ink" />
            ) : (
              <Check className="w-5 h-5 shrink-0 text-ok-ink" />
            )}
            <span>{toast.message}</span>
          </div>
        )}
        {undoLatest && (
          <div
            key={undoLatest.id}
            className="anim-toast pointer-events-auto w-full px-4 py-2 rounded shadow-xl text-[13.5px] font-bold flex items-center gap-3 bg-toast-bg text-toast-ink border border-line"
          >
            <Check className="w-5 h-5 shrink-0 text-ok-ink" aria-hidden="true" />
            <span className="flex-1">{undoLatest.label}</span>
            <button
              type="button"
              onClick={() => pending.undo(undoLatest.id)}
              aria-keyshortcuts="Z"
              aria-label={`Undo: ${undoLatest.label}`}
              className="t-fast min-h-[44px] px-2 flex items-center gap-1.5 font-extrabold text-toast-link hover:underline"
            >
              Undo
              <kbd aria-hidden="true" className="hidden lg:inline-block text-[10.5px] font-semibold leading-none px-1 py-[3px] rounded-[3px] border border-current opacity-80">Z</kbd>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
