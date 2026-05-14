import { z } from "zod";

export const ReviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);
export type ReviewRating = z.infer<typeof ReviewRatingSchema>;

export const ReviewSchema = z.object({
  id: z.string().uuid(),
  cardId: z.string().uuid(),
  userId: z.string().uuid(),
  rating: ReviewRatingSchema,
  reviewedAt: z.string().datetime(),
});

export type Review = z.infer<typeof ReviewSchema>;
