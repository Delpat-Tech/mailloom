import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/react';
import { RichEditor } from '../components/RichEditor.js';
import {
  cleanPastedHtml,
  normalizeUrl,
  plainTextToHtml,
  htmlToPlainText,
  quoteHtml,
  readImageFile,
  MAX_IMAGE_BYTES
} from '../services/richtext.js';

// jsdom has no layout; ProseMirror asks for these when it scrolls the selection into view.
beforeAll(() => {
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  document.elementFromPoint = () => null;
});

afterEach(cleanup);

// A 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const pngFile = (name = 'logo.png', size?: number) => {
  const bytes = Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));
  const f = new File([bytes], name, { type: 'image/png' });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
};

function setup(content = '<p>hello</p>') {
  let editor: Editor | null = null;
  const onChange = vi.fn();
  const onError = vi.fn();
  render(
    <RichEditor
      content={content}
      onChange={onChange}
      onError={onError}
      ariaLabel="Message"
      onReady={(e) => {
        if (e) editor = e;
      }}
    />
  );
  return { get editor() { return editor!; }, onChange, onError };
}

const selectAll = (ed: Editor) => act(() => { ed.commands.selectAll(); });

describe('editor toolbar commands', () => {
  it('is a labelled toolbar with named buttons', () => {
    setup();
    const bar = screen.getByRole('toolbar', { name: 'Formatting' });
    for (const name of ['Bold', 'Italic', 'Underline', 'Bulleted list', 'Numbered list', 'Quote', 'Link', 'Insert picture', 'Clear formatting']) {
      expect(bar.querySelector(`button[aria-label="${name}"]`), name).not.toBeNull();
    }
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeTruthy();
  });

  it.each([
    ['Bold', '<strong>hello</strong>'],
    ['Italic', '<em>hello</em>'],
    ['Underline', '<u>hello</u>']
  ])('%s marks the selected text', async (label, expected) => {
    const s = setup();
    selectAll(s.editor);
    await userEvent.setup().click(screen.getByRole('button', { name: label }));
    expect(s.editor.getHTML()).toContain(expected);
    expect(s.onChange).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
    // pressing again removes it
    await userEvent.setup().click(screen.getByRole('button', { name: label }));
    expect(s.editor.getHTML()).toBe('<p>hello</p>');
  });

  it('makes bullet and numbered lists and a quote', async () => {
    const s = setup();
    selectAll(s.editor);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Bulleted list' }));
    expect(s.editor.getHTML()).toBe('<ul><li><p>hello</p></li></ul>');
    selectAll(s.editor);
    await u.click(screen.getByRole('button', { name: 'Bulleted list' }));
    expect(s.editor.getHTML()).toBe('<p>hello</p>');
    selectAll(s.editor);
    await u.click(screen.getByRole('button', { name: 'Numbered list' }));
    expect(s.editor.getHTML()).toBe('<ol><li><p>hello</p></li></ol>');
    selectAll(s.editor);
    await u.click(screen.getByRole('button', { name: 'Numbered list' }));
    selectAll(s.editor);
    await u.click(screen.getByRole('button', { name: 'Quote' }));
    expect(s.editor.getHTML()).toBe('<blockquote><p>hello</p></blockquote>');
  });

  it('clear formatting removes marks and lists', async () => {
    const s = setup('<ul><li><p><strong>hello</strong> <em>there</em></p></li></ul>');
    selectAll(s.editor);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear formatting' }));
    expect(s.editor.getHTML()).toBe('<p>hello there</p>');
  });

  it('keyboard shortcuts: Ctrl+B and Ctrl+I', () => {
    const s = setup();
    selectAll(s.editor);
    const key = (k: string, extra: KeyboardEventInit = {}) =>
      act(() => {
        s.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true, cancelable: true, ...extra }));
      });
    key('b');
    expect(s.editor.getHTML()).toContain('<strong>');
    key('i');
    expect(s.editor.getHTML()).toContain('<em>');
    key('b');
    expect(s.editor.getHTML()).not.toContain('<strong>');
  });

  it('Ctrl+K opens the link address field', () => {
    const s = setup();
    act(() => {
      s.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(screen.getByLabelText('Link address')).toBeTruthy();
  });
});

describe('links', () => {
  it('refuses javascript: and data: addresses and says so', async () => {
    const s = setup();
    selectAll(s.editor);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Link' }));
    await u.type(screen.getByLabelText('Link address'), 'javascript:alert(1)');
    await u.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/web address/);
    expect(s.editor.getHTML()).not.toContain('<a');
  });

  it('adds a link to the selected text; a bare domain becomes https', async () => {
    const s = setup();
    selectAll(s.editor);
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Link' }));
    await u.type(screen.getByLabelText('Link address'), 'example.com');
    await u.click(screen.getByRole('button', { name: 'Apply' }));
    expect(s.editor.getHTML()).toMatch(/<a [^>]*href="https:\/\/example\.com\/"[^>]*>hello<\/a>/);
  });

  it('normalizeUrl accepts web, mail and phone links only', () => {
    expect(normalizeUrl('https://delpat.in/x?y=1')).toBe('https://delpat.in/x?y=1');
    expect(normalizeUrl('delpat.in')).toBe('https://delpat.in/');
    expect(normalizeUrl('a@delpat.in')).toBe('mailto:a@delpat.in');
    expect(normalizeUrl('tel:+919825012345')).toBe('tel:+919825012345');
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', 'two words', '', 'localhostish', 'http://']) {
      expect(normalizeUrl(bad), bad).toBeNull();
    }
  });
});

describe('paste cleaning', () => {
  it('Word: drops mso markup, classes, styles, comments and empty paragraphs; keeps bold and lists', () => {
    const word =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{mso-style-name:x}</style></head><body>' +
      '<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->' +
      '<p class="MsoNormal" style="margin:0cm;font-family:Calibri"><span style="font-weight:bold;mso-bidi-font-weight:normal">Hello</span> <o:p>&nbsp;</o:p></p>' +
      '<p class="MsoListParagraph" style="mso-list:l0 level1 lfo1"><span style="mso-list:Ignore">&middot;</span>Item</p>' +
      '<p class="MsoNormal"><o:p>&nbsp;</o:p></p>' +
      '<ul><li><p>One</p></li><li><p>Two</p></li></ul></body></html>';
    const clean = cleanPastedHtml(word);
    expect(clean).not.toMatch(/mso|class=|style=|<!--|<o:|MsoNormal|Calibri|<span/i);
    expect(clean).toContain('<strong>Hello</strong>');
    expect(clean).toContain('<ul><li>One</li><li>Two</li></ul>');
  });

  it('Gmail / Google Docs: <b style="font-weight:normal"> is not bold; spans carry the real bold and italic', () => {
    const gdocs =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1">' +
      '<p dir="ltr" style="line-height:1.38"><span style="font-size:11pt;font-weight:700">Bold</span>' +
      '<span style="font-size:11pt;font-style:italic"> slanted</span> <span style="font-size:11pt">plain</span></p></b>';
    const clean = cleanPastedHtml(gdocs);
    expect(clean).toBe('<p><strong>Bold</strong><em> slanted</em> plain</p>');
  });

  it('web: scripts, event handlers, iframes, remote and file images and unsafe links are removed', () => {
    const clean = cleanPastedHtml(
      '<div onclick="x()"><script>alert(1)</script><p>Hi <a href="javascript:alert(1)">bad</a> <a href="https://ok.example/" onclick="x()">good</a></p>' +
        '<img src="https://evil.example/p.png"><img src="file:///c:/a.png"><iframe src="https://evil.example"></iframe>' +
        `<img src="data:image/png;base64,${PNG_B64}"></div>`
    );
    expect(clean).not.toMatch(/script|onclick|evil|file:|iframe|javascript/i);
    expect(clean).toContain('<a href="https://ok.example/">good</a>');
    expect(clean).toContain(`<img src="data:image/png;base64,${PNG_B64}">`);
  });

  it('pasting into the editor goes through the cleaner', () => {
    const s = setup('<p></p>');
    const html = '<p class="MsoNormal" style="color:red"><b style="font-weight:normal">plain</b> <span style="font-weight:bold">bold</span></p>';
    // jsdom has no ClipboardEvent, so run the editor's paste hook itself and insert what it returns.
    const cleaned = s.editor.view.someProp('transformPastedHTML', (f) => f(html, s.editor.view)) as string;
    expect(cleaned).toBe('<p>plain <strong>bold</strong></p>');
    act(() => {
      s.editor.commands.insertContent(cleaned);
    });
    expect(s.editor.getHTML()).toBe('<p>plain <strong>bold</strong></p>');
  });
});

describe('pictures', () => {
  it('inserting a picture from a file produces an inline image node with a data: source', async () => {
    const s = setup('<p>hi</p>');
    const input = screen.getByLabelText('Choose a picture') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile('company-logo.png')] } });
    await waitFor(() => expect(s.editor.getHTML()).toContain('<img'));
    const html = s.editor.getHTML();
    expect(html).toContain(`src="data:image/png;base64,${PNG_B64}"`);
    expect(html).toContain('alt="company-logo"');
    // an inline node inside a paragraph, not a file list
    let imageNodes = 0;
    s.editor.state.doc.descendants((n) => {
      if (n.type.name === 'image') imageNodes++;
    });
    expect(imageNodes).toBe(1);
    expect(s.onChange).toHaveBeenCalled();
  });

  it('a pasted picture file is inserted (not pasted as a file)', async () => {
    const s = setup('<p></p>');
    const event = { clipboardData: { files: [pngFile('shot.png')] }, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    let handled: boolean | void = false;
    act(() => {
      handled = s.editor.view.someProp('handlePaste', (f) => f(s.editor.view, event, null as never));
    });
    expect(handled).toBe(true);
    await waitFor(() => expect(s.editor.getHTML()).toContain('<img'));
  });

  it('a dropped picture file is inserted', async () => {
    const s = setup('<p></p>');
    const event = { dataTransfer: { files: [pngFile('drop.png')] }, preventDefault: vi.fn() } as unknown as DragEvent;
    act(() => {
      s.editor.view.someProp('handleDrop', (f) => f(s.editor.view, event, null as never, false));
    });
    await waitFor(() => expect(s.editor.getHTML()).toContain('<img'));
  });

  it('refuses a picture over the limit and a file that is not a picture, in plain words', async () => {
    const s = setup('<p>hi</p>');
    const input = screen.getByLabelText('Choose a picture') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pngFile('huge.png', MAX_IMAGE_BYTES + 1)] } });
    await waitFor(() => expect(s.onError).toHaveBeenCalled());
    expect(s.onError.mock.calls[0][0]).toMatch(/huge\.png.*at most 2\.0 MB/);
    expect(s.editor.getHTML()).not.toContain('<img');
    await expect(readImageFile(new File(['x'], 'a.svg', { type: 'image/svg+xml' }))).rejects.toThrow(/not a PNG, JPEG, GIF or WebP/);
  });
});

describe('plain text conversion', () => {
  it('round trips paragraphs, lists, links and quotes', () => {
    expect(plainTextToHtml('a < b\nsecond line\n\nnew paragraph')).toBe('<p>a &lt; b<br>second line</p><p>new paragraph</p>');
    const text = htmlToPlainText(
      '<p>Hi <a href="https://x.example/">site</a></p><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>' + quoteHtml('old line\nnext')
    );
    expect(text).toContain('Hi site (https://x.example/)');
    expect(text).toContain('- one\n- two');
    expect(text).toContain('1. a');
    expect(text).toContain('> old line\n> next');
  });
});
