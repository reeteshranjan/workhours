import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../server/db/index.js';
import { EventHub } from '../../server/events.js';
import type { EventClient } from '../../server/events.js';
import { Presence } from '../../server/presence.js';
import type { PresenceOptions } from '../../server/presence.js';
import { Tracker } from '../../server/tracker/index.js';
import type { EventName } from '../../shared/types.js';

export interface Recorded {
  name: EventName;
  data: unknown;
}

/** A tab that only writes down what it is sent. */
export interface FakeClient extends EventClient {
  received: Recorded[];
}

export function fakeClient(): FakeClient {
  const received: Recorded[] = [];
  return {
    received,
    send(name, data) {
      received.push({ name, data });
    },
  };
}

export interface Deps {
  db: DatabaseSync;
  tracker: Tracker;
  hub: EventHub;
  presence: Presence;
}

/** A real Tracker on an in-memory database with a hub and a (not started) Presence. */
export function makeDeps(presenceOpts: Partial<PresenceOptions> = {}): Deps {
  const db = openDatabase(':memory:');
  const tracker = new Tracker(db);
  const hub = new EventHub();
  const presence = new Presence({ tracker, hub, ...presenceOpts });
  return { db, tracker, hub, presence };
}
