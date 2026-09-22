/**
 * 402 Lounge — output escaping. User content is stored raw and escaped on
 * the way out so the static site can render it without an XSS hole.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
