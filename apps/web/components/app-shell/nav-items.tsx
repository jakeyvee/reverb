import type { Route } from "next";
import type { ReactNode } from "react";
import { ChatIcon, HomeIcon, LessonsIcon, ProfileIcon } from "@/components/ui/icons";

export type NavItem = {
  href: Route;
  label: string;
  icon: ReactNode;
};

export const PRIMARY_NAV: NavItem[] = [
  { href: "/" as Route, label: "Home", icon: <HomeIcon /> },
  { href: "/lessons" as Route, label: "Lessons", icon: <LessonsIcon /> },
  { href: "/chat" as Route, label: "Chat", icon: <ChatIcon /> },
  { href: "/profile" as Route, label: "Profile", icon: <ProfileIcon /> },
];
