import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GSI_BUTTON_SIZE, gsiDrawnHeightPx } from "../../lib/auth/gsi";

const read = (p: string) => readFileSync(p, "utf8");
const component = () => read("src/components/auth/GoogleButton.tsx");
const css = () => read("src/app/globals.css");

/**
 * Strip comments before asserting.
 *
 * These files document the very things being pinned - the size Google renders,
 * the hex of the surfaces, why opacity and not display:none - so a grep that
 * cannot tell prose from code fails on its own explanation. Every "not present"
 * assertion below runs on this.
 */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

// THE BUTTON IS OURS; THE CLICK IS GOOGLE'S.
//
// GSI renders inside Google's own iframe, so the stock white pill could not be
// restyled - it sat in a near-black premium UI looking like a widget dropped
// into the page. We now draw our own plate and leave Google's real button on
// top of it, transparent, still taking every pointer, every focus and the
// accessible name.
//
// That trade buys design freedom and costs three new ways to be wrong, and this
// file exists to pin all three: the layers can drift apart in size, the focus
// ring can disappear, and a dead control can end up looking alive.

describe("what is DRAWN is a subset of what is CLICKABLE", () => {
  it("Google's size and our drawn height are one decision, not two", () => {
    // If these ever disagree, the button a traveller sees and the button they
    // can press are different rectangles - a worse bug than an ugly button.
    expect(GSI_BUTTON_SIZE).toBe("large");
    expect(gsiDrawnHeightPx()).toBe(40);
  });

  it("the plate is drawn at exactly that height", () => {
    // h-10 is 40px. WIRING CHECK: this and gsiDrawnHeightPx() must move
    // together, which is why the constant exists at all.
    expect(component()).toMatch(/className="gbtn flex h-10 /);
  });

  it("the component asks Google for the size the constant names", () => {
    expect(component()).toMatch(/size: GSI_BUTTON_SIZE/);
    // The literal must be gone from the CODE, or the constant is decorative.
    expect(code(component())).not.toMatch(/size: "large"/);
  });

  it("the 44px tap floor survives on the ROW, not on the plate", () => {
    // CLAUDE.md mandates 44px targets. The plate is 40px because that is what
    // Google draws; the row around it is what keeps the target legal.
    expect(component()).toMatch(/min-h-\[44px\]/);
  });

  it("neither layer hard-codes a width - the column is the only source", () => {
    // The width Google gets comes from measuring the container
    // (gsiButtonWidth), so a width written a second time in the plate is a
    // second source of truth that can drift.
    expect(component()).toMatch(/max-w-\[360px\]/);
    // A bare w-[Npx] would be a second source of truth. max-w-[360px] is the
    // column's own cap, which is the ONE place a width is stated.
    expect(code(component())).not.toMatch(/(?<!max-)\bw-\[\d+px\]/);
  });
});

describe("the real button keeps the click, the focus and the name", () => {
  it("it is hidden by OPACITY only", () => {
    // display:none, visibility:hidden and a zero size would each kill the
    // click. Opacity leaves the element fully interactive.
    const src = code(component());
    expect(src).toMatch(/opacity-0/);
    // aria-hidden is fine and necessary; these three are the ones that would
    // take the click away from Google's button.
    // The BARE `hidden` utility, not `overflow-hidden` (which is load-bearing:
    // it clips Google's 10px-per-side hit-area overhang back to the plate).
    expect(src).not.toMatch(/className="[^"]*(?<![-\w])hidden(?![-\w])/);
    expect(src).not.toMatch(/\binvisible\b/);
    expect(src).not.toMatch(/display:\s*none/);
  });

  it("the painted layer can never intercept a pointer or be announced", () => {
    const src = component();
    expect(src).toMatch(/aria-hidden="true"\n\s+className="pointer-events-none absolute inset-0/);
  });

  it("there is exactly ONE live region, and it is not inside the hidden plate", () => {
    const src = component();
    expect(src.match(/role="status"/g) ?? []).toHaveLength(1);
    // It lives on an sr-only span OUTSIDE the aria-hidden plate. Inside, it
    // would be silenced along with everything else in there, and the loading
    // and signing-in states would never be announced at all.
    expect(src).toMatch(/<span className="sr-only" role="status">/);
  });

  it("a transparent button still shows a focus ring", () => {
    // Nothing else would: the visible layer cannot receive :focus, and this app
    // has no global :focus-visible rule.
    const c = css();
    expect(c).toMatch(/\.gbtn-shell:has\(:focus-visible\) \.gbtn \{/);
    // ...and engines without :has still get one.
    expect(c).toMatch(/\.gbtn-shell:focus-within \.gbtn \{/);
  });
});

describe("a dead control never looks alive", () => {
  it("the label and mark render ONLY once GSI has actually painted", () => {
    // The unauthorised-origin case paints nothing, the probe fires
    // onUnavailable, and the parent drops the button AND its divider. If our
    // plate drew a finished button before that, an unauthorised deployment
    // would show a beautiful control that does nothing - strictly worse than
    // the empty gap this component was written to replace.
    const src = component();
    expect(src).toMatch(/\{painted && !busy && \(/);
    const painted = src.indexOf("{painted && !busy && (");
    expect(src.indexOf("Continue with Google")).toBeGreaterThan(painted);
    expect(src.indexOf("gbtn-mark")).toBeGreaterThan(painted);
  });

  it("the paint probe still reads a TRUE signal through the opacity", () => {
    // childElementCount is unaffected by opacity - that is why the real button
    // is hidden this way and not another.
    expect(component()).toMatch(/node\.childElementCount === 0\) emitUnavailable/);
  });
});

describe("Google's branding rules, as code", () => {
  it("uses an approved call to action, through t()", () => {
    // "Sign in with Google", "Sign up with Google" and "Continue with Google"
    // are the three approved strings; Google explicitly permits and encourages
    // localising them, which is what fixes the app showing Portuguese.
    expect(component()).toMatch(/\{t\("Continue with Google"\)\}/);
    expect(read("src/lib/i18n-catalog.ts")).toContain("Continue with Google");
  });

  it("renders the standard four-colour mark, unmodified", () => {
    const src = component();
    for (const hex of ["#EA4335", "#4285F4", "#FBBC05", "#34A853"]) {
      expect(src).toContain(hex);
    }
    expect(src).toMatch(/viewBox="0 0 48 48"/);
    // Never recoloured, never monochrome, never stretched.
    expect(src).not.toMatch(/currentColor/);
    expect(src).toMatch(/width="18"\n\s+height="18"/);
  });

  it("the mark sits on WHITE in both themes, as the guidelines require", () => {
    const c = css();
    const block = c.slice(c.indexOf(".gbtn-mark {"), c.indexOf(".gbtn-mark {") + 400);
    expect(block).toMatch(/background: #ffffff/);
    // Not a theme token: --card and --card2 are both off-white on light, which
    // would let the tile dissolve and put the mark on a non-white ground.
    expect(block).not.toMatch(/var\(--card/);
  });
});

describe("it is the Log in button's sibling, in both themes", () => {
  it("shares the primary button's radius, weight and press", () => {
    const src = component();
    expect(src).toMatch(/rounded-2xl/); // .btn-primary is rounded-2xl
    expect(src).toMatch(/font-extrabold/); // .btn-primary is font-weight 800
    expect(css()).toMatch(/\.gbtn-shell:active \.gbtn \{\n\s+transform: scale\(0\.96\);/);
  });

  it("every colour resolves through a theme token, bar the mandated white", () => {
    const c = css();
    const block = code(c.slice(c.indexOf(".gbtn {"), c.indexOf(".gbtn-mark {")));
    // No raw hex in the plate itself - only rgba() highlights and var() tokens.
    expect(block).not.toMatch(/#[0-9a-fA-F]{6}/);
    expect(block).toMatch(/var\(--card2\)/);
    expect(block).toMatch(/var\(--line\)/);
  });

  it("respects reduced motion", () => {
    const c = css();
    const rm = c.slice(c.indexOf("@media (prefers-reduced-motion: reduce) {\n  .gbtn {"));
    expect(rm.slice(0, 200)).toMatch(/transition: none/);
  });

  it("the divider shares the button's column instead of overhanging it", () => {
    const list = read("src/components/auth/AuthMethodList.tsx");
    expect(list).toMatch(/max-w-\[360px\]/);
    expect(list).toMatch(/wd-or-rule/);
  });
});
