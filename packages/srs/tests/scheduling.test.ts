import { describe, expect, it } from "vitest";
import {
  newStoredCard,
  scheduleStoredReview,
  type StoredCardSnapshot,
} from "../src/index.js";

const NOW = new Date("2026-05-15T10:00:00.000Z");

// Builds the same shape a freshly inserted row in `public.cards` would have:
// state='new', due_at=now, all FSRS counters zeroed.
function freshCardRow(now: Date = NOW): StoredCardSnapshot {
  return {
    ...newStoredCard(now),
  };
}

describe("scheduleStoredReview — first review", () => {
  it("moves a new card forward and records prior state", () => {
    const card = freshCardRow();

    const result = scheduleStoredReview({ card, rating: "good", now: NOW });

    expect(result.previous.state).toBe("new");
    expect(result.previous.stability).toBe(0);
    expect(result.previous.difficulty).toBe(0);
    // FSRS leaves a card in either 'learning' or 'review' after the first
    // grade depending on configuration; both are valid here.
    expect(["learning", "review"]).toContain(result.next.state);
    expect(result.next.reps).toBe(1);
    expect(result.next.lapses).toBe(0);
    expect(result.next.stability).toBeGreaterThan(0);
    expect(result.next.difficulty).toBeGreaterThan(0);
    expect(new Date(result.next.due_at).getTime()).toBeGreaterThan(NOW.getTime());
    expect(result.next.last_reviewed_at).toBe(NOW.toISOString());
  });

  it("an 'again' grade on a new card increments lapses and stays in (re)learning", () => {
    const card = freshCardRow();

    const result = scheduleStoredReview({ card, rating: "again", now: NOW });

    expect(result.next.reps).toBe(1);
    expect(["learning", "relearning"]).toContain(result.next.state);
    expect(new Date(result.next.due_at).getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("'easy' schedules further out than 'good'", () => {
    const card = freshCardRow();

    const good = scheduleStoredReview({ card, rating: "good", now: NOW });
    const easy = scheduleStoredReview({ card, rating: "easy", now: NOW });

    expect(new Date(easy.next.due_at).getTime()).toBeGreaterThanOrEqual(
      new Date(good.next.due_at).getTime(),
    );
  });
});

describe("scheduleStoredReview — repeated review", () => {
  it("subsequent 'good' grades grow stability and push due_at out", () => {
    const first = scheduleStoredReview({
      card: freshCardRow(),
      rating: "good",
      now: NOW,
    });

    // Re-load as if we'd written the result back to the database and pulled
    // it out again for the next session.
    const later = new Date(first.next.due_at);
    const second = scheduleStoredReview({
      card: { ...first.next },
      rating: "good",
      now: later,
    });

    expect(second.previous.state).toBe(first.next.state);
    expect(second.previous.stability).toBe(first.next.stability);
    expect(second.previous.difficulty).toBe(first.next.difficulty);
    expect(second.next.reps).toBe(2);
    expect(second.next.stability).toBeGreaterThan(first.next.stability);
    expect(new Date(second.next.due_at).getTime()).toBeGreaterThan(later.getTime());
  });

  it("an 'again' on a learnt card lapses it and resets state to (re)learning", () => {
    const learnt = scheduleStoredReview({
      card: freshCardRow(),
      rating: "easy",
      now: NOW,
    });
    const reviewAt = new Date(learnt.next.due_at);

    const lapsed = scheduleStoredReview({
      card: { ...learnt.next },
      rating: "again",
      now: reviewAt,
    });

    expect(lapsed.next.lapses).toBe(learnt.next.lapses + 1);
    expect(["learning", "relearning"]).toContain(lapsed.next.state);
    expect(new Date(lapsed.next.due_at).getTime()).toBeGreaterThan(reviewAt.getTime());
  });
});
