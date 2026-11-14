import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { MessageList } from './components/MessageList.js';
import { MessageViewer } from './components/MessageViewer.js';
import { ComposerModal, type ComposerReplyMeta } from './components/ComposerModal.js';
import { planReply } from './services/reply.js';
import { ConnectModal } from './components/ConnectModal.js';
import { ConfirmDialog, type ConfirmRequest } from './components/ConfirmDialog.js';
import { friendlyError } from './services/errors.js';
import { useDialog } from './hooks/useDialog.js';
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

  // Messages in Current Folder
  const [messages, setMessages] = useState<MessageHeader[]>([]);
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
  const [composerInitial, setComposerInitial] = useState<{
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
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

  const loadFolders = useCallback(async () => {
    if (!account) return;
    try {
      const res = await api.getMailboxes();
      setFolders(res.folders);

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
        const hasCurrent = res.folders.some(
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

  // 3. Fetch Messages for Selected Folder. "silent" reloads (polling) keep the list as it is while loading.
  const loadSeq = useRef(0);
  const loadMessages = useCallback(
    async (silent = false) => {
      if (!account || !selectedFolder) return;
      const seq = ++loadSeq.current;
      if (!silent) setIsMessagesLoading(true);
      try {
        const res = await api.getMessages(selectedFolder, page, 50, searchTerm, searchFilters);
        if (seq !== loadSeq.current) return; // a newer request replaced this one
        setMessages(res.messages);
        setTotalMessages(res.total);
      } catch (err: unknown) {
        if (!silent && seq === loadSeq.current) {
          showToast(friendlyError(err, 'The messages could not be loaded. Try again.'), 'error');
        }
      } finally {
        if (!silent && seq === loadSeq.current) setIsMessagesLoading(false);
      }
    },
    [account, selectedFolder, page, searchTerm, searchFilters]
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
    setPage(1);
    setSearchInput('');
    setFilterInput({});
    setSelectedUid(null);
    setSelectedMessage(null);
    setSelectedUids(new Set());
    setShowMobileSidebar(false); // Close sidebar on mobile after folder pick
    setMobileView('list'); // Go back to list view on mobile
  };

  // 4. Select and View Message Detail
  const handleSelectMessage = async (uid: number) => {
    const seq = ++detailSeq.current;
    setSelectedUid(uid);
    setIsDetailLoading(true);
    setMobileView('message'); // Switch to message view on mobile

    // Optimistically mark as seen in message list
    setMessages((prev) =>
      prev.map((m) => (m.uid === uid ? { ...m, isSeen: true } : m))
    );

    try {
      const detail = await api.getMessageDetail(selectedFolder, uid);
      if (seq !== detailSeq.current) return; // the user already opened another message
      setSelectedMessage(detail);
      // Refresh folder counts
      loadFolders();
    } catch (err: unknown) {
      if (seq === detailSeq.current) {
        showToast(friendlyError(err, 'This message could not be opened. Try again.'), 'error');
      }
    } finally {
      if (seq === detailSeq.current) setIsDetailLoading(false);
    }
  };
  const handleSelectMessageRef = useRef(handleSelectMessage);
  handleSelectMessageRef.current = handleSelectMessage;

  const handleShowImages = async (uid: number) => {
    const seq = detailSeq.current; // same guard as handleSelectMessage: a newer open or folder switch wins
    const folder = selectedFolder;
    setIsLoadingImages(true);
    try {
      const detail = await api.getMessageDetail(folder, uid, { showImages: true });
      if (seq !== detailSeq.current) return;
      setSelectedMessage(detail);
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

    // Optimistic UI updates
    setMessages((prev) =>
      prev.map((m) => (m.uid === uid ? { ...m, [flag]: newValue } : m))
    );
    if (selectedMessage && selectedMessage.uid === uid) {
      setSelectedMessage({ ...selectedMessage, [flag]: newValue });
    }

    try {
      await api.toggleFlag(selectedFolder, uid, flag, newValue);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The change could not be saved. Try again.'), 'error');
      // Revert on failure
      loadMessages();
    }
  };

  const selectedFolderKind = folders.find((f) => f.path === selectedFolder)?.specialUse;

  const clearSelectionIf = (uids: number[]) => {
    if (selectedUid !== null && uids.includes(selectedUid)) {
      setSelectedUid(null);
      setSelectedMessage(null);
      setMobileView('list'); // the message is gone: on a phone, go back to the list
    }
  };

  // 6. Delete Message: to Trash; inside Trash it is permanent and asks first.
  const performDelete = async (uid: number) => {
    try {
      const r = await api.deleteMessage(selectedFolder, uid);
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
      const r = await api.restoreMessage(selectedFolder, uid);
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
      const r = await api.notSpam(selectedFolder, uid);
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
  const handleMoveMessage = async (uid: number, targetFolder: string) => {
    try {
      const r = await api.moveMessage(selectedFolder, uid, targetFolder);
      if (!r.success) throw new Error('The message could not be moved.');
      const name = folders.find((f) => f.path === targetFolder)?.name || targetFolder;
      showToast(`Moved to ${name}`);
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      clearSelectionIf([uid]);
      loadFolders();
    } catch (err: unknown) {
      showToast(friendlyError(err, 'The message could not be moved. Try again.'), 'error');
      loadMessages(true);
    }
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
    const r = await runBatch(uids, (uid) => api.deleteMessage(selectedFolder, uid));
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
    const r = await runBatch(uids, (uid) => api.toggleFlag(selectedFolder, uid, 'isSeen', isSeen));
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
      const r = await api.markSpam(selectedFolder, uid, junkFolder);
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
    const r = await runBatch(uids, (uid) => api.markSpam(selectedFolder, uid, junkFolder));
    finishBatch('Moved to Junk', uids.length, r);
  };

  const handleBatchRestore = async () => {
    const uids = Array.from(selectedUids);
    if (uids.length === 0) return;
    const r = await runBatch(uids, (uid) => api.restoreMessage(selectedFolder, uid));
    finishBatch('Restored to Inbox', uids.length, r);
  };

  const handleBatchNotSpam = async () => {
    const uids = Array.from(selectedUids);
    if (uids.length === 0) return;
    const r = await runBatch(uids, (uid) => api.notSpam(selectedFolder, uid));
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
      meta: {
        forwardOf: { folder: selectedFolder, uid: message.uid },
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
      isDraft: true,
      meta: {
        draftUid: message.uid,
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
      await api.logout(handle);
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
          if (newest && !newest.isSeen) {
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

  // 12. Logout Active Account (this browser only; other devices stay signed in)
  const handleLogout = async () => {
    if (!account) return;
    if (!(await signOutAccount(account.handle, account.email))) return;
    showRemainingOrSignIn(getStoredAccounts());
  };

  if (isAuthChecking) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-900 text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-sky-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs font-semibold text-slate-300">Launching Mailloom...</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden bg-slate-100 text-slate-900 font-sans"
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
              className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs z-40 lg:hidden"
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
              fixed inset-y-0 left-0 z-50 w-64 transform transition-[transform,visibility] duration-200 ease-out shadow-2xl lg:shadow-none
              lg:relative lg:translate-x-0 lg:z-auto
              ${showMobileSidebar ? 'translate-x-0' : '-translate-x-full max-lg:invisible'}
            `}
          >
            <Sidebar
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
            />
          </div>

          <main className="flex-1 flex min-w-0 overflow-hidden">
          {/* Middle Pane: Message List */}
          <div
            className={`
              flex-1 md:flex-none md:w-[320px] lg:w-[360px] xl:w-[420px] min-w-0 h-full
              ${mobileView === 'message' ? 'hidden md:block' : 'block'}
            `}
          >
            <MessageList
              folderName={
                folders.find((f) => f.path.toLowerCase() === selectedFolder.toLowerCase())?.name ||
                selectedFolder
              }
              messages={messages}
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
              onCompose={() => openComposer({})}
              isVisible={mobileView === 'list'}
              page={page}
              limit={50}
              onPageChange={setPage}
              onOpenMobileSidebar={() => setShowMobileSidebar(true)}
            />
          </div>

          {/* Right Pane: Message Viewer */}
          <div
            className={`
              flex-1 min-w-0
              ${mobileView === 'list' ? 'hidden md:flex' : 'flex'}
            `}
          >
            <MessageViewer
              folderPath={selectedFolder}
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
            />
          </div>
          </main>
        </div>
      )}

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
        replyMeta={composerInitial.meta}
        accountEmail={account?.email}
        accountName={account?.name}
      />

      <ConfirmDialog request={confirmRequest} onClose={() => setConfirmRequest(null)} />

      {/* Toast Notification: the live regions are always present so screen readers announce changes */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {toast && toast.type === 'success' ? toast.message : ''}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {toast && toast.type === 'error' ? toast.message : ''}
      </div>
      {toast && (
        <div
          aria-hidden="true"
          className={`fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 w-max max-w-[calc(100vw-2rem)] px-4 py-2.5 rounded-xl shadow-xl text-xs font-semibold z-[70] flex items-center gap-2 border transition-all animate-bounce motion-reduce:animate-none ${
            toast.type === 'error'
              ? 'bg-red-950 text-red-200 border-red-800'
              : 'bg-slate-900 text-white border-slate-700'
          }`}
        >
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
};
