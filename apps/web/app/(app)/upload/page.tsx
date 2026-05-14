import { Card, EmptyState, SectionHeader } from "@/components/ui/card";
import { UploadIcon } from "@/components/ui/icons";
import { requireUser } from "@/lib/auth/get-user";

export default async function UploadPage() {
  const user = await requireUser();

  if (!user.isVincent) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Upload</h1>
          <p className="mt-1 text-sm text-foreground-muted">
            Only the household&apos;s upload account can add new lessons.
          </p>
        </header>

        <Card className="flex flex-col items-center gap-3 border-dashed py-12 text-center">
          <p className="text-sm font-medium">No upload access</p>
          <p className="max-w-sm text-xs text-foreground-subtle">
            Ask Vincent to drop the next lesson here. New cards show up on your home screen as soon
            as they&apos;re processed.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Upload</h1>
        <p className="mt-1 text-sm text-foreground-muted">
          Drop a transcript, audio file, or screenshot to generate cards.
        </p>
      </header>

      <Card className="flex flex-col items-center gap-3 border-dashed py-12">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-muted text-foreground-subtle">
          <UploadIcon width={20} height={20} />
        </span>
        <p className="text-sm font-medium">Upload coming soon</p>
        <p className="max-w-sm text-center text-xs text-foreground-subtle">
          The pipeline that turns raw files into spaced-repetition cards is wired up in a later
          ticket.
        </p>
      </Card>

      <section>
        <SectionHeader title="Recent uploads" />
        <EmptyState
          title="No uploads yet"
          description="Once you upload a file you'll see its processing status here."
        />
      </section>
    </div>
  );
}
