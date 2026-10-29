import sanitizeHtml from 'sanitize-html';

export function cleanEmailHtml(dirtyHtml: string): string {
  if (!dirtyHtml) return '';

  return sanitizeHtml(dirtyHtml, {
    allowedTags: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
      'nl', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
      'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'span',
      'img', 'sub', 'sup', 'font', 'center'
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'style'],
      '*': ['style', 'class', 'align', 'valign', 'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing', 'width']
    },
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          ...attribs,
          target: '_blank',
          rel: 'noopener noreferrer'
        }
      })
    },
    allowedSchemes: ['http', 'https', 'mailto', 'data', 'cid']
  });
}
