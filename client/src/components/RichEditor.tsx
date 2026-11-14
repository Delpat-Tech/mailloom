import React, { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { AllSelection } from '@tiptap/pm/state';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, Italic, Underline as UnderlineIcon, List, ListOrdered, Quote, Link as LinkIcon, RemoveFormatting, ImagePlus } from 'lucide-react';
import { cleanPastedHtml, normalizeUrl, readImageFile, IMAGE_TYPES, MAX_IMAGE_BYTES } from '../services/richtext.js';

/*
 * The rich-text editor (TipTap / ProseMirror). It is deliberately unstyled beyond plain, stable class names
 * so a new look only has to restyle these:
 *   .ml-editor            the whole editor
 *   .ml-editor-toolbar    the row of formatting buttons   (.ml-editor-btn, .is-active)
 *   .ml-editor-link       the link address row
 *   .ml-editor-content    the writing area (rendered text: p, ul, ol, blockquote, a, img)
 * The editor only produces: paragraphs, line breaks, bold, italic, underline, bullet and numbered lists,
 * quotes, links and pictures. That is the same subset the server allows when sending.
 */

export interface RichEditorProps {
  /** Starting content (HTML). The editor is not controlled: give it a new React key to start over. */
  content: string;
  onChange: (html: string) => void;
  /** Called with a plain-language message when a picture or link is refused. */
  onError?: (message: string) => void;
  ariaLabel: string;
  placeholder?: string;
  /** Receives the editor once it exists (null when it is gone). */
  onReady?: (editor: Editor | null) => void;
  maxImageBytes?: number;
  /** Size of the writing area; plain classes, restyle freely. */
  contentClassName?: string;
  /** Extra controls placed at the end of the toolbar (e.g. the Plain text switch). */
  toolbarExtra?: React.ReactNode;
}

interface BtnProps {
  label: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const ToolButton: React.FC<BtnProps> = ({ label, shortcut, active, disabled, onClick, children }) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={active === undefined ? undefined : active}
    title={shortcut ? `${label} (${shortcut})` : label}
    disabled={disabled}
    // Keep the text selection: do not let the button take focus from the editor.
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`ml-editor-btn p-1.5 rounded min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 flex items-center justify-center transition-colors disabled:opacity-40 ${
      active ? 'is-active bg-sel text-sel-ink' : 'text-ink-3 hover:text-ink hover:bg-line'
    }`}
  >
    {children}
  </button>
);

/** The editor's whole feature set: this is also exactly what the server accepts when sending. */
export function buildExtensions(placeholder = '') {
  return [
    StarterKit.configure({
      heading: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      strike: false
    }),
    Underline,
    Link.configure({
      openOnClick: false,
      autolink: true,
      protocols: ['mailto', 'tel'],
      validate: (href: string) => normalizeUrl(href) !== null,
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' }
    }),
    Image.configure({ inline: true, allowBase64: true }),
    Placeholder.configure({ placeholder })
  ];
}

/** HTML as the editor would write it (used to find a signature again inside a message body). */
export function normalizeEditorHtml(html: string): string {
  const ed = new Editor({ extensions: buildExtensions(), content: html });
  const out = ed.getHTML();
  ed.destroy();
  return out;
}

/**
 * Ctrl+A makes ProseMirror select "everything" (AllSelection), where lists cannot be toggled off again.
 * Turn it into an ordinary text selection over the same content before a toolbar command runs.
 */
function chain(editor: Editor) {
  const { selection, doc } = editor.state;
  if (selection instanceof AllSelection && doc.content.size > 2) {
    editor.commands.setTextSelection({ from: 1, to: doc.content.size - 1 });
  }
  return editor.chain().focus();
}

export const RichEditor: React.FC<RichEditorProps> = ({
  content,
  onChange,
  onError,
  ariaLabel,
  placeholder,
  onReady,
  maxImageBytes = MAX_IMAGE_BYTES,
  contentClassName = 'min-h-[8rem]',
  toolbarExtra
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  // The latest callbacks, without rebuilding the editor each render.
  const cb = useRef({ onChange, onError, maxImageBytes });
  cb.current = { onChange, onError, maxImageBytes };

  const insertPictures = async (editor: Editor, files: File[]) => {
    for (const file of files) {
      try {
        const src = await readImageFile(file, cb.current.maxImageBytes);
        const alt = (file.name || '').replace(/\.[a-z0-9]+$/i, '');
        editor.chain().focus().setImage({ src, alt }).run();
      } catch (err) {
        cb.current.onError?.((err as Error).message);
      }
    }
  };
  const insertRef = useRef(insertPictures);
  insertRef.current = insertPictures;

  const editor = useEditor({
    extensions: buildExtensions(placeholder),
    content,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': ariaLabel,
        class: `ml-editor-content focus:outline-none text-sm text-ink leading-relaxed ${contentClassName}`
      },
      transformPastedHTML: (html) => cleanPastedHtml(html),
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        event.preventDefault();
        if (editorRef.current) void insertRef.current(editorRef.current, files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from(event.dataTransfer?.files || []).filter((f) => f.type.startsWith('image/'));
        if (files.length === 0) return false;
        event.preventDefault();
        if (editorRef.current) void insertRef.current(editorRef.current, files);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          openLinkRowRef.current();
          return true;
        }
        return false;
      }
    },
    onUpdate: ({ editor: ed }) => cb.current.onChange(ed.isEmpty ? '' : ed.getHTML())
  });

  const editorRef = useRef<Editor | null>(null);
  editorRef.current = editor;
  useEffect(() => {
    onReady?.(editor);
    return () => onReady?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  const openLinkRow = () => {
    if (!editor) return;
    setLinkValue((editor.getAttributes('link').href as string | undefined) || '');
    setLinkError(null);
    setLinkOpen(true);
    setTimeout(() => linkInputRef.current?.focus(), 0);
  };
  const openLinkRowRef = useRef(openLinkRow);
  openLinkRowRef.current = openLinkRow;

  const applyLink = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editor) return;
    if (linkValue.trim() === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinkOpen(false);
      return;
    }
    const href = normalizeUrl(linkValue);
    if (!href) {
      setLinkError('Enter a web address such as https://example.com, or an email address.');
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to && !editor.isActive('link')) {
      // Nothing selected: insert the address itself as the link text.
      editor.chain().focus().insertContent({ type: 'text', text: linkValue.trim(), marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  if (!editor) return <div className="ml-editor" />;

  return (
    <div className="ml-editor flex flex-col min-h-0 flex-1">
      <div role="toolbar" aria-label="Formatting" className="ml-editor-toolbar flex flex-wrap items-center gap-0.5 pb-2 border-b border-line mb-2">
        <ToolButton label="Bold" shortcut="Ctrl+B" active={editor.isActive('bold')} onClick={() => chain(editor).toggleBold().run()}>
          <Bold className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Italic" shortcut="Ctrl+I" active={editor.isActive('italic')} onClick={() => chain(editor).toggleItalic().run()}>
          <Italic className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Underline" shortcut="Ctrl+U" active={editor.isActive('underline')} onClick={() => chain(editor).toggleUnderline().run()}>
          <UnderlineIcon className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Bulleted list" shortcut="Ctrl+Shift+8" active={editor.isActive('bulletList')} onClick={() => chain(editor).toggleBulletList().run()}>
          <List className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Numbered list" shortcut="Ctrl+Shift+7" active={editor.isActive('orderedList')} onClick={() => chain(editor).toggleOrderedList().run()}>
          <ListOrdered className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Quote" shortcut="Ctrl+Shift+B" active={editor.isActive('blockquote')} onClick={() => chain(editor).toggleBlockquote().run()}>
          <Quote className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Link" shortcut="Ctrl+K" active={editor.isActive('link')} onClick={openLinkRow}>
          <LinkIcon className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Insert picture" onClick={() => fileRef.current?.click()}>
          <ImagePlus className="w-4 h-4" />
        </ToolButton>
        <ToolButton label="Clear formatting" onClick={() => chain(editor).unsetAllMarks().clearNodes().run()}>
          <RemoveFormatting className="w-4 h-4" />
        </ToolButton>
        {toolbarExtra}
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_TYPES.join(',')}
          multiple
          aria-label="Choose a picture"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            if (files.length) void insertPictures(editor, files);
          }}
        />
      </div>

      {linkOpen && (
        <form onSubmit={applyLink} className="ml-editor-link flex flex-wrap items-center gap-2 pb-2 text-xs">
          <label htmlFor="ml-link-url" className="text-ink-3 font-medium">Link address</label>
          <input
            id="ml-link-url"
            ref={linkInputRef}
            type="text"
            value={linkValue}
            onChange={(e) => {
              setLinkValue(e.target.value);
              setLinkError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setLinkOpen(false);
                editor.commands.focus();
              }
            }}
            placeholder="https://example.com"
            aria-invalid={linkError ? true : undefined}
            aria-describedby={linkError ? 'ml-link-error' : undefined}
            className="flex-1 min-w-[160px] bg-sheet border border-line rounded px-2.5 py-1.5 focus:outline-none focus:border-act"
          />
          <button type="submit" className="px-3 py-1.5 bg-act hover:bg-act-hov text-act-ink rounded font-medium min-h-[44px] sm:min-h-0">
            Apply
          </button>
          {editor.isActive('link') && (
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
                setLinkOpen(false);
              }}
              className="px-3 py-1.5 text-ink-2 hover:bg-hover rounded min-h-[44px] sm:min-h-0"
            >
              Remove link
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setLinkOpen(false);
              editor.commands.focus();
            }}
            className="px-3 py-1.5 text-ink-2 hover:bg-hover rounded min-h-[44px] sm:min-h-0"
          >
            Cancel
          </button>
          {linkError && (
            <span id="ml-link-error" role="alert" className="w-full text-warn-ink">
              {linkError}
            </span>
          )}
        </form>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
};
