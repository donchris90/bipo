// Pure decision logic for ending abandoned broadcasts, kept apart from the
// timer/socket plumbing so it can be tested directly.
//
// A live session is "abandoned" when its host has not been inside the session's
// socket room for `graceMs` in a row. The grace period covers a dropped network,
// a phone call, or the moment right after going live before the socket joins.
export interface ReaperInput {
  sessionIds: string[]; // sessions currently LIVE
  present: Set<string>; // those whose host is in the room right now
  absentSince: Map<string, number>; // ms timestamps, mutated in place
  now: number;
  graceMs: number;
}

export function decideAbandoned({ sessionIds, present, absentSince, now, graceMs }: ReaperInput): string[] {
  const toEnd: string[] = [];
  const live = new Set(sessionIds);

  for (const id of sessionIds) {
    if (present.has(id)) {
      absentSince.delete(id);
      continue;
    }
    const since = absentSince.get(id);
    if (since === undefined) absentSince.set(id, now);
    else if (now - since >= graceMs) toEnd.push(id);
  }

  // forget sessions that are no longer live
  for (const id of [...absentSince.keys()]) if (!live.has(id)) absentSince.delete(id);
  return toEnd;
}
