import { createServiceRoleClient } from "./server.js";

export async function seed() {
  const supabase = createServiceRoleClient();
  void supabase;
  return { ok: true as const };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then((result) => {
      console.log("seed complete", result);
    })
    .catch((err) => {
      console.error("seed failed", err);
      process.exit(1);
    });
}
