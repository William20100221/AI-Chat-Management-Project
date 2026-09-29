'use strict';

// Each item gets one state:
//   asking     – Claude stopped to ask you something (a question or a plan to approve) and waits
//   responding – Claude is writing a reply right now
//   new-reply  – Claude finished a reply you haven't looked at yet (or Claude marks it unread)
//   pinned     – you pinned it
//   recent     – active in the last X days
//   older      – nothing recent
//   done       – you marked it done (until something new happens) or archived it in Claude
// "Working" = asking + responding + new-reply + pinned.

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// A transcript that stops growing mid-turn for this long means the session was closed or crashed,
// not that Claude is still working (long tool runs rarely go quiet for 10 minutes).
const RESPONDING_TIMEOUT = 10 * MINUTE;
// A question nobody answered for a day is most likely an abandoned session.
const ASKING_TIMEOUT = DAY;

// seenAt: when you last looked at it (never earlier than when the app was installed).
// openedAt: when you actually opened it here, used against Claude's own unread flag.
function activityState(item, seenAt, now, openedAt = seenAt) {
  const a = item.activity;
  if (a && a.asking && a.lastWriteAt && now - a.lastWriteAt < ASKING_TIMEOUT) return 'asking';
  if (a && a.pending && a.lastWriteAt && now - a.lastWriteAt < RESPONDING_TIMEOUT) return 'responding';
  // Claude's own blue dot, when we can see it — unless you opened it here since it last changed.
  if (item.claudeUnread === true) return (openedAt || 0) >= (item.updatedAt || 0) ? null : 'new-reply';
  if (item.claudeUnread === false || !a) return null;
  const seen = Math.max(seenAt || 0, item.claudeReadAt || 0);
  if (!a.pending && a.finishedAt && a.finishedAt > seen) return 'new-reply';
  return null;
}

function itemState(item, { override = {}, seenAt = 0, openedAt = seenAt, recentDays = 7, now = Date.now() } = {}) {
  // "Done" lasts until the item changes again, so a new reply brings it back.
  const doneStillValid = override.done && !(item.updatedAt && override.at && item.updatedAt > override.at);
  if (doneStillValid) return 'done';
  const live = activityState(item, seenAt, now, openedAt);
  if (live) return live;
  if (override.pinned) return 'pinned';
  if (item.archived) return 'done';
  if (item.updatedAt && item.updatedAt >= now - recentDays * DAY) return 'recent';
  return 'older';
}

const WORKING_STATES = new Set(['asking', 'responding', 'new-reply', 'pinned']);

module.exports = { itemState, activityState, WORKING_STATES, RESPONDING_TIMEOUT, ASKING_TIMEOUT, DAY };
