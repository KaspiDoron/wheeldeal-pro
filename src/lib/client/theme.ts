// ONE PLACE THE THEME CHANGES.
//
// Before this, three actors each did half the job: the prehydrate script in
// layout.tsx stamped `data-theme` before paint, Profile's switchTheme stamped
// the attribute + localStorage, and nothing ever rewrote the live
// `<meta name="theme-color">` - so a toggle mid-session left the browser
// chrome (iOS status bar, Android address bar) painted in the OTHER theme's
// color. Every control that changes the theme now calls applyTheme(), and
// every reader asks readTheme().
//
// The prehydrate script stays separate ON PURPOSE (it must be an inline
// string that runs before any module loads), but it follows the same
// contract: validated wd_theme first, OS preference second - a test pins the
// two against each other.

import { useEffect, useState } from "react";
import { rememberLocal } from "@/lib/cookies/client";

export type Theme = "light" | "dark";

const STORAGE_KEY = "wd_theme";

// Mirrors the two `--bg` token values in globals.css - the browser chrome
// should sit on the app's canvas color.
const THEME_COLOR: Record<Theme, string> = {
  light: "#f4f6f9",
  dark: "#17191d",
};

/** The theme currently in effect: the stamped attribute first (the
 *  prehydrate script always sets it), then storage, then the OS. */
export function readTheme(): Theme {
  if (typeof document !== "undefined") {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark" || t === "light") return t;
  }
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s === "dark" || s === "light") return s;
  } catch {}
  try {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  } catch {}
  return "light";
}

/** Stamp the attribute (tokens + tailwind `dark:` follow it), persist the
 *  choice, and repaint the browser chrome. Safe when storage is blocked -
 *  the visual change still lands.
 *
 *  THE VISUAL CHANGE ALWAYS LANDS; ONLY THE MEMORY OF IT IS GATED. A traveller
 *  who declined preference cookies still gets the dark theme the moment they
 *  tap the toggle - refusing that would be punishing them for a privacy
 *  choice. What they do not get is it being remembered on the next visit,
 *  which is precisely and only what the cookie was for. Same shape as a
 *  blocked-storage device, which is why the write was already best-effort. */
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  rememberLocal(STORAGE_KEY, t);
  // The viewport meta list is resolved at load; rewrite the live tags so the
  // OS chrome follows the toggle without a reload. Both media-scoped tags
  // collapse to the chosen theme's color - an explicit choice overrides the
  // OS split on purpose.
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((m) => (m.content = THEME_COLOR[t]));
}

/** The live theme as React state - follows the `data-theme` attribute via a
 *  MutationObserver, so a topbar toggle re-renders theme-keyed content (the
 *  map tiles) that CSS variables alone cannot restyle. */
export function useAppTheme(): Theme {
  const [theme, setTheme] = useState<Theme>("light");
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.getAttribute("data-theme") === "dark" ? "dark" : "light");
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme;
}
