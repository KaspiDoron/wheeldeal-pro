"use client";

// Tap-to-build request CAROUSEL (R3): a sleek, progressive step-by-step flow -
// ONE decision per screen with Next / Back navigation and a progress rail. Zero
// typing required. Its output is a Partial<StructuredRFQ> that /api/profile
// turns into a real RFQ with NO LLM call. The free-text box stays available
// alongside - this is an alternative, not a replacement.

import { useEffect, useMemo, useState } from "react";
import type { StructuredRFQ, VehicleClass, Transmission } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { addDays } from "@/lib/rental-window";
import { formatDateRange } from "@/lib/clock";
import { windowConflict, withoutWindowText } from "@/lib/request-window-conflict";
import { Icon } from "./icons";

const SCOOTER_CC = [110, 125, 150, 160] as const;
const MOTORBIKE_CC = [150, 200, 250, "300+"] as const;
const CAR_TYPES = ["economy", "sedan", "suv", "van", "luxury"] as const;

/**
 * ODOMETER, NOT DAILY DISTANCE.
 *
 * The label said "Max mileage per day" and every consumer downstream read the
 * number as an odometer reading: agents.ts asks the shop for a bike "under 100
 * km", graph/gaps.ts asks for a photo of the odometer. Nobody meant a daily
 * allowance, and the old options ([100, 150, 200]) only made sense as one - so
 * a traveller reading "under 100 km" on a rental scooter saw either an absurd
 * daily limit or an impossible odometer. It is the odometer, said plainly, at
 * the ranges the owner asked for.
 */
const ODOMETER_MAX_KM = [null, 5_000, 15_000, 30_000] as const;

type Vehicle = "scooter" | "motorbike" | "car";

/**
 * The traveller's extras, as structured items a message can ask for.
 *
 * Split on the separators people actually type. Deliberately shallow: we are
 * turning "child seat, phone mount" into two askable things, not parsing
 * English. Anything it cannot split stays one item, which still reaches the
 * shop - the failure mode is a slightly long clause, never a lost request.
 */
export function parseExtras(storageBox: boolean, custom: string): string[] {
  const out: string[] = [];
  if (storageBox) out.push("a storage / top box");
  for (const raw of String(custom ?? "").split(/[,;]|\band\b|\+/gi)) {
    const item = raw.trim().replace(/\s{2,}/g, " ");
    if (item) out.push(item.length > 40 ? item.slice(0, 40).trim() : item);
  }
  return out.slice(0, 8);
}

function OptionCard({
  active,
  onClick,
  emoji,
  title,
  sub,
}: {
  active: boolean;
  onClick: () => void;
  emoji?: string;
  title: string;
  sub?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn flex w-full items-center gap-3 rounded-2xl border-2 p-3 text-left transition ${
        active
          ? "border-brandblue bg-brandblue-soft shadow-md"
          : "border-line bg-card hover:border-brandblue/50"
      }`}
    >
      {emoji && <span className="text-2xl">{emoji}</span>}
      <span className="min-w-0 flex-1">
        <span className={`block text-[14px] font-extrabold ${active ? "text-brandblue" : "text-strong"}`}>
          {title}
        </span>
        {sub && <span className="block text-[11px] font-bold text-faint">{sub}</span>}
      </span>
      {active && <Icon name="check" className="h-5 w-5 shrink-0 text-brandblue" />}
    </button>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`btn btn-sm rounded-2xl border-2 px-3.5 py-2 text-[13px] font-extrabold transition ${
        active ? "border-brandblue bg-brandblue text-white shadow" : "border-line bg-card text-soft hover:border-brandblue/50"
      }`}
    >
      {children}
    </button>
  );
}

function Stepper({ value, min, max, onChange, suffix }: { value: number; min: number; max: number; onChange: (n: number) => void; suffix?: string }) {
  return (
    <div className="inline-flex items-center gap-3 rounded-2xl border-2 border-line bg-card px-3 py-1.5">
      <button type="button" aria-label="decrease" onClick={() => onChange(Math.max(min, value - 1))} className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong">−</button>
      <span className="min-w-[4rem] text-center text-[15px] font-extrabold text-strong">{value}{suffix ? ` ${suffix}` : ""}</span>
      <button type="button" aria-label="increase" onClick={() => onChange(Math.min(max, value + 1))} className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong">+</button>
    </div>
  );
}

export function RequestBuilder({
  onFieldsChange,
  busy,
  startDate,
  days,
}: {
  /** Live report of the current structured selections (null until a vehicle is
   *  picked). The page's single bottom "Find my deal" button consumes this -
   *  the builder itself has NO search button (one unified CTA, owner directive). */
  onFieldsChange: (fields: Partial<StructuredRFQ> | null) => void;
  busy?: boolean;
  /**
   * THE RENTAL WINDOW BELONGS TO THE PAGE (M8 / W-7).
   *
   * It used to be private state here, and the page mounts this component only
   * when the tap builder is open - so a traveller who typed their request was
   * never asked when the rental starts or how long it runs. The window is now
   * a page-level control shown in BOTH modes (components/RentalWindowField),
   * and this component only reports what it is given. Read-only on purpose:
   * two owners of one fact is how the two input modes would drift apart.
   */
  startDate: string;
  days: number;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [transmission, setTransmission] = useState<Transmission>("any");
  const [cc, setCc] = useState<number | null>(null);
  const [carType, setCarType] = useState<(typeof CAR_TYPES)[number] | null>(null);
  const [helmets, setHelmets] = useState(0);
  const [maxMileage, setMaxMileage] = useState<number | null>(null);
  const [storageBox, setStorageBox] = useState(false);
  const [delivery, setDelivery] = useState<"any" | "hotel-delivery" | "in-store">("any");
  const [custom, setCustom] = useState("");

  const isTwoWheel = vehicle === "scooter" || vehicle === "motorbike";
  // The day they hand it back. UTC-anchored calendar arithmetic on a date
  // LABEL - `addDays` exists precisely because doing this with a local Date
  // returned a day early for every traveller in Asia.
  const returnDate = addDays(startDate, days);

  // BUG 4: the gearbox is IMPLIED for two-wheelers (scooter = automatic,
  // motorbike = manual), so the transmission step is redundant for them and is
  // shown ONLY for cars, where auto vs manual is a real choice. The step list is
  // keyed by NAME (not a fixed index) so it can shrink/grow with the vehicle.
  type StepName = "vehicle" | "transmission" | "specs" | "extras" | "lock";
  const steps = useMemo<StepName[]>(() => {
    return vehicle === "car"
      ? ["vehicle", "transmission", "specs", "extras", "lock"]
      : ["vehicle", "specs", "extras", "lock"];
  }, [vehicle]);
  const total = steps.length;
  const current: StepName = steps[Math.min(step, total - 1)] ?? "vehicle";
  const canNext = current === "vehicle" ? vehicle !== null : true;

  function go(delta: number) {
    setStep((s) => Math.min(total - 1, Math.max(0, s + delta)));
  }

  // LIVE FIELD REPORT: every selection immediately updates the parent, so the
  // page's ONE bottom "Find my deal" button always searches with the current
  // structured request (and the header preview reflects it instantly).
  useEffect(() => {
    if (!vehicle) {
      onFieldsChange(null);
      return;
    }
    const vehicleClass: VehicleClass = vehicle as VehicleClass;
    const fields: Partial<StructuredRFQ> = {
      vehicleClass,
      durationDays: days,
      // The date the whole downstream has been waiting for. Sent always (it
      // defaults to today), so the opener can say WHEN rather than only for
      // how long.
      startDate,
      // M8: THE RETURN DATE WAS NEVER EMITTED BY THE BUILDER.
      //
      // `returnDate` is a real field on StructuredRFQ - the opener
      // interpolates it, clampRfqWindow preserves the span across a clamp, and
      // the summary bar reads it for the second half of the range - but the
      // builder only ever sent a day COUNT, so every one of those read
      // undefined and the window silently collapsed to a start date.
      //
      // DERIVED, never a second input. Duration and end date are the same fact
      // said two ways; collecting both would let them disagree, and this app
      // has already paid for that mistake once with four shop counters.
      returnDate,
      transmission,
      // EXTRAS ARE ACCESSORIES, NOT NOTES. This was hard-coded `[]` while the
      // top-box toggle and the free-text field were folded into `notes` - and
      // `notes` is read by nothing that composes a message. A traveller who
      // typed "child seat" got an opener that never mentioned one, twice over:
      // buildMessage reads `accessories`, and the server-side compileOpener
      // (which replaces the client's text entirely) read neither until now.
      // THE DATES ARE NOT AN ACCESSORY. A traveller who typed "27 to 1" in the
      // free-text field had it appended verbatim to an opener that ALREADY
      // states the picker's window, so the shop received two different rentals
      // in one message. The window is surfaced as a chip instead (below) and
      // stripped from what the shops are told.
      accessories: parseExtras(storageBox, withoutWindowText(custom)),
      fulfillment: delivery,
    };
    if (isTwoWheel && cc) fields.engineSizeCc = cc;
    if (isTwoWheel && helmets > 0) fields.helmetCount = helmets;
    if (vehicle === "car" && carType) fields.carType = carType;
    if (maxMileage) fields.maxMileageKm = maxMileage;
    // `notes` keeps the traveller's RAW words - provenance for the surfaces
    // that show the request back to them, and the thing to fall back on if the
    // split above ever reads a sentence wrongly.
    const notes = [storageBox ? "storage box / top box" : "", custom.trim()].filter(Boolean).join("; ");
    if (notes) fields.notes = notes.slice(0, 240);
    onFieldsChange(fields);
    // onFieldsChange is a stable setter from the parent - the selections drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicle, transmission, cc, carType, days, startDate, returnDate, helmets, maxMileage, storageBox, delivery, custom]);

  const ccOptions = vehicle === "motorbike" ? MOTORBIKE_CC : SCOOTER_CC;
  const TITLES: Record<StepName, string> = {
    vehicle: "Pick your ride",
    transmission: "Gears",
    specs: "Size & spec",
    extras: "Extras",
    lock: "Lock it in",
  };
  const stepTitle = TITLES[current];

  return (
    <div data-tour="builder" className="overflow-hidden rounded-2xl border-2 border-line bg-card2">
      {/* M8 / W-7 - THE RENTAL WINDOW IS NOT A STEP, AND NOT THE BUILDER'S.
          It first moved out of step 3 of 4 because the one fact that decides
          whether a shop can even answer was off screen for most of the flow
          (incident I-8). It has now moved out of this component entirely: the
          page mounts the builder only when the tap mode is open, so keeping
          the dates here hid them from everyone who typed instead. The page
          renders components/RentalWindowField above this card, in both modes,
          and hands the result down. */}

      {/* Progress rail */}
      <div className="flex items-center gap-1.5 px-3 pt-3">
        {steps.map((_, i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${i <= step ? "bg-brandblue" : "bg-line"}`} />
        ))}
      </div>
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[11px] font-bold text-faint">{t("Step")} {step + 1} / {total}</span>
        <span className="text-[13px] font-extrabold text-strong">{t(stepTitle)}</span>
      </div>

      <div className="min-h-[200px] p-3">
        {/* STEP - vehicle. Picking a two-wheeler stamps its implied gearbox
            (scooter = automatic, motorbike = manual) so no gearbox step is
            needed; a car defaults to "any" and gets the gearbox step. */}
        {current === "vehicle" && (
          <div className="space-y-2">
            <OptionCard emoji="🛵" title={t("Scooter")} sub={t("Automatic, easy - the traveller favourite")} active={vehicle === "scooter"} onClick={() => { setVehicle("scooter"); setCc(null); setTransmission("automatic"); }} />
            <OptionCard emoji="🏍️" title={t("Motorbike")} sub={t("Manual gears, more power")} active={vehicle === "motorbike"} onClick={() => { setVehicle("motorbike"); setCc(null); setTransmission("manual"); }} />
            <OptionCard emoji="🚗" title={t("Car")} sub={t("4 seats and up, doors and A/C")} active={vehicle === "car"} onClick={() => { setVehicle("car"); setCc(null); setTransmission("any"); }} />
          </div>
        )}

        {/* STEP - transmission (cars only) */}
        {current === "transmission" && (
          <div className="space-y-2">
            <p className="mb-1 text-[12px] font-bold text-soft">{t("Which gearbox do you want?")}</p>
            <OptionCard title={t("Either is fine")} sub={t("Cheapest wins")} active={transmission === "any"} onClick={() => setTransmission("any")} />
            <OptionCard emoji="⚙️" title={t("Automatic")} sub={t("Twist and go")} active={transmission === "automatic"} onClick={() => setTransmission("automatic")} />
            <OptionCard emoji="🕹️" title={t("Manual")} sub={t("Clutch and gears")} active={transmission === "manual"} onClick={() => setTransmission("manual")} />
          </div>
        )}

        {/* STEP - specs */}
        {current === "specs" && (
          <div className="space-y-3">
            {isTwoWheel ? (
              <>
                <p className="text-[12px] font-bold text-soft">{t("Engine size")}</p>
                <div className="flex flex-wrap gap-2">
                  <Pill active={cc === null} onClick={() => setCc(null)}>{t("Any / cheapest")}</Pill>
                  {ccOptions.map((c) => (
                    <Pill key={String(c)} active={cc === (typeof c === "number" ? c : 300)} onClick={() => setCc(typeof c === "number" ? c : 300)}>
                      {typeof c === "number" ? `${c}cc` : "300cc+"}
                    </Pill>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="text-[12px] font-bold text-soft">{t("Car type")}</p>
                <div className="flex flex-wrap gap-2">
                  {CAR_TYPES.map((c) => (
                    <Pill key={c} active={carType === c} onClick={() => setCarType(carType === c ? null : c)}>
                      {t(c[0].toUpperCase() + c.slice(1))}
                    </Pill>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* STEP - extras */}
        {current === "extras" && (
          <div className="space-y-3">
            {isTwoWheel && (
              <div className="flex items-center justify-between gap-2 rounded-xl bg-card p-2.5">
                <span className="text-[13px] font-bold text-soft">🪖 {t("Helmets")}</span>
                <Stepper value={helmets} min={0} max={4} onChange={setHelmets} />
              </div>
            )}
            <div className="rounded-xl bg-card p-2.5">
              <p className="mb-1.5 text-[12px] font-bold text-soft">{t("Max distance on the clock")}</p>
              <div className="flex flex-wrap gap-2">
                {ODOMETER_MAX_KM.map((m) => (
                  <Pill key={String(m)} active={maxMileage === m} onClick={() => setMaxMileage(m)}>
                    {m === null ? t("Any") : `< ${m.toLocaleString()} km`}
                  </Pill>
                ))}
              </div>
            </div>
            <div className="rounded-xl bg-card p-2.5">
              <p className="mb-1.5 text-[12px] font-bold text-soft">{t("How do you get it?")}</p>
              <div className="flex flex-wrap gap-2">
                <Pill active={delivery === "any"} onClick={() => setDelivery("any")}>{t("Either")}</Pill>
                <Pill active={delivery === "hotel-delivery"} onClick={() => setDelivery("hotel-delivery")}>🛵 {t("Delivered to me")}</Pill>
                <Pill active={delivery === "in-store"} onClick={() => setDelivery("in-store")}>🏪 {t("Pick up at shop")}</Pill>
              </div>
            </div>
            {isTwoWheel && (
              <button type="button" onClick={() => setStorageBox((s) => !s)} className={`btn flex w-full items-center justify-between rounded-xl border-2 p-2.5 ${storageBox ? "border-brandblue bg-brandblue-soft" : "border-line bg-card"}`}>
                <span className="text-[13px] font-bold text-soft">🧳 {t("Storage / top box")}</span>
                <span className={`text-[12px] font-extrabold ${storageBox ? "text-brandblue" : "text-faint"}`}>{storageBox ? t("Yes") : t("Off")}</span>
              </button>
            )}
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder={t("Anything else? e.g. child seat, phone mount")}
              maxLength={240}
              className="w-full rounded-xl border-2 border-line bg-card px-3 py-2.5 text-[16px] text-strong placeholder:text-faint"
            />
          </div>
        )}

        {/* STEP - review. ONE unified search CTA lives at the bottom of the
            whole search block (owner directive) - no second button here. */}
        {current === "lock" && (
          <div className="space-y-3">
            <p className="text-[12px] font-bold text-soft">{t("Your request is ready:")}</p>
            <div className="flex flex-wrap gap-1.5">
              {vehicle && <span className="rounded-full bg-brandblue-soft px-3 py-1 text-[12px] font-extrabold text-brandblue">{t(vehicle[0].toUpperCase() + vehicle.slice(1))}</span>}
              {isTwoWheel && transmission !== "any" && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{t(transmission)}</span>}
              {isTwoWheel && cc && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{cc}cc</span>}
              {vehicle === "car" && carType && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{t(carType)}</span>}
              <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{days} {t("days")}</span>
              {/* THE SAME FORMATTER THE SUMMARY BAR USES. This chip printed the
                  raw ISO string - "2026-08-12" - which is the one date format
                  nobody reads at a glance, and it disagreed in shape with every
                  other surface that states the window. */}
              <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{formatDateRange(startDate, returnDate)}</span>
              {/* TWO WINDOWS, ONE MESSAGE. Free text that states its own rental
                  length used to be appended verbatim to an opener that already
                  stated the picker's - so the shop was asked about two
                  different rentals at once. The chip says which one the shops
                  will actually be told, in the traveller's own words, while
                  they can still change it. */}
              {(() => {
                const clash = windowConflict(custom, days);
                if (!clash) return null;
                return (
                  <span className="rounded-full bg-brandyellow-soft px-3 py-1 text-[12px] font-extrabold text-warn">
                    {t("You typed")} &ldquo;{clash.typed.text}&rdquo; -{" "}
                    {t("shops will be told")} {days} {t("days")}
                  </span>
                );
              })()}
              {helmets > 0 && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{helmets} 🪖</span>}
              {/* FORMATTED, like every other number the traveller sees. "<30000km"
                  is not a quantity anybody reads at a glance. */}
              {maxMileage && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">&lt; {maxMileage.toLocaleString()} km</span>}
              {parseExtras(storageBox, withoutWindowText(custom)).slice(0, 3).map((x) => (
                <span key={x} className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{x}</span>
              ))}
              {delivery !== "any" && <span className="rounded-full bg-card px-3 py-1 text-[12px] font-bold text-soft">{delivery === "hotel-delivery" ? t("Delivered") : t("Pickup")}</span>}
            </div>
            <p className="rounded-xl bg-brandblue-soft px-3 py-2 text-[12px] font-bold text-brandblue">
              👇 {t("Tap the Find my deal button below to start the search.")}
            </p>
          </div>
        )}
      </div>

      {/* Nav */}
      <div className="flex items-center justify-between gap-2 border-t border-line/50 p-3">
        <button type="button" onClick={() => go(-1)} disabled={step === 0} className="btn btn-sm rounded-xl px-4 py-2 text-[13px] font-extrabold text-soft disabled:opacity-30">
          {/* The arrow is a SEPARATE mirrorable span, not glued to the label.
              A bare "←" is a fixed glyph: in Hebrew/Arabic the Back button then
              points the way Next should, because the arrow says "left" while
              the layout reads right-to-left. `.rtl-flip` (globals.css) mirrors
              it under [dir="rtl"], and inline-block is required for the
              transform to apply. */}
          <span className="rtl-flip inline-block" aria-hidden>←</span> {t("Back")}
        </button>
        {step < total - 1 ? (
          <button type="button" onClick={() => go(1)} disabled={!canNext} className="btn btn-sm rounded-xl bg-brandblue px-5 py-2 text-[13px] font-extrabold text-white disabled:opacity-40">
            {t("Next")} <span className="rtl-flip inline-block" aria-hidden>→</span>
          </button>
        ) : (
          <span className="text-[11px] font-bold text-faint">{busy ? t("Searching...") : t("Ready 👇")}</span>
        )}
      </div>
    </div>
  );
}
