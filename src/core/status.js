'use strict';

// Each item gets one state:
//   responding – Claude is writing a reply right now
//   new-reply  – Claude finished a reply you haven't looked at yet
//   pinned     – you pinned it
//   recent     – active in the last X days
//   older      – nothing recent
//   done       – you marked it done (until something new happens) or archived it in Claude
// "Working" = responding + new-reply + pinned.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// A transcript that stops growing mid-turn for this long means the session was closed or crashed,
// not that Claude is still working (long tool runs rarely go quiet for 10 minutes).
const RESPONDING_TIMEOUT = 10 * MINUTE;

function activityState(item, seenAt, now) {
  const a = item.activity;
  if (!a) return null;
  if (a.pending && a.lastWriteAt && now - a.lastWriteAt < RESPONDING_TIMEOUT) return 'responding';
  if (item.claudeUnread === true) return 'new-reply'; // Claude's own unread flag, when available
  if (item.claudeUnread === false) return null;
  const seen = Math.max(seenAt || 0, item.claudeReadAt || 0);
  if (!a.pending && a.finishedAt && a.finishedAt > seen) return 'new-reply';
  return null;
}

function itemState(item, { override = {}, seenAt = 0, recentDays = 7, now = Date.now() } = {}) {
  // "Done" lasts until the item changes again, so a new reply brings it back.
  const doneStillValid = override.done && !(item.updatedAt && override.at && item.updatedAt > override.at);
  if (doneStillValid) return 'done';
  const live = activityState(item, seenAt, now);
  if (live) return live;
  if (override.pinned) return 'pinned';
  if (item.archived) return 'done';
  if (item.updatedAt && item.updatedAt >= now - recentDays * DAY) return 'recent';
  return 'older';
}

const WORKING_STATES = new Set(['responding', 'new-reply', 'pinned']);

module.exports = { itemState, activityState, WORKING_STATES, RESPONDING_TIMEOUT, DAY };
