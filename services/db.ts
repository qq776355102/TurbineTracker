import Dexie, { Table } from 'dexie';
import { LogEvent } from '../types';

const db = new Dexie('TurbineTrackerDB') as Dexie & {
  events: Table<LogEvent, number>;
};

// Version 1: Initial schema
db.version(1).stores({
  events: '++id, blockNumber, recipient, transactionHash' 
});

// Version 2: Add uniqueId index for deduplication
// We use &uniqueId to enforce uniqueness
db.version(2).stores({
  events: '++id, &uniqueId, blockNumber, recipient, transactionHash' 
});

export { db };

/**
 * Saves events to the database, filtering out duplicates.
 * Returns only the events that were actually added.
 */
export const saveEvents = async (events: LogEvent[]): Promise<LogEvent[]> => {
  if (events.length === 0) return [];

  // Filter out events that don't have a uniqueId (legacy) or ensure we handle them
  // For new events, we rely on uniqueId
  const validEvents = events.filter(e => e.uniqueId);

  if (validEvents.length === 0) {
    // Fallback for some reason if no uniqueId? Just return empty to be safe
    return [];
  }

  const newEvents: LogEvent[] = [];

  await db.transaction('rw', db.events, async () => {
    // Check which uniqueIds already exist
    const ids = validEvents.map(e => e.uniqueId as string);
    const existing = await db.events.where('uniqueId').anyOf(ids).toArray();
    const existingSet = new Set(existing.map(e => e.uniqueId));

    for (const ev of validEvents) {
      if (!existingSet.has(ev.uniqueId)) {
        newEvents.push(ev);
      }
    }

    if (newEvents.length > 0) {
      await db.events.bulkAdd(newEvents);
    }
  });

  return newEvents;
};

export const getAllEvents = async (): Promise<LogEvent[]> => {
  return await db.events.toArray();
};

export const clearDatabase = async () => {
  await db.events.clear();
};

export const getLatestStoredBlock = async (): Promise<number> => {
  const lastEvent = await db.events.orderBy('blockNumber').last();
  return lastEvent ? lastEvent.blockNumber : 0;
};
