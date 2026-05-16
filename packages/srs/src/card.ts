import { createEmptyCard, type Card as FsrsCard } from "ts-fsrs";
import {
  type CardStateName,
  cardStateNameToState,
  stateToCardStateName,
} from "./state.js";

// The subset of `public.cards` columns FSRS cares about. Kept structural so
// callers can pass a raw Supabase row or a hand-rolled fixture without
// dragging @reverb/db into this package.
export interface StoredCardSnapshot {
  state: CardStateName;
  due_at: string | Date;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  elapsed_days: number;
  last_reviewed_at: string | Date | null;
}

// The columns we write back to `public.cards` after a review. Names mirror
// the database so the caller can `.update(toStoredCard(card))` directly.
export interface StoredCardUpdate {
  state: CardStateName;
  due_at: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  elapsed_days: number;
  last_reviewed_at: string | null;
}

// A freshly minted FSRS card snapshot, ready to insert into `public.cards`
// for a vocab item the user hasn't seen yet. Stored as the row's defaults
// (state='new', due_at=now, stability=0, etc.) — useful when materialising
// rows in code so the caller doesn't rely on Postgres defaults.
export function newStoredCard(now: Date = new Date()): StoredCardUpdate {
  return toStoredCard(createEmptyCard(now));
}

export function toFsrsCard(row: StoredCardSnapshot): FsrsCard {
  return {
    due: coerceDate(row.due_at),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsed_days: row.elapsed_days,
    scheduled_days: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: cardStateNameToState(row.state),
    last_review: row.last_reviewed_at ? coerceDate(row.last_reviewed_at) : undefined,
  };
}

export function toStoredCard(card: FsrsCard): StoredCardUpdate {
  return {
    state: stateToCardStateName(card.state),
    due_at: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    scheduled_days: card.scheduled_days,
    elapsed_days: card.elapsed_days,
    last_reviewed_at: card.last_review ? card.last_review.toISOString() : null,
  };
}

function coerceDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
