import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

// WAVE 10: AN INCOMING AGENT READING THE DOCS MUST BUILD THE PRODUCT THAT
// EXISTS. The audit found CLAUDE.md still describing a SIMULATED negotiation
// (the product's core has been live WhatsApp for months), README claiming the
// outreach runs on the official Meta Cloud API (the default lane is the
// traveller's own number over Baileys - a disclosed ban risk), and an
// architecture tree naming routes deleted waves ago. Docs that misdescribe
// the system are not stale, they are instructions to break it.

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("CLAUDE.md describes the product that exists", () => {
  const doc = read("CLAUDE.md");

  it("the negotiation is REAL - the simulated claim is gone", () => {
    expect(doc).not.toMatch(/simulated server-side/);
    expect(doc).toMatch(/negotiation is\s+REAL/);
    expect(doc).toMatch(/spte/i);
    expect(doc).toMatch(/engine-route\.ts/);
  });

  it("the architecture tree names living code, not deleted routes", () => {
    // /api/safety was deleted; the tree must not send an agent looking for it.
    expect(doc).not.toMatch(/\bsafety\s+vendors\b/);
    expect(doc).toMatch(/funnel\/stages\.ts/);
    expect(doc).toMatch(/privacy\//);
    expect(doc).toMatch(/webhooks\/evolution/);
  });

  it("names the CURRENT working branch and the retired ones as retired", () => {
    expect(doc).toMatch(/claude\/wheeldeal-production-architecture-91hmfq/);
    // The old names survive only inside the "retired" warning blockquote.
    const idx = doc.indexOf("claude/rental-agents-legal-setup-o7rgcv");
    expect(idx).toBeGreaterThan(-1);
    expect(doc.slice(Math.max(0, idx - 300), idx)).toMatch(/retired|previously|Earlier/i);
  });

  it("deploy instructions name ALL THREE sql files and the Evolution DB rule", () => {
    expect(doc).toMatch(/schema\.sql/);
    expect(doc).toMatch(/perf-indexes\.sql/);
    expect(doc).toMatch(/retention\.sql/);
    expect(doc).toMatch(/OWN database/);
    expect(doc).toMatch(/never the app's Supabase/);
  });

  it("carries the do-not-touch anti-ban pins and the honest-surface doctrine", () => {
    expect(doc).toMatch(/DO-NOT-TOUCH/);
    expect(doc).toMatch(/sbSelectDark/);
    expect(doc).toMatch(/vitest run/);
  });
});

describe("README stops claiming a compliance story the code does not have", () => {
  const doc = read("README.md");

  it("the default lane is named truthfully: the traveller's OWN number, with the risk", () => {
    expect(doc).toMatch(/traveller's OWN WhatsApp number/i);
    expect(doc).toMatch(/Evolution API/);
    expect(doc).toMatch(/ban/i);
    // The Cloud API appears only as what it is: the optional opted-in lane.
    expect(doc).not.toMatch(/Outreach uses the \*\*official Meta WhatsApp Cloud API\*\*/);
    expect(doc).toMatch(/optional company-WABA lane/);
  });

  it("quick-deploy names the three SQL files", () => {
    expect(doc).toMatch(/schema\.sql/);
    expect(doc).toMatch(/perf-indexes\.sql/);
    expect(doc).toMatch(/retention\.sql/);
  });
});

describe("RUNBOOK.md exists and carries the operator's three tools", () => {
  const doc = read("RUNBOOK.md");

  it("outage table, launch gate, and the 18-problem reconciliation", () => {
    expect(doc).toMatch(/\| Outage \|/);
    expect(doc).toMatch(/Launch gate/i);
    expect(doc).toMatch(/18 reported problems/i);
    // The break-glass scripts are referenced BY the doc that gets read at 3am.
    expect(doc).toMatch(/diagnose-vault\.mjs/);
    expect(doc).toMatch(/admin-recover-owner\.mjs/);
  });

  it("the scripts it references exist", () => {
    expect(existsSync(join(root, "scripts/diagnose-vault.mjs"))).toBe(true);
    expect(existsSync(join(root, "scripts/admin-recover-owner.mjs"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Link integrity: every relative link in every tracked markdown file points at
// a file that exists. A doc that links a moved file is how "read GUIDE.md"
// becomes a dead end.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The em/en dash ban, enforced (CLAUDE.md golden rule: short hyphens only).
// This replaces the eslint-rule half of the deferred flat-config migration.
// The allowlist names the PARSERS: shops genuinely type "8 <endash> 14 day", so the
// regexes that read shop text must match those characters - that is input
// handling, not our copy. Everything else in src/ is dash-free.
// ---------------------------------------------------------------------------

describe("em/en dashes appear only in shop-text parsers", () => {
  const ALLOWED = new Set([
    "src/lib/copy/greeting.ts", // boundary classes over shop/user text
    "src/lib/wa/rate-ladder.ts", // "8 <endash> 14 day" tier rows
    "src/lib/wa/rate-ladder.test.ts",
    "src/lib/media/reading.ts", // price-board range reads
    "src/lib/wa/price-extract.ts",
    // A shop writing its availability types the dash it has on its keyboard:
    // "27 <endash> 1", "27/12 <emdash> 1/1". Reading them is the entire point
    // of the module - it exists so those digits become a SPAN instead of a
    // pair of phantom prices.
    "src/lib/wa/shop-date-range.ts",
    "src/lib/wa/rental-params.ts",
    "src/lib/public-content.test.ts", // asserts ON the ban
    "src/lib/search-summary.test.ts",
  ]);

  it("no source file outside the parser allowlist contains an em/en dash", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const rel = `${dir}/${name}`;
        const full = join(root, rel);
        if (statSync(full).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name) && !ALLOWED.has(rel)) {
          const text = readFileSync(full, "utf8");
          if (text.includes("\u2014") || text.includes("\u2013")) offenders.push(rel);
        }
      }
    };
    walk("src");
    expect(
      offenders,
      `${offenders.join(", ")} - use short hyphens in code and copy; if this is a ` +
        `parser reading shop-typed text, add it to the allowlist WITH its reason`
    ).toEqual([]);
  });

  it("the allowlist itself stays honest - every entry still needs its dashes", () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(root, rel), "utf8");
      expect(
        text.includes("\u2014") || text.includes("\u2013"),
        `${rel} no longer contains any em/en dash - remove it from the allowlist`
      ).toBe(true);
    }
  });
});

describe("markdown link integrity", () => {
  const mdFiles: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      if (["node_modules", ".git", ".next", "dist", "build"].includes(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      const full = join(root, rel);
      if (statSync(full).isDirectory()) walk(rel);
      else if (name.endsWith(".md")) mdFiles.push(rel);
    }
  };
  walk("");

  it("sanity: the walk found the core docs", () => {
    expect(mdFiles).toContain("CLAUDE.md");
    expect(mdFiles).toContain("RUNBOOK.md");
  });

  it("every relative link resolves", () => {
    const broken: string[] = [];
    for (const md of mdFiles) {
      const dir = md.includes("/") ? md.slice(0, md.lastIndexOf("/")) : "";
      const text = read(md);
      for (const m of text.matchAll(/\]\((\.{0,2}\/[^)#\s]+)(?:#[^)\s]*)?\)/g)) {
        const target = join(root, dir, m[1]);
        if (!existsSync(target)) broken.push(`${md} -> ${m[1]}`);
      }
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });
});
