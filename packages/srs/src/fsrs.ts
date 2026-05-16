import { fsrs, generatorParameters, Rating, type Card as FsrsCard } from "ts-fsrs";
import type { ReviewRating } from "@reverb/domain";
import {
  type StoredCardSnapshot,
  type StoredCardUpdate,
  toFsrsCard,
  toStoredCard,
} from "./card.js";
import { type CardStateName } from "./state.js";

const scheduler = fsrs(generatorParameters({ enable_fuzz: true, enable_short_term: true }));

type GradeRating = Rating.Again | Rating.Hard | Rating.Good | Rating.Easy;

const RATING_MAP: Record<ReviewRating, GradeRating> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export interface ScheduleInput {
  card: FsrsCard;
  rating: ReviewRating;
  now?: Date;
}

export function scheduleNext({ card, rating, now = new Date() }: ScheduleInput) {
  const scheduling = scheduler.repeat(card, now);
  const entry = scheduling[RATING_MAP[rating]];
  if (!entry) throw new Error(`No scheduling result for rating: ${rating}`);
  return { card: entry.card, reviewLog: entry.log };
}

export interface ScheduleStoredInput {
  card: StoredCardSnapshot;
  rating: ReviewRating;
  now?: Date;
}

// Convenience wrapper for the most common path: read a row from `public.cards`,
// schedule the next review, and write the result back. Returns both the
// stored-shape update and the pre-review snapshot so the caller can record an
// append-only `card_reviews` row with previous/next state captured atomically.
export interface ScheduleStoredOutput {
  previous: {
    state: CardStateName;
    stability: number;
    difficulty: number;
  };
  next: StoredCardUpdate;
  reviewedAt: Date;
}

export function scheduleStoredReview({
  card,
  rating,
  now = new Date(),
}: ScheduleStoredInput): ScheduleStoredOutput {
  const fsrsCard = toFsrsCard(card);
  const result = scheduleNext({ card: fsrsCard, rating, now });
  return {
    previous: {
      state: card.state,
      stability: card.stability,
      difficulty: card.difficulty,
    },
    next: toStoredCard(result.card),
    reviewedAt: now,
  };
}

export { Rating } from "ts-fsrs";
export type { Card as FsrsCard, ReviewLog } from "ts-fsrs";
