import { fsrs, generatorParameters, Rating, type Card as FsrsCard } from "ts-fsrs";
import type { ReviewRating } from "@reverb/domain";

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

export { Rating } from "ts-fsrs";
export type { Card as FsrsCard, ReviewLog } from "ts-fsrs";
