import { Card } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/get-user";
import { RecentUploads } from "./recent-uploads";
import { UploadForm } from "./upload-form";

export const dynamic = "force-dynamic";

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
          Drop a lesson recording — we&apos;ll transcribe it and turn it into cards.
        </p>
      </header>

      <UploadForm />

      <RecentUploads />
    </div>
  );
}
