import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar.js';
import { MessageList } from './components/MessageList.js';
import { MessageViewer } from './components/MessageViewer.js';
import { ComposerModal } from './components/ComposerModal.js';
import { ConnectModal } from './components/ConnectModal.js';
import {
  api,
  getStoredToken,
  getStoredAccounts,
  saveAccountProfile,
  removeStoredAccount,
  switchStoredAccount,
  updateStoredAccountUnread,
  clearStoredToken,
  type SearchFilterParams
} from './services/api.js';
import {
  showDesktopNotification,
  requestNotificationPermission
} from './services/notifications.js';
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

  // Mailboxes & Navigation
  const [folders, setFolders] = useState<MailboxFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string>('INBOX');

  // Messages in Current Folder
  const [messages, setMessages] = useState<MessageHeader[]>([]);
  const [totalMessages, setTotalMessages] = useState(0);
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchFilters, setSearchFilters] = useState<SearchFilterParams>({});
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const prevUnreadRef = useRef<number | null>(null);

  // Selected Message
  const [selectedUid, setSelectedUid] = useState<number | null>(null);
  const [selectedMessage, setSelectedMessage] = useState<ParsedEmailMessage | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  // Selection & Batch Operations
  const [selectedUids, setSelectedUids] = useState<Set<number>>(new Set());

  // Composer
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [composerInitial, setComposerInitial] = useState<{
    to?: string[];
    cc?: string[];
    subject?: string;
    body?: string;
  }>({});

  // Toast feedback
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  // 1. Initial Authentication Check (< 300ms Silent Auto-Login)
  useEffect(() => {
    const existingAccounts = getStoredAccounts();
    setSavedAccounts(existingAccounts);

    const token = getStoredToken();
    if (!token) {
      setIsAuthChecking(false);
      return;
    }

    api
      .getCurrentUser()
      .then((res) => {
        setAccount(res.account);
        // Refresh saved profile timestamp
        saveAccountProfile({
          email: res.account.email,
          name: res.account.name,
          token,
          imapHost: res.account.imapHost,
          smtpHost: res.account.smtpHost,
          isDemo: res.account.isDemo,
          lastActive: Date.now()
        });
        setSavedAccounts(getStoredAccounts());
      })
      .catch(() => {
        // Token invalid or expired, clear and prompt login
        clearStoredToken();
        setAccount(null);
      })
      .finally(() => {
        setIsAuthChecking(false);
      });
  }, []);

  // 2. Fetch Folders
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
        const hasCurrent = res.folders.some(
          (f) => f.path.toLowerCase() === selectedFolder.toLowerCase()
        );
        if (!hasCurrent) {
          const inbox = res.folders.find((f) => f.specialUse === 'Inbox') || res.folders[0];
          setSelectedFolder(inbox.path);
        }
      }
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to load folders', 'error');
    }
  }, [account, selectedFolder]);

  useEffect(() => {
    if (account) {
      loadFolders();
    }
  }, [account, loadFolders]);

  // 3. Fetch Messages for Selected Folder
  const loadMessages = useCallback(async () => {
    if (!account || !selectedFolder) return;
    setIsMessagesLoading(true);
    try {
      const res = await api.getMessages(selectedFolder, page, 50, searchTerm, searchFilters);
      setMessages(res.messages);
      setTotalMessages(res.total);
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to load messages', 'error');
    } finally {
      setIsMessagesLoading(false);
    }
  }, [account, selectedFolder, page, searchTerm, searchFilters]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Reset pagination & message detail when switching folders
  const handleSelectFolder = (folderPath: string) => {
    if (folderPath.toLowerCase() === selectedFolder.toLowerCase()) return;
    setSelectedFolder(folderPath);
    setPage(1);
    setSearchTerm('');
    setSearchFilters({});
    setSelectedUid(null);
    setSelectedMessage(null);
    setSelectedUids(new Set());
  };

  // 4. Select and View Message Detail
  const handleSelectMessage = async (uid: number) => {
    setSelectedUid(uid);
    setIsDetailLoading(true);

    // Optimistically mark as seen in message list
    setMessages((prev) =>
      prev.map((m) => (m.uid === uid ? { ...m, isSeen: true } : m))
    );

    try {
      const detail = await api.getMessageDetail(selectedFolder, uid);
      setSelectedMessage(detail);
      // Refresh folder counts
      loadFolders();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to load email content', 'error');
    } finally {
      setIsDetailLoading(false);
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
      showToast(err instanceof Error ? err.message : 'Failed to update flag', 'error');
      // Revert on failure
      loadMessages();
    }
  };

  // 6. Delete Message
  const handleDeleteMessage = async (uid: number) => {
    try {
      await api.deleteMessage(selectedFolder, uid);
      showToast('Message deleted');
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      if (selectedUid === uid) {
        setSelectedUid(null);
        setSelectedMessage(null);
      }
      loadFolders();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to delete message', 'error');
    }
  };

  // 7. Move Message
  const handleMoveMessage = async (uid: number, targetFolder: string) => {
    try {
      await api.moveMessage(selectedFolder, uid, targetFolder);
      showToast(`Moved to ${targetFolder}`);
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      if (selectedUid === uid) {
        setSelectedUid(null);
        setSelectedMessage(null);
      }
      loadFolders();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to move message', 'error');
    }
  };

  // 8. Batch Operations
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

  const handleBatchDelete = async () => {
    const uidsToDelete = Array.from(selectedUids);
    for (const uid of uidsToDelete) {
      try {
        await api.deleteMessage(selectedFolder, uid);
      } catch {
        // Continue deleting rest
      }
    }
    showToast(`Deleted ${uidsToDelete.length} messages`);
    setSelectedUids(new Set());
    loadMessages();
    loadFolders();
    if (selectedUid && uidsToDelete.includes(selectedUid)) {
      setSelectedUid(null);
      setSelectedMessage(null);
    }
  };

  const handleBatchMarkRead = async (isSeen: boolean) => {
    const uids = Array.from(selectedUids);
    for (const uid of uids) {
      try {
        await api.toggleFlag(selectedFolder, uid, 'isSeen', isSeen);
      } catch {
        // Continue
      }
    }
    showToast(`Marked ${uids.length} messages as ${isSeen ? 'read' : 'unread'}`);
    setSelectedUids(new Set());
    loadMessages();
    loadFolders();
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
      await api.markSpam(selectedFolder, uid, junkFolder);
      showToast('Moved to Junk & marked as read');
      setMessages((prev) => prev.filter((m) => m.uid !== uid));
      if (selectedUid === uid) {
        setSelectedUid(null);
        setSelectedMessage(null);
      }
      loadFolders();
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to mark as spam', 'error');
    }
  };

  const handleBatchSpam = async () => {
    const uidsToSpam = Array.from(selectedUids);
    const junkFolder = getJunkFolderPath();
    for (const uid of uidsToSpam) {
      try {
        await api.markSpam(selectedFolder, uid, junkFolder);
      } catch {
        // Continue
      }
    }
    showToast(`Moved ${uidsToSpam.length} messages to Junk`);
    setSelectedUids(new Set());
    loadMessages();
    loadFolders();
    if (selectedUid && uidsToSpam.includes(selectedUid)) {
      setSelectedUid(null);
      setSelectedMessage(null);
    }
  };

  // 9. Reply & Forward Composer Hooks
  const handleReply = (message: ParsedEmailMessage, replyAll = false) => {
    const sender = message.from.address;
    const recipients = replyAll
      ? [sender, ...message.to.map((t) => t.address).filter((a) => a !== account?.email)]
      : [sender];
    const cc = replyAll && message.cc ? message.cc.map((c) => c.address) : [];

    const dateStr = new Date(message.date).toLocaleString();
    const quote = `\n\n--- On ${dateStr}, ${message.from.name || sender} wrote: ---\n> ${
      message.text ? message.text.replace(/\n/g, '\n> ') : ''
    }`;

    setComposerInitial({
      to: recipients,
      cc,
      subject: message.subject.startsWith('Re:') ? message.subject : `Re: ${message.subject}`,
      body: quote
    });
    setIsComposerOpen(true);
  };

  const handleForward = (message: ParsedEmailMessage) => {
    const dateStr = new Date(message.date).toLocaleString();
    const forwardHeader = `\n\n---------- Forwarded message ---------\nFrom: ${message.from.name || ''} <${
      message.from.address
    }>\nDate: ${dateStr}\nSubject: ${message.subject}\nTo: ${message.to
      .map((t) => t.address)
      .join(', ')}\n\n${message.text || ''}`;

    setComposerInitial({
      to: [],
      subject: message.subject.startsWith('Fwd:') ? message.subject : `Fwd: ${message.subject}`,
      body: forwardHeader
    });
    setIsComposerOpen(true);
  };

  // 10. Multi-Account Management
  const handleConnected = (acc: UserAccount, token: string, rememberMe: boolean) => {
    saveAccountProfile({
      email: acc.email,
      name: acc.name,
      token,
      imapHost: acc.imapHost,
      smtpHost: acc.smtpHost,
      isDemo: acc.isDemo,
      rememberMe,
      lastActive: Date.now()
    });
    setAccount(acc);
    setSavedAccounts(getStoredAccounts());
    setIsAddingAccount(false);
    showToast(isAddingAccount ? `Added mailbox ${acc.email}` : 'Connected successfully');
  };

  const handleSwitchAccount = async (targetEmail: string) => {
    const switched = switchStoredAccount(targetEmail);
    if (!switched) return;

    setIsMessagesLoading(true);
    setMessages([]);
    setSelectedUid(null);
    setSelectedMessage(null);
    setSelectedFolder('INBOX');

    try {
      const res = await api.getCurrentUser();
      setAccount(res.account);
      setSavedAccounts(getStoredAccounts());
      showToast(`Switched to ${targetEmail}`);
    } catch {
      showToast(`Could not reconnect to ${targetEmail}`, 'error');
    } finally {
      setIsMessagesLoading(false);
    }
  };

  const handleRemoveAccount = (targetEmail: string) => {
    removeStoredAccount(targetEmail);
    const updated = getStoredAccounts();
    setSavedAccounts(updated);
    showToast(`Removed account ${targetEmail}`);

    // If active account was removed, switch to next or logout
    if (account?.email.toLowerCase() === targetEmail.toLowerCase()) {
      if (updated.length > 0) {
        handleSwitchAccount(updated[0].email);
      } else {
        handleLogout();
      }
    }
  };

  // 11. Desktop Notifications & 60s Background Polling
  useEffect(() => {
    if (!account) return;

    // Prompt for notification permission on active session
    requestNotificationPermission();

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
                handleSelectMessage(newest.uid);
              }
            });
          }
        }

        prevUnreadRef.current = currentUnread;
        setFolders(folderRes.folders);
        const totalUnread = folderRes.folders.reduce((acc, f) => acc + (f.unreadCount || 0), 0);
        updateStoredAccountUnread(account.email, totalUnread);
        setSavedAccounts(getStoredAccounts());
      } catch {
        // Silently ignore background polling errors
      }
    }, 60000); // 60 seconds interval

    return () => clearInterval(interval);
  }, [account]);

  // 12. Logout Active Account
  const handleLogout = async () => {
    if (account) {
      removeStoredAccount(account.email);
    }
    await api.logout();
    const remaining = getStoredAccounts();
    setSavedAccounts(remaining);

    if (remaining.length > 0) {
      handleSwitchAccount(remaining[0].email);
    } else {
      setAccount(null);
      setFolders([]);
      setMessages([]);
      setSelectedUid(null);
      setSelectedMessage(null);
    }
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
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-slate-100 text-slate-900 font-sans">
      {!account ? (
        <ConnectModal onConnected={handleConnected} />
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left Pane: Mailbox Navigation & Multi-Account Switcher */}
          <Sidebar
            account={account}
            folders={folders}
            selectedFolder={selectedFolder}
            onSelectFolder={handleSelectFolder}
            onOpenComposer={() => {
              setComposerInitial({});
              setIsComposerOpen(true);
            }}
            onLogout={handleLogout}
            savedAccounts={savedAccounts}
            onSwitchAccount={handleSwitchAccount}
            onAddAccount={() => setIsAddingAccount(true)}
            onRemoveAccount={handleRemoveAccount}
          />

          {/* Middle Pane: Message List */}
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
            isLoading={isMessagesLoading}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            filters={searchFilters}
            onFiltersChange={setSearchFilters}
            onBatchDelete={handleBatchDelete}
            onBatchMarkRead={handleBatchMarkRead}
            onBatchSpam={handleBatchSpam}
            page={page}
            limit={50}
            onPageChange={setPage}
          />

          {/* Right Pane: Message Viewer */}
          <MessageViewer
            folderPath={selectedFolder}
            message={selectedMessage}
            isLoading={isDetailLoading}
            onToggleFlag={(uid, flag) => handleToggleFlag(uid, flag)}
            onDelete={handleDeleteMessage}
            onMove={handleMoveMessage}
            onMarkSpam={handleMarkSpam}
            onReply={handleReply}
            onForward={handleForward}
            folders={folders}
          />
        </div>
      )}

      {/* Add Account Modal (Overlay on active session) */}
      {isAddingAccount && (
        <ConnectModal
          isAddingAccount={true}
          onConnected={handleConnected}
          onCancel={() => setIsAddingAccount(false)}
        />
      )}

      {/* Floating Composer Modal */}
      <ComposerModal
        isOpen={isComposerOpen}
        onClose={() => setIsComposerOpen(false)}
        onSentSuccess={() => {
          showToast('Email sent successfully');
          loadFolders();
          if (selectedFolder.toLowerCase().includes('sent')) {
            loadMessages();
          }
        }}
        initialTo={composerInitial.to}
        initialCc={composerInitial.cc}
        initialSubject={composerInitial.subject}
        initialBody={composerInitial.body}
        accountEmail={account?.email}
        accountName={account?.name}
      />

      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 px-4 py-2.5 rounded-xl shadow-xl text-xs font-semibold z-50 flex items-center gap-2 border transition-all animate-bounce ${
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
