import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sameNumber } from "@/lib/wa/phone-key";

// OWNER REPORT 11, S2 - "ONE NUMBER, ONE ACCOUNT" WAS BYPASSED BY FORMATTING.
//
// The link guard at wa/connect queried `phone=eq.${phone.trim()}` - an exact
// STRING compare against whatever each account happened to type. So account A
// links "+66 81 234 5678" and account B links "+66812345678", the strings
// differ, the clash is missed, and two accounts register a device on ONE
// WhatsApp number: the precise failure the guard exists to stop, and a
// documented WhatsApp-restriction risk.
//
// The fix compares on the national tail (sameNumber), which folds country code,
// trunk zero and separators. This pins the predicate that decides a clash, and
// guards that the route no longer trusts the raw string.

/** The exact logic the route now runs over its phone book. */
function findClash(
  book: { email: string; phone: string | null }[],
  me: string,
  linking: string
): string | undefined {
  return book.find(
    (r) => r.email.toLowerCase() !== me.toLowerCase() && sameNumber(r.phone, linking)
  )?.email;
}

describe("the collision guard matches the number, not the spelling", () => {
  const book = [
    { email: "alice@x.co", phone: "+66 81 234 5678" }, // spaced, +cc
    { email: "bob@x.co", phone: "0899999999" },
  ];

  it("catches the SAME number typed a different way", () => {
    // Bob tries to link Alice's number without the spaces and country code.
    expect(findClash(book, "bob@x.co", "0812345678")).toBe("alice@x.co");
    expect(findClash(book, "bob@x.co", "+66812345678")).toBe("alice@x.co");
    expect(findClash(book, "bob@x.co", "66-81-234-5678")).toBe("alice@x.co");
  });

  it("does NOT flag the owner of the number re-linking their own", () => {
    // Alice re-links her own number in yet another spelling - not a clash.
    expect(findClash(book, "alice@x.co", "0812345678")).toBeUndefined();
  });

  it("does NOT flag a genuinely different number", () => {
    expect(findClash(book, "carol@x.co", "+66811111111")).toBeUndefined();
  });

  it("the exact-string compare this replaced would have MISSED the clash", () => {
    // The regression, made concrete: raw-string equality never matches across
    // spellings, so the old guard let the second account through.
    const rawMatch = book.find(
      (r) => r.email !== "bob@x.co" && (r.phone ?? "").trim() === "0812345678"
    );
    expect(rawMatch).toBeUndefined(); // <- the bug: no clash seen
    expect(findClash(book, "bob@x.co", "0812345678")).toBe("alice@x.co"); // <- the fix
  });
});

describe("the route reads the phone book and compares on identity", () => {
  const src = () => readFileSync("src/app/api/wa/connect/route.ts", "utf8");

  it("no longer does an exact-string phone=eq. compare on the typed value", () => {
    expect(src()).not.toMatch(/phone=eq\.\$\{encodeURIComponent\(String\(phone\)/);
  });

  it("compares candidates with sameNumber", () => {
    expect(src()).toMatch(/sameNumber\(r\.phone, phone\)/);
  });
});
