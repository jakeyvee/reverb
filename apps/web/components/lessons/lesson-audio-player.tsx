"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  signedUrl: string;
  mimeType?: string | null;
};

// Native <audio> wrapped in a card so it inherits the page's surface colour and
// keeps a sensible width on narrow viewports. We surface a friendly error if
// the signed URL has expired or the browser can't decode the file — the
// detail page is the only place a user can spot-check raw audio playback, so
// silent failure here is worse than usual.
export function LessonAudioPlayer({ signedUrl, mimeType }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onError = () => {
      setError(
        "We couldn't play this audio. The download link may have expired — refresh the page to retry.",
      );
    };
    el.addEventListener("error", onError);
    return () => el.removeEventListener("error", onError);
  }, []);

  return (
    <div className="space-y-2">
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        className="w-full"
        // `type` helps Safari pick the right decoder for `audio/mp4`; falling
        // back to the bare `src` attribute when we don't know the type.
        src={mimeType ? undefined : signedUrl}
      >
        {mimeType ? <source src={signedUrl} type={mimeType} /> : null}
        Your browser doesn&apos;t support the audio element.
      </audio>
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
