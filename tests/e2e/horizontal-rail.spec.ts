import { test, expect } from "@playwright/test";
import { signIn } from "./fixtures/session";
import { seedLiveHunt } from "./fixtures/seeds";
import { dismissTour, assertNoOverflow } from "./fixtures/init";

// Wave 3.1: the horizontal vendor mode is a sibling RAIL (its own
// overflow-x scroller), toggled from the Filters sort row and persisted in
// wd_list_axis. The page body must never scroll horizontally - only the rail.

test.describe("horizontal vendor rail @allwidths", () => {
  test.beforeEach(async ({ context }) => {
    await dismissTour(context);
    // This spec asserts the axis choice PERSISTS across a reload, and memory
    // of a preference is gated on the `preferences` cookie category
    // (rememberLocal refuses to write it under "essential only"). Grant it.
    await signIn(context, undefined, { cookieChoice: "accept-all" });
  });

  test("Swipe mode renders the snap rail, the strip scrolls - not the page - and it persists", async ({
    page,
  }) => {
    await seedLiveHunt(page);
    await page.goto("/");
    await expect(page.locator('[data-tour="vendors"]')).toBeAttached({ timeout: 20_000 });
    await page.locator('[data-tour="vendors"]').scrollIntoViewIfNeeded();

    const swipe = page.getByRole("button", { name: "↔ Swipe" });
    await expect(swipe).toBeVisible();
    await swipe.click();

    const rail = page.locator(".snap-x.overflow-x-auto");
    await expect(rail.first()).toBeVisible();
    // The rail's content is wider than the viewport (that is the point) while
    // the PAGE stays put - the repo's own wide-element rule.
    const railScrolls = await rail.first().evaluate((el) => el.scrollWidth > el.clientWidth + 10);
    expect(railScrolls).toBe(true);
    await assertNoOverflow(page, "horizontal rail mode");
    expect(await page.evaluate(() => localStorage.getItem("wd_list_axis"))).toBe("horizontal");

    // The choice survives a reload (wd_local_lang pattern).
    await page.reload();
    await expect(page.locator('[data-tour="vendors"]')).toBeAttached({ timeout: 20_000 });
    await page.locator('[data-tour="vendors"]').scrollIntoViewIfNeeded();
    await expect(page.locator(".snap-x.overflow-x-auto").first()).toBeVisible();

    // ...and Feed flips it back. Exact name: /Feed/ would also hit the
    // TabBar's "Feedback" button (strict-mode collision).
    await page.getByRole("button", { name: "↕ Feed" }).click();
    expect(await page.evaluate(() => localStorage.getItem("wd_list_axis"))).toBe("vertical");
  });
});
