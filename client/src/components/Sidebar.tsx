import React from 'react';
import {
  Inbox,
  Send,
  FileText,
  Trash2,
  AlertOctagon,
  Archive,
  Star,
  Folder,
  PenSquare,
  LogOut,
  Mail,
  Sparkles
} from 'lucide-react';
import type { MailboxFolder, UserAccount } from '../types.js';

interface SidebarProps {
  account: UserAccount;
  folders: MailboxFolder[];
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  onOpenComposer: () => void;
  onLogout: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  account,
  folders,
  selectedFolder,
  onSelectFolder,
  onOpenComposer,
  onLogout
}) => {
  const getFolderIcon = (f: MailboxFolder) => {
    switch (f.specialUse) {
      case 'Inbox':
        return <Inbox className="w-4 h-4" />;
      case 'Sent':
        return <Send className="w-4 h-4" />;
      case 'Drafts':
        return <FileText className="w-4 h-4" />;
      case 'Trash':
        return <Trash2 className="w-4 h-4" />;
      case 'Junk':
        return <AlertOctagon className="w-4 h-4" />;
      case 'Archive':
        return <Archive className="w-4 h-4" />;
      default:
        if (f.name.toLowerCase() === 'starred') return <Star className="w-4 h-4 text-amber-500 fill-amber-500" />;
        return <Folder className="w-4 h-4" />;
    }
  };

  return (
    <div className="w-64 bg-slate-900 text-slate-300 flex flex-col h-full select-none border-r border-slate-800">
      {/* App Branding */}
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-sky-500 flex items-center justify-center text-white shadow-md shadow-sky-500/20">
            <Mail className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5 font-bold text-white text-base tracking-tight leading-none">
              Mailloom
              {account.isDemo && (
                <span className="text-[10px] font-semibold uppercase tracking-wider bg-sky-950 text-sky-400 border border-sky-800/60 px-1.5 py-0.5 rounded-full flex items-center gap-0.5">
                  <Sparkles className="w-2.5 h-2.5" /> Demo
                </span>
              )}
            </div>
            <span className="text-xs text-slate-500 font-medium">Delpat Webmail</span>
          </div>
        </div>
      </div>

      {/* Primary Compose Action */}
      <div className="p-4">
        <button
          onClick={onOpenComposer}
          className="w-full flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-medium px-4 py-2.5 rounded-xl shadow-lg shadow-sky-600/20 transition-all active:scale-[0.98]"
        >
          <PenSquare className="w-4 h-4" />
          <span>New Message</span>
        </button>
      </div>

      {/* Folders Navigation */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Folders
        </div>
        {folders.map((folder) => {
          const isSelected = selectedFolder.toLowerCase() === folder.path.toLowerCase();
          return (
            <button
              key={folder.path}
              onClick={() => onSelectFolder(folder.path)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isSelected
                  ? 'bg-sky-600/20 text-sky-400 font-semibold border-l-2 border-sky-500'
                  : 'text-slate-300 hover:bg-slate-800/60 hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2.5 truncate">
                <span className={isSelected ? 'text-sky-400' : 'text-slate-400'}>{getFolderIcon(folder)}</span>
                <span className="truncate">{folder.name}</span>
              </div>
              {folder.unreadCount > 0 && (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full font-bold ${
                    isSelected ? 'bg-sky-500 text-white' : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  {folder.unreadCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* User Account / Footer */}
      <div className="p-3 border-t border-slate-800 bg-slate-950/40">
        <div className="flex items-center justify-between px-2 py-1.5 rounded-lg bg-slate-900/80 border border-slate-800/80">
          <div className="flex items-center gap-2.5 truncate">
            <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-sky-600 to-indigo-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
              {(account.name || account.email).charAt(0).toUpperCase()}
            </div>
            <div className="truncate text-left">
              <div className="text-xs font-semibold text-white truncate">{account.name || account.email}</div>
              <div className="text-[11px] text-slate-400 truncate">{account.email}</div>
            </div>
          </div>
          <button
            onClick={onLogout}
            title="Disconnect account"
            className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-950/30 rounded-md transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
