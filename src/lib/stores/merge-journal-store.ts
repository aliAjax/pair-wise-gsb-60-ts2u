import { browser } from '$app/environment';
import type { MergeJournal, MergeItem } from '$lib/models/signal';
import { makeId } from './signal-store';
import { writable } from 'svelte/store';

export const MERGE_JOURNAL_KEY = 'medical-safety-merge-journals-v1';

function readJournals(): MergeJournal[] {
  if (!browser) return [];
  try {
    const raw = localStorage.getItem(MERGE_JOURNAL_KEY);
    return raw ? (JSON.parse(raw) as MergeJournal[]) : [];
  } catch {
    return [];
  }
}

const internal = writable<MergeJournal[]>(readJournals());

if (browser) {
  internal.subscribe((journals) => {
    localStorage.setItem(MERGE_JOURNAL_KEY, JSON.stringify(journals));
  });

  // 一个页签的恢复/重试结果同步到另一个页签，避免两边重复接入
  window.addEventListener('storage', (event) => {
    if (event.key === MERGE_JOURNAL_KEY && event.newValue) {
      try {
        internal.set(JSON.parse(event.newValue) as MergeJournal[]);
      } catch {
        // 忽略半截写入
      }
    }
  });
}

function update(id: string, updater: (journal: MergeJournal) => MergeJournal) {
  internal.update((journals) => journals.map((journal) => (journal.id === id ? updater(journal) : journal)));
}

export const mergeJournalStore = {
  subscribe: internal.subscribe,

  create(input: Omit<MergeJournal, 'id' | 'createdAt' | 'status' | 'items'> & {
    items: MergeItem[];
  }): MergeJournal {
    const journal: MergeJournal = {
      ...input,
      id: makeId('MRG'),
      createdAt: new Date().toISOString(),
      status: 'prepared',
      items: input.items
    };
    internal.update((journals) => [journal, ...journals]);
    return journal;
  },

  markRunning(id: string) {
    update(id, (journal) => ({ ...journal, status: 'running' }));
  },

  markItem(id: string, itemId: string, patch: Partial<MergeItem>) {
    update(id, (journal) => ({
      ...journal,
      items: journal.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item))
    }));
  },

  markCompleted(id: string) {
    update(id, (journal) => ({
      ...journal,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      conflictDetail: undefined,
      items: journal.items.map((item) =>
        item.status === 'conflict' ? { ...item, status: 'done', error: undefined } : item
      )
    }));
  },

  markFailed(id: string, message: string) {
    update(id, (journal) => ({ ...journal, status: 'failed', conflictDetail: message }));
  },

  markConflict(id: string, message: string) {
    update(id, (journal) => ({ ...journal, status: 'conflict', conflictDetail: message }));
  },

  /** 冲突复核通过后，用当前 revision 重新生成尚未完成的条目（已接入项保持 done 不重复） */
  rebase(id: string, baseRevisions: Record<string, number>) {
    update(id, (journal) => ({
      ...journal,
      status: 'prepared',
      conflictDetail: undefined,
      baseRevisions,
      items: journal.items.map((item) =>
        item.status === 'done'
          ? item
          : { ...item, status: 'pending' as const, error: undefined }
      )
    }));
  },

  remove(id: string) {
    internal.update((journals) => journals.filter((journal) => journal.id !== id));
  }
};
