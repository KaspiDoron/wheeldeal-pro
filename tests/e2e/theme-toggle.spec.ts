import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour } from "./fixtures/init";

// Wave 2.1: the dark theme is an ATTRIBUTE system ([data-theme="dark"]) with
// an explicit override persisted in wd_theme and a live theme-color meta
// rewrite. The split-brain failure this guards: Tailwind dark: utilities
// keying on the OS while the tokens keyed on the attribute.

test.describe("theme toggle", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    // "persists across reload" is a claim about the `preferences` cookie
    // category: rememberLocal refuses to keep the theme under "essential only"
    // (the flip itself still lands). Grant it, so the spec tests what it says.
    await signIn(context, undefined, { cookieChoice: "accept-all" });
  });

  test("toggling flips the attribute, rewrites theme-color, and persists across reload", async ({
    page,
  }) => {
    await seedLiveHunt(page);
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Toggle dark mode" }).first();
    await expect(toggle).toBeVisible({ timeout: 20_000 });

    const before = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
    await toggle.click();
    const after = await page.evaluate(() => ({
      attr: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("wd_theme"),
      meta: document.querySelector('meta[name="theme-color"]')?.getAttribute("content") ?? null,
    }));
    expect(after.attr).not.toBe(before);
    expect(after.attr === "dark" || after.attr === "light").toBe(true);
    expect(after.stored).toBe(after.attr);
    // The browser chrome follows the canvas - a dark page under a light
    // status bar was half the "split brain" screenshot.
    expect(after.meta).toBe(after.attr === "dark" ? "#17191d" : "#f4f6f9");

    await page.reload();
    const persisted = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    expect(persisted).toBe(after.attr);
  });

  test("the explicit choice beats the OS preference (prehydrate order)", async ({
    page,
    context,
  }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("wd_theme", "dark");
      } catch {
        /* private mode */
      }
    });
    await page.emulateMedia({ colorScheme: "light" });
    await seedLiveHunt(page);
    await page.goto("/");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
      "dark"
    );
  });
});
