'use strict';

// "Working" is automatic (active in the last X days) unless you pin or finish something yourself.

const DAY = 24 * 60 * 60 * 1000;

function workingState(item, override = {}, workingDays = 7, now = Date.now()) {
  if (override.done) return 'done';
  if (override.pinned) return 'working';
  if (item.archived) return 'done';
  if (item.updatedAt && item.updatedAt >= now - workingDays * DAY) return 'working';
  return 'idle';
}

module.exports = { workingState, DAY };
