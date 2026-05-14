export const DEMO_LESSON_ID = "demo-traveler-bahasa";

export type DemoCard = {
  front: string;
  back: string;
  pronunciation?: string;
};

export type DemoLesson = {
  id: string;
  title: string;
  language: string;
  description: string;
  level: string;
  cards: DemoCard[];
};

export const DEMO_LESSON: DemoLesson = {
  id: DEMO_LESSON_ID,
  title: "Traveler's Bahasa — Day 1",
  language: "Bahasa Indonesia",
  level: "Beginner",
  description:
    "A short demo lesson covering greetings, ordering food, and getting around. Replace it by uploading your first lesson.",
  cards: [
    { front: "Hello", back: "Halo", pronunciation: "HAH-loh" },
    { front: "Thank you", back: "Terima kasih", pronunciation: "tuh-REE-mah KAH-see" },
    { front: "Excuse me", back: "Permisi", pronunciation: "pehr-MEE-see" },
    { front: "How much?", back: "Berapa harganya?", pronunciation: "buh-RAH-pah HAR-gah-nyah" },
    { front: "Where is the toilet?", back: "Di mana toilet?", pronunciation: "dee MAH-nah TOY-let" },
    { front: "Water, please", back: "Air, tolong", pronunciation: "AH-yer TOH-long" },
    { front: "Delicious", back: "Enak", pronunciation: "EH-nak" },
    { front: "I don't understand", back: "Saya tidak mengerti", pronunciation: "SAH-yah TEE-dak muhng-ER-tee" },
  ],
};
