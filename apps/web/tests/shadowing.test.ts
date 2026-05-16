import { describe, expect, it } from "vitest";
import {
  SHADOWING_CLIP_MAX_DURATION_MS,
  SHADOWING_CLIP_MIN_DURATION_MS,
  SHADOWING_XP_PER_PASS,
  isShadowableClip,
} from "@/lib/session/shadowing";

// Pins the policy the runner enforces before it picks a clip for the
// shadowing card: we never queue an unmaterialised clip, an out-of-bounds
// clip, or a clip the materialiser explicitly dropped. The duration window
// (1-8s) is the same one VOL-126 used in the lesson pipeline; keeping a
// dedicated test here means the orchestrator can't slip past the policy
// without somebody noticing.

describe("isShadowableClip", () => {
  const baseMaterialization = {
    materialized_at: "2026-05-10T12:00:00.000Z",
    audio_storage_path: "household/lesson/clips/dialogue/1000-4000.mp3",
    audio_duration_ms: 3000,
    skip_reason: null,
  };

  it("accepts a fully materialised clip inside the duration window", () => {
    expect(
      isShadowableClip({
        start_ms: 1000,
        end_ms: 4000,
        metadata: { materialization: baseMaterialization },
      }),
    ).toBe(true);
  });

  it("rejects clips without a materialisation marker", () => {
    expect(isShadowableClip({ start_ms: 1000, end_ms: 4000, metadata: {} })).toBe(false);
    expect(
      isShadowableClip({
        start_ms: 1000,
        end_ms: 4000,
        metadata: { materialization: { skip_reason: null } },
      }),
    ).toBe(false);
  });

  it("rejects clips the materialiser dropped", () => {
    expect(
      isShadowableClip({
        start_ms: 1000,
        end_ms: 4000,
        metadata: {
          materialization: { ...baseMaterialization, skip_reason: "above_max_duration" },
        },
      }),
    ).toBe(false);
  });

  it("rejects clips shorter than the policy floor", () => {
    expect(
      isShadowableClip({
        start_ms: 0,
        end_ms: 500,
        metadata: {
          materialization: {
            ...baseMaterialization,
            audio_duration_ms: SHADOWING_CLIP_MIN_DURATION_MS - 1,
          },
        },
      }),
    ).toBe(false);
  });

  it("rejects clips longer than the policy ceiling", () => {
    expect(
      isShadowableClip({
        start_ms: 0,
        end_ms: 20_000,
        metadata: {
          materialization: {
            ...baseMaterialization,
            audio_duration_ms: SHADOWING_CLIP_MAX_DURATION_MS + 1,
          },
        },
      }),
    ).toBe(false);
  });

  it("falls back to start/end range when audio_duration_ms is missing", () => {
    expect(
      isShadowableClip({
        start_ms: 0,
        end_ms: 2000,
        metadata: {
          materialization: {
            audio_storage_path: "household/lesson/clips/dialogue/0-2000.mp3",
            skip_reason: null,
            materialized_at: "2026-05-10T12:00:00.000Z",
          },
        },
      }),
    ).toBe(true);
  });
});

describe("SHADOWING_XP_PER_PASS", () => {
  it("awards positive XP on a got-it self-mark", () => {
    expect(SHADOWING_XP_PER_PASS).toBeGreaterThan(0);
  });
});
