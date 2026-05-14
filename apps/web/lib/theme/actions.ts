"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isTheme, THEME_COOKIE, type Theme } from "./cookie";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function setTheme(next: Theme | string): Promise<void> {
  if (!isTheme(next)) return;
  const store = await cookies();
  store.set(THEME_COOKIE, next, {
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
