import { z } from "zod";
import {
  CHAT_CORRECTION_KINDS,
  ChatCorrectionSchema,
  ChatLevelSchema,
  ChatVocabContextItemSchema,
  type ChatCorrection,
  type ChatCorrectionHistoryItem,
  type ChatLevel,
  type ChatVocabContextItem,
} from "./chat.js";

// Travel role-play scenarios (VOL-133).
//
// Fixed PRD scenarios that drop the learner into a constrained Bahasa
// Indonesia conversation with a counterpart persona (waiter, taxi driver,
// market seller, …). Each definition is the static blueprint the AI adapter
// reads to build the role-play system prompt — lesson vocab is layered on at
// call time, but the persona, setting, and goal are pinned per scenario so
// the practice stays comparable across sessions and partners.

export const SCENARIO_IDS = [
  "ordering-food",
  "taxi",
  "hotel-check-in",
  "market-bargaining",
  "asking-directions",
  "pharmacy",
  "beach-rental",
  "ojek-grab",
] as const;

export const ScenarioIdSchema = z.enum(SCENARIO_IDS);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

// Flat XP award on completion. Kept as a small fixed value because a
// scenario is roughly one drill's worth of practice and we don't want it to
// out-scale daily session XP.
export const SCENARIO_COMPLETION_XP = 10;

// Soft caps on a single scenario practice. The model is told to wrap up at
// or before this many user turns; the server also refuses to accept further
// turns once the cap is reached so a runaway session can't burn tokens.
export const SCENARIO_MAX_USER_TURNS = 16;

// Per-message char cap. Matches the chat field; trims pasted essays before
// they reach Anthropic.
export const SCENARIO_USER_MESSAGE_MAX_CHARS = 800;

// Default counts of household lesson vocab to merge into the prompt. Smaller
// than the chat budget because the scenario prompt already carries a hefty
// persona block — we lean on the scenario-specific suggested vocab below.
export const SCENARIO_KNOWN_VOCAB_LIMIT = 12;
export const SCENARIO_RECENT_VOCAB_LIMIT = 10;
export const SCENARIO_RECENT_CORRECTION_LIMIT = 4;

export const ScenarioDefinitionSchema = z.object({
  id: ScenarioIdSchema,
  title: z.string().min(1),
  // One-line English blurb the picker card renders under the title.
  shortDescription: z.string().min(1),
  // Where the role-play is set, in English. Becomes the "Scene:" line in
  // the system prompt.
  setting: z.string().min(1),
  // English description of who the learner is in the scene.
  userRole: z.string().min(1),
  // English description of the AI's persona — the prompt is written
  // second-person to the model so this reads "You are …".
  counterpartRole: z.string().min(1),
  // What the AI says to kick the scene off. Indonesian, short, in
  // character — the UI renders this as the first assistant turn before the
  // learner has typed anything.
  counterpartOpening: z.string().min(1),
  // Bullet list of things the learner should accomplish to "finish" the
  // scene. Shown in the UI as a checklist hint and pasted into the prompt
  // so the model knows when to wind things down naturally.
  goals: z.array(z.string().min(1)).min(1),
  // Scenario-specific Bahasa vocab the prompt should prefer when possible.
  // Mixed with the user's known + recent lesson vocab so the practice still
  // exercises their personal deck while staying on-theme.
  suggestedVocab: z.array(z.string().min(1)).min(1),
  // English description of when the scene reaches a natural end. The
  // prompt forwards this to the model so it can choose to politely close
  // (rather than hovering forever).
  completionHint: z.string().min(1),
});
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;

// Canonical scenario list. The web layer reads from here; the AI adapter
// reads from here. Treat as readonly — runtime additions belong in a new
// migration + a new id literal above.
export const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  {
    id: "ordering-food",
    title: "Ordering food at a warung",
    shortDescription: "Order a meal and a drink at a casual Indonesian warung.",
    setting:
      "A bustling neighbourhood warung at lunchtime. Plastic tables, hand-written menu on the wall.",
    userRole: "A tourist sitting down to order lunch.",
    counterpartRole: "A friendly warung owner who knows the menu by heart and is happy to help.",
    counterpartOpening: "Selamat siang! Mau pesan apa hari ini?",
    goals: [
      "Greet and ask for a recommendation.",
      "Order at least one dish and one drink, specifying spice level if relevant.",
      "Ask for the bill at the end.",
    ],
    suggestedVocab: [
      "pesan",
      "nasi goreng",
      "mie goreng",
      "es teh",
      "air putih",
      "pedas",
      "tidak pedas",
      "enak",
      "bisa minta menu",
      "bayar",
      "berapa",
      "terima kasih",
    ],
    completionHint: "The learner has placed an order and asked for the bill.",
  },
  {
    id: "taxi",
    title: "Taking a metered taxi",
    shortDescription: "Get into a Bluebird-style metered taxi and direct it to your destination.",
    setting: "Inside a Jakarta metered taxi pulling away from a hotel.",
    userRole: "A traveller heading to a specific destination across town.",
    counterpartRole:
      "A professional Bluebird-style taxi driver. Polite, uses 'Pak/Bu', cares about traffic.",
    counterpartOpening: "Selamat sore, Pak/Bu. Tujuan ke mana?",
    goals: [
      "Tell the driver the destination clearly.",
      "Discuss the route or whether to use a toll road.",
      "Ask roughly how long the trip will take and the approximate fare.",
    ],
    suggestedVocab: [
      "tolong antar",
      "alamat",
      "jalan",
      "tol",
      "macet",
      "lewat",
      "kanan",
      "kiri",
      "lurus",
      "berhenti di sini",
      "argo",
      "berapa kira-kira",
    ],
    completionHint: "The learner has agreed on the destination, route, and rough fare or duration.",
  },
  {
    id: "hotel-check-in",
    title: "Checking into a hotel",
    shortDescription: "Arrive at a small hotel and check into a reserved room.",
    setting: "The front desk of a small boutique hotel in Ubud. Quiet lobby, evening.",
    userRole: "A guest with a reservation who has just arrived.",
    counterpartRole:
      "A warm, professional hotel receptionist who looks up reservations and explains hotel amenities.",
    counterpartOpening: "Selamat datang di hotel kami. Ada reservasi atas nama siapa?",
    goals: [
      "Confirm the reservation by name and dates.",
      "Ask about breakfast time and Wi-Fi.",
      "Receive the room key and politely thank the receptionist.",
    ],
    suggestedVocab: [
      "reservasi",
      "atas nama",
      "kamar",
      "kunci",
      "sarapan",
      "jam berapa",
      "wifi",
      "lantai",
      "lift",
      "paspor",
      "check in",
      "terima kasih",
    ],
    completionHint:
      "The learner has confirmed the booking, asked about breakfast/Wi-Fi, and received a room key.",
  },
  {
    id: "market-bargaining",
    title: "Bargaining at a market",
    shortDescription: "Negotiate a fair price for a souvenir at a traditional market stall.",
    setting:
      "A souvenir stall at a busy traditional market. Wooden carvings, batik, fans on display.",
    userRole:
      "A polite traveller interested in buying a souvenir but reluctant to pay the first price.",
    counterpartRole:
      "A market vendor who quotes a high opening price, expects friendly haggling, and meets the buyer partway.",
    counterpartOpening: "Mari, mari, lihat-lihat dulu. Ini bagus, kualitas nomor satu!",
    goals: [
      "Ask about an item and its price.",
      "Counter-offer at least once, politely.",
      "Either close the deal or politely walk away.",
    ],
    suggestedVocab: [
      "berapa harganya",
      "mahal",
      "kemahalan",
      "boleh kurang",
      "diskon",
      "tawar",
      "terlalu mahal",
      "harga pas",
      "saya beli",
      "lihat-lihat dulu",
      "bagus",
      "warna",
    ],
    completionHint: "A price has been agreed on or the learner has politely declined.",
  },
  {
    id: "asking-directions",
    title: "Asking for directions",
    shortDescription: "Stop a friendly local on the street and ask how to get somewhere.",
    setting: "A quiet residential street. The learner is on foot and a little lost.",
    userRole: "A traveller who is unsure where to go next.",
    counterpartRole:
      "A patient local who knows the area well and gives clear, simple directions step by step.",
    counterpartOpening: "Iya, ada yang bisa saya bantu?",
    goals: [
      "Politely interrupt and ask for help.",
      "Ask where a specific place is.",
      "Confirm whether to turn, go straight, or take a particular landmark.",
    ],
    suggestedVocab: [
      "permisi",
      "maaf",
      "tanya",
      "di mana",
      "ke arah mana",
      "belok kanan",
      "belok kiri",
      "lurus",
      "perempatan",
      "lampu merah",
      "dekat",
      "jauh",
    ],
    completionHint: "The learner has been given step-by-step directions and thanked the local.",
  },
  {
    id: "pharmacy",
    title: "Visiting a pharmacy",
    shortDescription: "Describe a mild symptom at a pharmacy and pick up something safe to take.",
    setting: "A small neighbourhood apotek. Shelves of vitamins behind the counter.",
    userRole:
      "A traveller with a mild ailment (headache, cough, upset stomach, sunburn) — choose one.",
    counterpartRole:
      "A pharmacist who asks careful follow-up questions before recommending an over-the-counter remedy.",
    counterpartOpening: "Selamat siang. Ada yang bisa saya bantu? Sakit apa?",
    goals: [
      "Describe the symptom in one or two short sentences.",
      "Answer at least one follow-up question (how long, severity, allergies).",
      "Receive a recommendation and ask about how to take it.",
    ],
    suggestedVocab: [
      "sakit kepala",
      "batuk",
      "demam",
      "perut",
      "obat",
      "resep",
      "alergi",
      "minum",
      "berapa kali sehari",
      "sesudah makan",
      "panas",
      "flu",
    ],
    completionHint:
      "The learner has described a symptom, answered a follow-up, and learned how to take the recommended remedy.",
  },
  {
    id: "beach-rental",
    title: "Renting a beach activity",
    shortDescription: "Rent a surfboard, snorkel set, or jet ski at a beach kiosk.",
    setting:
      "A wooden kiosk on a Balinese beach with surfboards, snorkels, and a jet ski moored nearby.",
    userRole: "A traveller deciding which beach activity to rent.",
    counterpartRole:
      "An easy-going beach rental clerk who lists what's available, quotes hourly prices, and explains safety rules.",
    counterpartOpening: "Halo, mau coba apa hari ini? Selancar, snorkel, atau jet ski?",
    goals: [
      "Choose an activity and the rental duration.",
      "Confirm the price and any deposit.",
      "Ask about safety rules or what's included.",
    ],
    suggestedVocab: [
      "sewa",
      "papan selancar",
      "snorkel",
      "jet ski",
      "per jam",
      "harga",
      "deposit",
      "pelampung",
      "berapa lama",
      "aman",
      "ombak",
      "panduan",
    ],
    completionHint:
      "The learner has picked an activity, agreed on duration and price, and confirmed at least one safety detail.",
  },
  {
    id: "ojek-grab",
    title: "Booking an ojek / Grab",
    shortDescription:
      "Confirm pickup and destination with a Grab/ojek driver who has just called you.",
    setting:
      "Standing on the curb after booking a Grab/Gojek ride. The driver is calling to confirm.",
    userRole: "A traveller who just booked a ride and is waiting for the driver.",
    counterpartRole:
      "A friendly Gojek/Grab driver checking the pickup spot, double-checking the destination, and asking what the rider is wearing.",
    counterpartOpening: "Halo, ini Gojek ya. Posisinya di mana sekarang?",
    goals: [
      "Describe the pickup landmark in one short sentence.",
      "Confirm the destination matches what's in the app.",
      "Tell the driver what you're wearing so they can spot you.",
    ],
    suggestedVocab: [
      "ojek",
      "posisi",
      "depan",
      "samping",
      "minimarket",
      "tujuan",
      "alamat",
      "pakai baju",
      "warna",
      "topi",
      "helm",
      "menunggu",
    ],
    completionHint:
      "The learner has confirmed the pickup spot, the destination, and what they're wearing.",
  },
];

if (SCENARIO_DEFINITIONS.length !== SCENARIO_IDS.length) {
  // Compile-time-ish guard: every id must have a matching definition and
  // vice versa. The picker / runner reads these by id and would otherwise
  // fall back to "scenario not found" at request time.
  throw new Error("SCENARIO_DEFINITIONS is out of sync with SCENARIO_IDS");
}

export function getScenarioDefinition(id: ScenarioId): ScenarioDefinition {
  const found = SCENARIO_DEFINITIONS.find((s) => s.id === id);
  if (!found) {
    throw new Error(`Unknown scenario id: ${id}`);
  }
  return found;
}

// Context payload the AI adapter consumes. Mirrors ChatConversationContext
// shape so the existing vocab/correction loaders in `lib/chat/sessions.ts`
// can be reused via a shared helper without duplicating Supabase reads.
export const ScenarioConversationContextSchema = z.object({
  scenarioId: ScenarioIdSchema,
  level: ChatLevelSchema,
  knownVocab: z.array(ChatVocabContextItemSchema).default([]),
  recentLessonVocab: z.array(ChatVocabContextItemSchema).default([]),
  recentCorrections: z
    .array(
      z.object({
        sourceText: z.string().min(1),
        correctedText: z.string().min(1),
        kind: z.enum(CHAT_CORRECTION_KINDS).optional(),
      }),
    )
    .default([]),
  // The number of user turns elapsed so far — the prompt uses this to
  // nudge the model to start wrapping up as it nears SCENARIO_MAX_USER_TURNS.
  userTurnCount: z.number().int().nonnegative().default(0),
});
export type ScenarioConversationContext = z.infer<typeof ScenarioConversationContextSchema>;

// Structured assistant payload. Distinct from the chat schema because the
// scenario model also signals when it believes the scene is over: the web
// layer treats `sceneComplete: true` as the cue to offer the user a "Finish
// & claim XP" button (or auto-finalise on the next round-trip).
export const ScenarioAssistantResponseSchema = z.object({
  reply: z.string().min(1),
  replyLanguage: z.string().min(2).default("id"),
  corrections: z.array(ChatCorrectionSchema).default([]),
  // True when the model thinks the user has accomplished the scenario's
  // goals (paid the bill, agreed on the fare, etc.). UI surfaces a finish
  // button when this flips. The server still validates completion server-
  // side before awarding XP.
  sceneComplete: z.boolean().default(false),
});
export type ScenarioAssistantResponse = z.infer<typeof ScenarioAssistantResponseSchema>;

// Re-exports so callers depending on @reverb/domain don't have to import
// chat types from a second symbol path.
export type ScenarioVocabContextItem = ChatVocabContextItem;
export type ScenarioCorrection = ChatCorrection;
export type ScenarioCorrectionHistoryItem = ChatCorrectionHistoryItem;
export type ScenarioLevel = ChatLevel;
