import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, SectionHeader } from "@/components/ui/card";
import { DEMO_LESSON, DEMO_LESSON_ID } from "@/lib/demo/lesson";
import { PlayIcon } from "@/components/ui/icons";

type Props = {
  params: Promise<{ lessonId: string }>;
};

export default async function LessonDetailPage({ params }: Props) {
  const { lessonId } = await params;
  if (lessonId !== DEMO_LESSON_ID) notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/lessons"
          className="text-xs text-foreground-subtle transition hover:text-foreground"
        >
          ← Lessons
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight md:text-2xl">
          {DEMO_LESSON.title}
        </h1>
        <p className="mt-1 text-sm text-foreground-muted">{DEMO_LESSON.description}</p>
        <p className="mt-2 text-xs text-foreground-subtle">
          {DEMO_LESSON.language} · {DEMO_LESSON.level} · {DEMO_LESSON.cards.length} cards
        </p>
      </div>

      <Link
        href="/session"
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-foreground transition hover:opacity-90"
      >
        <PlayIcon width={16} height={16} />
        Start session
      </Link>

      <section>
        <SectionHeader title="Cards" />
        <ul className="space-y-2">
          {DEMO_LESSON.cards.map((card, i) => (
            <li key={i}>
              <Card className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-wider text-foreground-subtle">
                    Card {i + 1}
                  </p>
                  <p className="mt-0.5 truncate text-sm font-medium">{card.front}</p>
                </div>
                <div className="text-sm text-foreground-muted sm:text-right">
                  <p className="truncate">{card.back}</p>
                  {card.pronunciation ? (
                    <p className="mt-0.5 text-xs text-foreground-subtle">{card.pronunciation}</p>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
