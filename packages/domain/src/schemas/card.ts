import { z } from "zod";

export const CardSchema = z.object({
  id: z.string().uuid(),
  deckId: z.string().uuid(),
  front: z.string().min(1),
  back: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Card = z.infer<typeof CardSchema>;
