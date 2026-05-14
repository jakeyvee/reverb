import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";

const HelloPayload = z.object({
  name: z.string().min(1),
});

export const helloTask = task({
  id: "hello",
  run: async (payloadInput: unknown) => {
    const payload = HelloPayload.parse(payloadInput);
    return { greeting: `Hello, ${payload.name}!` };
  },
});
