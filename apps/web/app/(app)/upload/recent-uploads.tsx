import { EmptyState, SectionHeader } from "@/components/ui/card";
import { LessonStatusList } from "@/components/lessons/lesson-status-list";
import { loadLessonStatusRows } from "@/lib/lessons/status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function RecentUploads() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return (
      <section>
        <SectionHeader title="Recent uploads" />
        <EmptyState
          title="Storage isn't configured"
          description="Set NEXT_PUBLIC_SUPABASE_URL and the anon key to start uploading lessons."
        />
      </section>
    );
  }

  const rows = await loadLessonStatusRows({ limit: 10 });

  if (rows.length === 0) {
    return (
      <section>
        <SectionHeader title="Recent uploads" />
        <EmptyState
          title="No uploads yet"
          description="Once you upload a file you'll see its processing status here."
        />
      </section>
    );
  }

  return (
    <section>
      <SectionHeader title="Recent uploads" />
      <LessonStatusList rows={rows} />
    </section>
  );
}
