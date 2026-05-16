import { State } from "ts-fsrs";

// The cards table stores state as a Postgres enum with these four members.
// Kept as a string union to avoid forcing the database types package on
// callers that only want to talk to ts-fsrs.
export type CardStateName = "new" | "learning" | "review" | "relearning";

const NAME_TO_STATE: Record<CardStateName, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const STATE_TO_NAME: Record<State, CardStateName> = {
  [State.New]: "new",
  [State.Learning]: "learning",
  [State.Review]: "review",
  [State.Relearning]: "relearning",
};

export function cardStateNameToState(name: CardStateName): State {
  return NAME_TO_STATE[name];
}

export function stateToCardStateName(state: State): CardStateName {
  return STATE_TO_NAME[state];
}
