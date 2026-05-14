export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <h1 className="text-4xl font-semibold tracking-tight">Reverb</h1>
      <p className="text-lg text-slate-600">
        Spaced-repetition flashcards with AI-generated content. Scaffold ready — wire up Supabase,
        the AI providers, and the FSRS scheduler from <code>packages/*</code>.
      </p>
    </main>
  );
}
