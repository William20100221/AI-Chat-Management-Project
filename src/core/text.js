'use strict';

// Small text and time helpers shared by every source.

const SNIPPET_LENGTH = 400;

function truncate(text, max = SNIPPET_LENGTH) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

// Message content is either a plain string or an array of blocks ({type: 'text', text}, images, tool calls...).
// With images: true, a message that is only pictures becomes "[2 images]" so it still shows up.
function contentText(content, { images: showImages = true } = {}) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  if (texts.length) return texts.join('\n');
  if (!showImages) return '';
  const images = content.filter((block) => block && block.type === 'image').length;
  return images ? `[${images} image${images > 1 ? 's' : ''}]` : '';
}

// Accepts ISO strings, epoch milliseconds or epoch seconds; returns epoch milliseconds or null.
function toMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

module.exports = { truncate, contentText, toMillis, SNIPPET_LENGTH };
