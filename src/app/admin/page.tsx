"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { LoadingDots } from "@/components/LoadingDots";
import { SkeletonList } from "@/components/Skeleton";
import { LanguageButton } from "@/components/LanguageButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PlanCard, type PlanView } from "@/components/UpgradeSheet";
import { PlaceAutocomplete } from "@/components/PlaceAutocomplete";

// The keys sub-panels are heavy (health probes, doctors) and only appear on
// one tab, so code-split them out of the initial admin bundle - first paint of
// the common tabs no longer pays for them. (The graph-era "agents" tab and its
// Pipeline Studio mount are DELETED, not hidden: the app runs on the
// single-pass engine, and a tab that renders retired machinery is exactly the
// kind of dead surface the dead-code purge exists to keep out.)
const HealthPanel = dynamic(
  () => import("@/components/HealthPanel").then((m) => m.HealthPanel),
  { ssr: false, loading: () => <LoadingDots label="Loading service health" /> }
);
const WaDoctorCard = dynamic(
  () => import("@/components/admin/WaDoctorCard").then((m) => m.WaDoctorCard),
  { ssr: false, loading: () => <LoadingDots label="Loading WA doctor" /> }
);
const PaypalDoctorCard = dynamic(
  () => import("@/components/admin/PaypalDoctorCard").then((m) => m.PaypalDoctorCard),
  { ssr: false, loading: () => <LoadingDots label="Loading PayPal doctor" /> }
);
// The four ceilings from SCALING.md, each with its threshold attached: host
// occupancy against the per-host cap, drain-heartbeat age, database round trip,
// and the event kinds that should page someone.
const ChokePointsCard = dynamic(
  () => import("@/components/admin/ChokePointsCard").then((m) => m.ChokePointsCard),
  { ssr: false, loading: () => <LoadingDots label="Measuring the ceilings" /> }
);
const DeployInfoCard = dynamic(() => import("@/components/admin/DeployInfoCard"), {
  ssr: false,
  loading: () => <LoadingDots label="Reading the running service" />,
});
const OpsCenterPanel = dynamic(
  () => import("@/components/ops/OpsCenter").then((m) => m.OpsCenter),
  { ssr: false, loading: () => <LoadingDots label="Loading the Ops Center" /> }
);
// The Business Platform console: connection, governor, first-contact funnel and
// the lead ledger with the exact wire text. Owner-facing operations for the
// official number - inert while WABA_ENABLED is off, and it says so.
const WabaConsolePanel = dynamic(
  () => import("@/components/admin/WabaConsole").then((m) => m.WabaConsole),
  { ssr: false, loading: () => <LoadingDots label="Reading the business number" /> }
);
// Monetization + lifecycle: the funnel, time-to-unlock, where people stall, and
// the gate-vs-holdout comparison. Lazy like every other heavy tab.
const LifecyclePanel = dynamic(
  () => import("@/components/admin/LifecyclePanel").then((m) => m.LifecyclePanel),
  { ssr: false, loading: () => <LoadingDots label="Reading the lifecycle" /> }
);
// The live ENGINE_V3 transparency view that replaces the retired graph debug tabs.
// Ban risk: meter integrity first, then the two enforcement axes kept apart,
// then what the Evolution hosts actually report. Owner-facing, never polled.
const BanRiskPanel = dynamic(() => import("@/components/admin/BanRiskPanel"), {
  ssr: false,
  loading: () => <LoadingDots label="Reading the risk ledger" />,
});
// Owner-editable translation corrections: a bad machine string is fixable at
// runtime, in its own config row so the translator's own sweep cannot undo it.
const TranslationRepairPanel = dynamic(
  () => import("@/components/admin/TranslationRepairPanel"),
  { ssr: false, loading: () => <LoadingDots label="Reading the corrections" /> }
);
const EngineInspectorPanel = dynamic(
  () => import("@/components/admin/EngineInspector").then((m) => m.EngineInspector),
  { ssr: false, loading: () => <LoadingDots label="Reading the live blackboard" /> }
);
import type { AnalyticsSnapshot } from "@/lib/types";
import { providerFailureKind, providerNeedsOwner, providerFailureCopy } from "@/lib/provider-health";
import { StatTile, DegradedBanner, type StatHelp } from "@/components/admin/primitives";
import { InfoTipProvider } from "@/components/InfoTip";

// Every Command KPI carries an "i" that explains it - enforced by StatTile's
// type (a tile without a catalogue entry does not compile). ENGINE_HELP's
// pattern, applied to the tab the owner opens first.
const COMMAND_HELP = {
  waSessions: {
    label: "WA sessions live",
    what: "How many users (including you) currently have a live, linked WhatsApp session sending through the app right now.",
    drift: "A sudden drop across the fleet usually means the Evolution host restarted - check Keys - WhatsApp doctor.",
  },
  repliesToday: {
    label: "Shop replies (24h)",
    what: "Messages rental shops sent back to your agents in the last 24 hours. An exact count, not a capped sample.",
    drift: "Zero with sessions live and sends going out means inbound is broken - check the webhook in the WA doctor.",
  },
  offersToday: {
    label: "Offers landed (24h)",
    what: "Real prices captured from shop replies in the last 24 hours.",
    drift: "Replies without offers means extraction is failing - check AI keys and the Engine tab.",
  },
  queuedMessages: {
    label: "Queued messages",
    what: "Messages the anti-ban engine is holding to send later (shop closed, rate limit, human pacing).",
    drift: "A large, growing queue with nothing overdue is pacing at work; overdue rows raise their own critical alert.",
  },
  openIssues: {
    label: "Open issues",
    what: "Feedback the AI triaged as a genuine bug or usability issue that is still open.",
    drift: "Work them from the Feedback tab - high severity first.",
  },
} satisfies Record<string, StatHelp>;

interface KeyInfo {
  name: string;
  label: string;
  configured: boolean;
  masked: string;
  scope: string;
  editable: boolean;
  /** There is a real probe behind this key even when it is not editable here
   *  (REDIS_URL is env-only AND the one dependency whose silence multiplies
   *  every daily cap by the instance count). Optional so an older cached
   *  payload just falls back to the editable rule. */
  testable?: boolean;
  docUrl?: string;
  /** False for SETTINGS (flags, thresholds, model ids): rendered as a
   *  readable input, and as an on/off toggle when the label says it is one.
   *  Optional so an older cached payload just keeps the password box. */
  secret?: boolean;
}
interface UserRecord {
  email: string;
  phone?: string;
  status: "active" | "blocked";
  role: "owner" | "admin" | "user";
  plan?: string;
  provider: string;
  addedAt: number;
  lastSeen: number;
}

interface FeedbackRow {
  id: number;
  category: string;
  body: string;
  reporter_email: string | null;
  is_real_issue: boolean;
  severity: string | null;
  summary: string | null;
  triage_reason: string | null;
  image_count: number;
  images?: string[];
  status?: string;
  owner_note?: string | null;
  created_at: string;
  replies?: {
    id: number;
    author_role: string;
    author_email: string | null;
    body: string;
    created_at: string;
  }[];
}

/** User-visible reply thread on a feedback report (owner/admin side). Distinct
 *  from the internal owner_note - this is what the reporter reads and answers. */
function AdminReplyThread({
  report,
  onReplied,
}: {
  report: FeedbackRow;
  onReplied: (reply: NonNullable<FeedbackRow["replies"]>[number]) => void;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const replies = report.replies ?? [];

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/feedback/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackId: report.id, body: text }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; rejected?: string }
        | null;
      if (res.ok) {
        setErr("");
        onReplied({
          id: Date.now(),
          author_role: "owner",
          author_email: null,
          body: text,
          created_at: new Date().toISOString(),
        });
        setDraft("");
      } else {
        // THE REPLY DID NOT LAND, SO DO NOT PAINT IT AS IF IT HAD.
        //
        // The route used to answer {ok:true} even when the insert failed, and
        // this panel painted the reply optimistically - so an owner reply could
        // vanish while both sides believed it had been delivered, which is
        // exactly the "users cannot see my responses" complaint. The route is
        // honest now (502 for a refused insert, 400 for language), and the
        // draft is kept so the text can be re-sent rather than retyped.
        setErr(data?.error || "That reply did not send - it has not been stored. Try again.");
      }
    } catch {
      setErr("That reply did not send - check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-line bg-card2/40 p-1.5">
      <div className="text-[9px] font-extrabold uppercase tracking-wide text-faint">
        Reply to the user{report.reporter_email ? "" : " (anonymous - no reply channel)"}
      </div>
      {replies.length > 0 && (
        <div className="mt-1 space-y-1">
          {replies.map((rp) => (
            <div
              key={rp.id}
              className={`text-[11px] ${
                rp.author_role === "user" ? "text-strong" : "text-brandblue"
              }`}
            >
              <b>{rp.author_role === "user" ? "User" : "Team"}:</b> {rp.body}
            </div>
          ))}
        </div>
      )}
      {report.reporter_email && (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
            disabled={busy}
            placeholder="Write a reply the user will see..."
            className="h-8 min-w-0 flex-1 rounded-lg border-2 border-line bg-card px-2 text-[11px] text-strong focus:border-brandblue focus:outline-none disabled:opacity-60"
          />
          <button
            onClick={send}
            disabled={busy || !draft.trim()}
            className="btn btn-sm btn-primary h-8 shrink-0 rounded-lg px-2.5 text-[10px] font-extrabold disabled:opacity-50"
          >
            Send
          </button>
        </div>
      )}
      {err && (
        <div className="mt-1 text-[10px] font-bold text-brandred" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<
    | "command"
    | "analytics"
    | "engine"
    | "ops"
    | "money"
    | "waba"
    | "risk"
    | "i18n"
    | "keys"
    | "users"
    | "feedback"
    | "billing"
    | "data"
    | "settings"
  >("command");
  // Keys page: collapse each scope group so the long page is easy to walk.
  const [collapsedScopes, setCollapsedScopes] = useState<Record<string, boolean>>({
    maps: true,
    email: true,
    billing: true,
    auth: true,
    data: true,
  });
  // Command center + agent studio data
  const [command, setCommand] = useState<{
    alerts: { level: string; title: string; detail: string; href?: string }[];
    // `number | null`, not `number`: null means the source read FAILED, which
    // is a different fact from 0 and must not be collapsed into it.
    stats: Record<string, number | null>;
    /** Sources that could not be read on this request. */
    degraded?: string[];
  } | null>(null);
  const [floors, setFloors] = useState<
    { id: number; region_key: string; vehicle_key: string; currency: string; floor_per_day: number; typical_per_day: number | null; source: string }[]
  >([]);
  const [floorRegion, setFloorRegion] = useState("");
  const [floorBusy, setFloorBusy] = useState(false);
  const [floorMsg, setFloorMsg] = useState<string | null>(null);
  const [waSec, setWaSec] = useState<{
    policies: Record<string, number | boolean>;
    help: Record<string, { label: string; help: string; best: string }>;
    reputation: {
      sender_key: string;
      trust_score: number;
      risk_score?: number;
      sent_total: number;
      replies_total: number;
      blocks_total?: number;
      fails_total?: number;
      paused_until?: string | null;
      risk?: { score: number; reasons: string[] };
    }[];
    outbox: { id: number; to_number: string; not_before: string }[];
  } | null>(null);
  const [waHelp, setWaHelp] = useState<string | null>(null); // open info popup key
  const [waPolicyErr, setWaPolicyErr] = useState<{ key: string; error: string } | null>(null);
  const [sponsors, setSponsors] = useState<
    { id: number; name: string; phone: string | null; active: boolean; notes: string | null }[]
  >([]);
  const [spName, setSpName] = useState("");
  const [spPhone, setSpPhone] = useState("");
  const [spNotes, setSpNotes] = useState("");
  // Interactive train-the-agent studio (New#13)
  const [tcTurns, setTcTurns] = useState<{ role: "shop" | "agent"; text: string }[]>([]);
  const [tcInput, setTcInput] = useState("");
  // The scenario area for the live trainer. Location suggestions now come from
  // the shared PlaceAutocomplete; typed free-text still works as the area.
  const [tcRegion, setTcRegion] = useState("");
  const [tcBusy, setTcBusy] = useState(false);
  const [tcInfo, setTcInfo] = useState<{
    action: string; reasoning: string;
    understood: { foundPrice: number | null; currency: string; matchesVehicle: boolean; confidence: string };
  } | null>(null);
  const [tcSaved, setTcSaved] = useState(false);

  async function tcSend() {
    const text = tcInput.trim();
    if (!text || tcBusy) return;
    const turns = [...tcTurns, { role: "shop" as const, text }];
    setTcTurns(turns);
    setTcInput("");
    setTcBusy(true);
    try {
      const res = await fetch("/api/admin/train-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns, region: tcRegion }),
      });
      const r = await res.json().catch(() => ({}));
      if (r.agentMessage) {
        setTcTurns([...turns, { role: "agent", text: r.agentMessage }]);
        setTcInfo({ action: r.action, reasoning: r.reasoning, understood: r.understood });
      } else {
        // Never leave the trainer silent - always show WHY the agent could not reply.
        setTcTurns([
          ...turns,
          {
            role: "agent",
            text:
              r.error ??
              "The agent could not respond just now. Check that an AI key is set in Admin -> Keys, then try again.",
          },
        ]);
      }
    } catch {
      setTcTurns([
        ...turns,
        { role: "agent", text: "Network hiccup reaching the agent - please try again." },
      ]);
    } finally {
      setTcBusy(false);
    }
  }
  async function tcSave() {
    await fetch("/api/admin/train-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", turns: tcTurns, region: tcRegion }),
    });
    setTcSaved(true);
    setTimeout(() => setTcSaved(false), 2000);
    refreshMemory();
  }

  const [xPosts, setXPosts] = useState<
    { text: string; hashtags: string[]; imageIdea: string; angle: string }[]
  >([]);
  const [xTheme, setXTheme] = useState("");
  const [xBusy, setXBusy] = useState(false);
  const [xCopied, setXCopied] = useState<number | null>(null);
  const [xErr, setXErr] = useState<string | null>(null);

  async function genXPosts() {
    setXBusy(true);
    setXErr(null);
    try {
      const r = await (
        await fetch("/api/admin/x-posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: xTheme }),
        })
      ).json();
      if (r.posts) setXPosts(r.posts);
      else setXErr(r.error ?? "Could not generate posts.");
    } finally {
      setXBusy(false);
    }
  }

  // Which Command-tab legs failed on the last load. Each entry renders its own
  // error card with a Retry - never a permanent skeleton.
  const [commandErrs, setCommandErrs] = useState<string[]>([]);
  // Command also hosts the foldable Anti-Ban + Sponsored sections (item #16).
  //
  // allSettled, NOT all (owner report 3, 3.5): the old Promise.all meant ONE
  // failed fetch (or one non-JSON error page) rejected the whole load, nothing
  // called setCommand, and the tab sat on its skeleton forever - the owner's
  // screenshot. Each leg now lands or fails independently, and a failed leg is
  // an error card with a Retry, not a silent hole.
  async function loadCommand() {
    const [r, s, sp] = await Promise.allSettled([
      fetch("/api/admin/command").then((x) => x.json()),
      fetch("/api/admin/wa-security").then((x) => x.json()),
      fetch("/api/admin/sponsored").then((x) => x.json()),
    ]);
    const errs: string[] = [];
    if (r.status === "fulfilled" && r.value?.alerts) setCommand(r.value);
    else errs.push("command overview");
    if (s.status === "fulfilled" && s.value?.policies) setWaSec(s.value);
    else errs.push("anti-ban policies");
    if (sp.status === "fulfilled" && sp.value?.rows) setSponsors(sp.value.rows);
    else errs.push("sponsored shops");
    setCommandErrs(errs);
  }
  // Analytics hosts the foldable market-floors table (item #16).
  async function loadFloors() {
    const m = await (await fetch("/api/admin/market")).json();
    if (m.rows) setFloors(m.rows);
  }
  const [dataTables, setDataTables] = useState<{ name: string; label: string; count: number }[]>([]);
  const [dataTable, setDataTable] = useState<string | null>(null);
  const [dataRows, setDataRows] = useState<Record<string, unknown>[]>([]);
  const [dataBusy, setDataBusy] = useState(false);
  // Tables whose counts could not be read - the route already names them; the
  // tab now actually shows it (the shared DegradedBanner) instead of quietly
  // rendering those tables as if they were countable.
  const [dataDegraded, setDataDegraded] = useState<string[]>([]);

  async function loadDataTables() {
    const r = await (await fetch("/api/admin/data")).json();
    setDataTables(r.tables ?? []);
    setDataDegraded(r.degraded ?? []);
  }
  async function openDataTable(name: string) {
    setDataTable(name);
    setDataBusy(true);
    try {
      const r = await (await fetch(`/api/admin/data?table=${encodeURIComponent(name)}&limit=100`)).json();
      setDataRows(r.rows ?? []);
    } finally {
      setDataBusy(false);
    }
  }
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  // TRI-STATE (null = still checking). It used to default to `false`, so the
  // alarming "Persistence is OFF" banner was shown for the entire duration of
  // the initial 7-way load - including the slow live health probes - and only
  // then flipped green. Unknown must never render as broken.
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [billingOn, setBillingOn] = useState(false);
  const [newAdmin, setNewAdmin] = useState("");
  const [userMsg, setUserMsg] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [keyWarning, setKeyWarning] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; label: string; value: string }[] | null>(null);
  const [aiProviders, setAiProviders] = useState<any[]>([]);
  // "Test AI providers": one tap fires a tiny real completion at EVERY
  // configured provider concurrently (POST /api/admin/ai-test) and shows,
  // per provider, whether it answered and with WHICH model - a primary id
  // rescued by its fallback is a fix-me, not a pass.
  const [aiTest, setAiTest] = useState<
    | {
        name: string;
        configured: boolean;
        ok: boolean;
        model?: string;
        configuredModel?: string;
        ms?: number;
        detail?: string;
        primaryDetail?: string;
      }[]
    | null
  >(null);
  const [aiTestBusy, setAiTestBusy] = useState(false);
  // When the sweep itself fails, the WHICH LAYER failed is the diagnosis:
  // an HTTP status means the server (or something in front of it) answered,
  // a browser error means the request never completed. Collapsing them all
  // into one blanket line made the button undebuggable in production.
  const [aiTestError, setAiTestError] = useState<string | null>(null);
  async function runAiTest() {
    setAiTestBusy(true);
    setAiTestError(null);
    setAiTest(null);
    try {
      const r = await fetch("/api/admin/ai-test", {
        method: "POST",
        // The server bounds the sweep at ~12s; 60s here means a hang is
        // reported as a timeout instead of spinning forever.
        signal:
          typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
            ? AbortSignal.timeout(60_000)
            : undefined,
      });
      const text = await r.text();
      let d: { results?: unknown; error?: string } | null = null;
      try {
        d = JSON.parse(text);
      } catch {
        /* non-JSON body - reported below with the status */
      }
      if (r.ok && Array.isArray(d?.results)) {
        setAiTest(d.results as typeof aiTest);
      } else {
        setAiTestError(
          `The server answered HTTP ${r.status} - ${(d?.error || text || "empty body").slice(0, 200)}`
        );
      }
    } catch (e) {
      setAiTestError(
        e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")
          ? "Timed out after 60s - the server never answered. That is a hosting problem, not a provider problem."
          : `The request failed in the browser: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setAiTestBusy(false);
    }
  }
  const [distillMsg, setDistillMsg] = useState<string | null>(null);
  const [distillBusy, setDistillBusy] = useState(false);
  const [trainingCount, setTrainingCount] = useState(0);
  const [trainMsg, setTrainMsg] = useState<string | null>(null);
  const [trainOk, setTrainOk] = useState(true);
  const [trainBusy, setTrainBusy] = useState(false);
  const [trainNumbers, setTrainNumbers] = useState("");
  const [memory, setMemory] = useState<{ id: number; text: string; note?: string; origin?: string; source?: string; addedBy?: string; addedAt: number }[]>([]);
  const [memEditId, setMemEditId] = useState<number | null>(null);
  const [memEditText, setMemEditText] = useState("");
  const [memAdd, setMemAdd] = useState("");
  const [memBusy, setMemBusy] = useState(false);

  async function refreshMemory() {
    const tr = await (await fetch("/api/admin/training")).json();
    setMemory(tr.examples ?? []);
    setTrainingCount((tr.examples ?? []).length);
  }
  async function addMemory() {
    if (memAdd.trim().length < 20) {
      setTrainMsg("Paste at least a few lines of a real bargain.");
      return;
    }
    setMemBusy(true);
    try {
      const r = await (await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: memAdd.trim(), note: "manual" }),
      })).json();
      if (r.examples) {
        setMemory(r.examples);
        setTrainingCount(r.examples.length);
        setMemAdd("");
        setTrainMsg("Added to the agents' memory.");
      } else setTrainMsg(r.error ?? "Could not add.");
    } finally {
      setMemBusy(false);
    }
  }
  async function saveMemoryEdit(id: number) {
    setMemBusy(true);
    try {
      const r = await (await fetch("/api/admin/training", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text: memEditText }),
      })).json();
      if (r.examples) setMemory(r.examples);
      setMemEditId(null);
    } finally {
      setMemBusy(false);
    }
  }
  async function deleteMemory(id: number) {
    const r = await (await fetch(`/api/admin/training?id=${id}`, { method: "DELETE" })).json();
    if (r.examples) {
      setMemory(r.examples);
      setTrainingCount(r.examples.length);
    }
  }
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userSort, setUserSort] = useState<"new" | "old" | "management">("new");
  const [feedbackRows, setFeedbackRows] = useState<FeedbackRow[]>([]);
  // THE PANEL USED TO RENDER THE PAGE SIZE UNDER THE WORD "TOTAL".
  //
  // The route caps a page at 100 rows, and this panel counted the rows it had
  // been handed - so with 101+ reports it stated a Total of exactly 100, the
  // 101st was unreachable through any UI, and nothing anywhere said reports
  // were missing. The owner asked to be "fully visible to each and every
  // feedback". `total` is now the real count from the database (null when that
  // count is unreadable, which renders as "-" rather than as a number we made
  // up), and the page itself is labelled Shown.
  const [feedbackTotal, setFeedbackTotal] = useState<number | null>(null);
  const [feedbackNextOffset, setFeedbackNextOffset] = useState(0);
  const [feedbackHasMore, setFeedbackHasMore] = useState(false);
  const [feedbackLoadingMore, setFeedbackLoadingMore] = useState(false);
  const [feedbackFilter, setFeedbackFilter] = useState<"all" | "high" | "issues" | "noise">("all");
  // W6.2: the owner asked for feedback that is "categorized properly". The
  // category was collected, stored and displayed but drove NOTHING - severity
  // was the only axis to slice on. The counts come from the WHOLE table (the
  // route counts over 1000 rows and filters in the query), so a chip's number
  // stays honest even when the 100-row page is full of one category.
  const [feedbackCategory, setFeedbackCategory] = useState<string>("");
  const [feedbackByCategory, setFeedbackByCategory] = useState<Record<string, number>>({});
  const [diag, setDiag] = useState<{ kind: string; text: string; ok: boolean } | null>(null);
  const [diagBusy, setDiagBusy] = useState<string | null>(null);
  const [costs, setCosts] = useState<any>(null);
  // The kill switch's write outcome (502 / fleet warning) - see the onClick.
  const [killSwitchMsg, setKillSwitchMsg] = useState<string | null>(null);
  const [limitEdit, setLimitEdit] = useState<Record<string, string>>({});
  const [limitsBusy, setLimitsBusy] = useState(false);
  const [limitsMsg, setLimitsMsg] = useState<string | null>(null);
  const [keyTests, setKeyTests] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [keyTestBusy, setKeyTestBusy] = useState<string | null>(null);
  const [waHosts, setWaHosts] = useState<
    { hosts: { url: string; healthy: boolean; users: number; detail: string }[]; healthy: number; total: number; users: number } | null
  >(null);
  const [waHostsBusy, setWaHostsBusy] = useState(false);
  const [waHostTest, setWaHostTest] = useState<
    Record<string, { busy: boolean; ok?: boolean; detail?: string }>
  >({});

  async function loadWaHosts() {
    setWaHostsBusy(true);
    try {
      const r = await (await fetch("/api/admin/wa-hosts")).json();
      setWaHosts(r);
    } catch {
      setWaHosts(null);
    } finally {
      setWaHostsBusy(false);
    }
  }

  async function testOneWaHost(url: string) {
    setWaHostTest((p) => ({ ...p, [url]: { busy: true } }));
    try {
      const r = await (await fetch(`/api/admin/wa-hosts?test=${encodeURIComponent(url)}`)).json();
      setWaHostTest((p) => ({ ...p, [url]: { busy: false, ok: r.healthy, detail: r.detail } }));
    } catch {
      setWaHostTest((p) => ({ ...p, [url]: { busy: false, ok: false, detail: "Test failed to run." } }));
    }
  }

  async function refreshCosts() {
    const c = await (await fetch("/api/admin/costs")).json();
    setCosts(c);
    setLimitEdit(
      Object.fromEntries(Object.entries(c.limits ?? {}).map(([k, v]) => [k, String(v)]))
    );
  }

  async function testKey(name: string) {
    setKeyTestBusy(name);
    try {
      const r = await (await fetch(`/api/admin/key-test?name=${encodeURIComponent(name)}`)).json();
      setKeyTests((p) => ({ ...p, [name]: r }));
    } finally {
      setKeyTestBusy(null);
    }
  }

  useEffect(() => {
    (async () => {
      // Analytics doubles as the auth gate, so it runs first. Everything else
      // then loads IN PARALLEL - the panel used to await nine round-trips one
      // after another, so first paint waited on the SUM of every latency.
      const a = await fetch("/api/admin/analytics");
      if (a.status === 403) {
        setAuthorized(false);
        return;
      }
      setAuthorized(true);
      setAnalytics(await a.json());
      // FIRST PAINT NOW: the shell + tabs render after ONE round trip. The
      // batch below fills each section in as it lands - one slow lambda
      // (ai-status probing providers, a cold users query) must never hold the
      // whole workspace hostage on skeletons.
      setLoaded(true);

      const j = (r: PromiseSettledResult<Response>) =>
        r.status === "fulfilled" ? r.value.json().catch(() => ({})) : Promise.resolve({});

      // KEYS + PERSISTENCE FIRST, on their own round trip. These were batched
      // with ai-status (which probes every provider over the network), so the
      // Keys page and the persistence banner waited on the SLOWEST call in the
      // group - minutes on a cold start. They are cheap; nothing may block them.
      const cfgOnly = await Promise.allSettled([fetch("/api/admin/config")]);
      const cfgEarly = await j(cfgOnly[0]);
      if (cfgEarly.keys) {
        setKeys(cfgEarly.keys);
        setPersistent(Boolean(cfgEarly.persistent));
        const early = (cfgEarly.keys as KeyInfo[]).find((k) => k.name === "APP_DOMAIN");
        if (early && !early.configured) setCollapsedScopes((c) => ({ ...c, auth: false }));
      }

      const [uR, billR, meR, aiR, trR, fbR] = await Promise.allSettled([
        fetch("/api/admin/users"),
        fetch("/api/billing/checkout"),
        fetch("/api/auth/me"),
        fetch("/api/admin/ai-status"),
        fetch("/api/admin/training"),
        fetch("/api/admin/feedback"),
      ]);
      const [u, bill, me, ai, tr, fb] = await Promise.all([
        j(uR), j(billR), j(meR), j(aiR), j(trR), j(fbR),
      ]);
      const cfg = cfgEarly;
      setKeys(cfg.keys ?? []);
      // Surface the "Public app domain" field: while APP_DOMAIN is unset, the
      // 🔐 Auth & social group starts EXPANDED so the one key that fixes the
      // webhook/share/SEO origin is never hidden behind a collapsed header.
      const appDomain = (cfg.keys ?? []).find((k: KeyInfo) => k.name === "APP_DOMAIN");
      if (appDomain && !appDomain.configured) {
        setCollapsedScopes((s) => ({ ...s, auth: false }));
      }
      setPersistent(Boolean(cfg.persistent));
      setUsers(u.users ?? []);
      setPlans(bill.plans ?? []);
      setBillingOn(Boolean(bill.configured));
      setIsOwner(me.session?.role === "owner");
      setAiProviders(ai.providers ?? []);
      setTrainingCount((tr.examples ?? []).length);
      setMemory(tr.examples ?? []);
      setFeedbackRows(fb.feedback ?? []);
      setFeedbackByCategory(fb.byCategory ?? {});
      setFeedbackTotal(typeof fb.total === "number" ? fb.total : null);
      setFeedbackNextOffset(Number(fb.nextOffset) || 0);
      setFeedbackHasMore(Boolean(fb.hasMore));
      // Costs are non-blocking - never make first paint wait on them.
      refreshCosts().catch(() => {});
    })().catch(() => setAuthorized(false));
  }, []);

  // Auto-probe the WhatsApp host pool the first time the owner opens Keys.
  useEffect(() => {
    if (tab === "keys" && waHosts === null && !waHostsBusy) loadWaHosts();
    if (tab === "data" && dataTables.length === 0) loadDataTables();
    if (tab === "command" && !command) loadCommand().catch(() => {});
    if (tab === "analytics" && floors.length === 0) loadFloors().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const visibleUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    let list = users.filter(
      (u) =>
        !q ||
        u.email.toLowerCase().includes(q) ||
        (u.phone ?? "").toLowerCase().includes(q) ||
        u.role.includes(q) ||
        (u.plan ?? "").includes(q)
    );
    if (userSort === "new") list = [...list].sort((a, b) => b.lastSeen - a.lastSeen);
    else if (userSort === "old") list = [...list].sort((a, b) => a.lastSeen - b.lastSeen);
    else
      list = [...list].sort((a, b) => {
        const rank = (u: UserRecord) => (u.role === "owner" ? 0 : u.role === "admin" ? 1 : 2);
        return rank(a) - rank(b) || b.lastSeen - a.lastSeen;
      });
    return list;
  }, [users, userSearch, userSort]);

  async function runDiag(kind: "supabase" | "maps" | "email" | "rpc") {
    setDiagBusy(kind);
    setDiag(null);
    try {
      if (kind === "rpc") {
        // Asks the DATABASE whether the dangerous SECURITY DEFINER prune
        // function is still reachable with the public anon key - the probe
        // calls it exactly as an attacker would, with a 100-year window so a
        // still-exposed function deletes nothing. "unknown" is reported as
        // unknown: a green light that only means "we did not check" is worse
        // than no light at all.
        const res = await fetch("/api/admin/rpc-exposure");
        const d = await res.json();
        setDiag({
          kind,
          ok: d.state === "locked",
          text:
            d.state === "locked"
              ? `✅ Locked. ${d.detail}`
              : d.state === "exposed"
                ? `🚨 EXPOSED. ${d.detail}`
                : `❔ Unknown. ${d.detail}`,
        });
        return;
      }
      if (kind === "email") {
        // Sends a REAL email through the production chain to the admin's own
        // address, so "I entered the env values" becomes a verified fact.
        const res = await fetch("/api/admin/email-test", { method: "POST" });
        const d = await res.json();
        const s = d.status ?? {};
        const providers = `Providers configured - Gmail: ${s.gmail ? "yes" : "no"}, Brevo: ${
          s.brevo ? "yes" : "no"
        }, Resend: ${s.resend ? "yes" : "no"}.`;
        const outcome = d.sent
          ? `✅ Sent via ${d.provider} to ${d.to}. Check that inbox (and spam).`
          : `❌ Not sent${d.provider ? ` (tried ${d.provider})` : ""}: ${d.error ?? "unknown"}`;
        setDiag({
          kind,
          ok: Boolean(d.sent),
          text: [outcome, d.hint ? `Hint: ${d.hint}` : "", providers].filter(Boolean).join("\n"),
        });
        return;
      }
      const res = await fetch(kind === "supabase" ? "/api/admin/supabase-test" : "/api/admin/maps-test");
      const d = await res.json();
      if (kind === "supabase") {
        setDiag({ kind, ok: Boolean(d.appConfigOk), text: d.detail ?? "No result." });
      } else {
        const lines = [
          `Places API (New): ${d.placesNew?.ok ? "OK" : "FAILED"} - ${d.placesNew?.detail}`,
          `Places Autocomplete (New): ${d.placesAutocomplete?.ok ? "OK" : "FAILED"} - ${d.placesAutocomplete?.detail}`,
          `Places API (legacy): ${d.placesLegacy?.ok ? "OK" : "FAILED"} - ${d.placesLegacy?.detail}`,
          `Geocoding: ${d.geocoding?.ok ? "OK" : "FAILED"} - ${d.geocoding?.detail}`,
          // Shop photos are their own billed SKU and can fail alone. Without
          // this line the panel read all-green while every card photo was
          // broken, because nothing here had ever fetched an actual image.
          `Place Photos: ${d.placePhotos?.ok ? "OK" : "FAILED"} - ${d.placePhotos?.detail}`,
        ];
        setDiag({
          kind,
          ok: Boolean((d.placesNew?.ok || d.placesLegacy?.ok) && d.placePhotos?.ok),
          text: d.keyConfigured ? lines.join("\n") : "No Google Maps key configured yet.",
        });
      }
    } catch {
      setDiag({ kind, ok: false, text: "Could not run the test." });
    } finally {
      setDiagBusy(null);
    }
  }

  async function saveKey(name: string, valueOverride?: string) {
    // valueOverride: the flag on/off shortcut passes its value directly -
    // setEditing is async, so reading the state here would race the click.
    const value = valueOverride ?? editing[name] ?? "";
    setSavingKey(name);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, value }),
      });
      const data = await res.json();
      if (data.key) {
        setKeys((ks) => ks.map((k) => (k.name === name ? data.key : k)));
        setEditing((e) => ({ ...e, [name]: "" }));
        setSaved(name);
        setKeyWarning(data.warning ?? null);
        setTimeout(() => setSaved(null), 1500);
      } else if (data.error) {
        setKeyWarning(data.error);
      }
    } finally {
      setSavingKey(null);
    }
  }

  async function toggleReveal() {
    if (revealed) {
      setRevealed(null);
      return;
    }
    const res = await fetch("/api/admin/config?reveal=1");
    const data = await res.json();
    if (data.values) setRevealed(data.values);
  }

  async function switchProvider(provider: string) {
    const res = await fetch("/api/admin/ai-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const data = await res.json();
    if (data.providers) setAiProviders(data.providers);
    // SURFACE FAILURES. This used to update nothing when the POST returned an
    // error (unknown provider, or a vault write that did not persist), so the
    // star silently stayed on the old provider and the click looked ignored.
    if (data.error || (!res.ok && !data.providers)) {
      setKeyWarning(
        `Could not switch provider: ${data.error ?? res.status}. If persistence is off, the choice cannot be saved.`
      );
    } else if (data.warning) {
      setKeyWarning(data.warning);
    }
  }

  async function runDistill() {
    setDistillBusy(true);
    setDistillMsg(null);
    try {
      const res = await fetch("/api/admin/distill", { method: "POST" });
      const d = await res.json();
      setDistillMsg(
        d.error
          ? `⚠ ${d.error}`
          : `✓ Distilled ${d.written ?? 0} exemplar(s) from ${d.mined ?? 0} winning turn(s)${
              d.provider ? ` via ${d.provider}` : ""
            }.`
      );
    } catch {
      setDistillMsg("⚠ Could not run distillation - try again.");
    } finally {
      setDistillBusy(false);
    }
  }

  async function importTraining() {
    setTrainMsg(null);
    setTrainBusy(true);
    try {
      const res = await fetch("/api/admin/training/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers: trainNumbers }),
      });
      const data = await res.json();
      if (res.ok) {
        setTrainOk((data.imported ?? 0) > 0);
        setTrainMsg(data.note ?? "Done.");
        await refreshMemory();
      } else {
        setTrainOk(false);
        setTrainMsg(data.error ?? "Could not import.");
      }
    } catch {
      setTrainOk(false);
      setTrainMsg("Could not reach the WhatsApp connector.");
    } finally {
      setTrainBusy(false);
    }
  }

  async function userAction(body: Record<string, string>) {
    setUserMsg(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    // A refused or half-applied action still ships the CURRENT list (the erase
    // and block paths both do), so render it rather than leaving the panel on a
    // stale row that no longer matches the database.
    if (Array.isArray(data.users)) setUsers(data.users);
    if (data.error) setUserMsg(data.error);
  }

  if (authorized === null) {
    return (
      <Shell>
        <div className="surface-strong mb-4 flex gap-1 rounded-2xl p-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton h-8 flex-1 rounded-xl" />
          ))}
        </div>
        <SkeletonList count={4} />
        <p className="mt-4 text-center text-[12px] font-bold text-faint">
          <LoadingDots label="Checking access" />
        </p>
      </Shell>
    );
  }
  if (!authorized) {
    return (
      <Shell>
        <div className="mt-20 text-center">
          <Icon name="lock" className="mx-auto mb-3 h-10 w-10 text-faint" />
          <p className="text-soft">This workspace is restricted to management.</p>
          <a href="/login" className="mt-3 inline-block font-extrabold text-brandblue underline">
            Sign in with a management email
          </a>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="surface-strong no-scrollbar mb-4 flex gap-1 overflow-x-auto rounded-2xl p-1">
        {/* The graph-era "Agents" (Pipeline Studio) tab is DELETED - the app
            runs on the single-pass engine. "Ops" (the cross-user AI Operations
            Center with the real learning loop) is RESTORED, owner-only: it was
            retired alongside agents in one sweep, but it is a live surface the
            learning loop writes to, and hiding it only meant the owner could
            not reach their own review queue (owner decision 5). */}
        {([
          "command",
          "analytics",
          "money",
          "waba",
          "risk",
          "engine",
          ...(isOwner ? (["ops"] as const) : []),
          "i18n",
          "keys",
          "users",
          "feedback",
          "billing",
          "data",
          "settings",
        ] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`btn btn-sm shrink-0 rounded-xl px-3 py-2 text-[11px] font-extrabold capitalize ${
              tab === t ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
            }`}
          >
            {t === "command"
              ? "🎯 command"
              : t === "engine"
                ? "🧠 engine"
                : t === "ops"
                  ? "🧭 ops"
                  : t === "money"
                    ? "💸 money"
                    : t === "waba"
                      ? "📲 wa business"
                      : t === "risk"
                        ? "🛡 risk"
                        : t === "i18n"
                          ? "🌐 copy"
                          : t === "settings"
                            ? "⚙️ settings"
                            : t}
            {t === "feedback" && feedbackRows.length > 0 ? ` (${feedbackRows.length})` : ""}
            {t === "command" && (command?.alerts.filter((a) => a.level === "critical").length ?? 0) > 0
              ? ` (${command!.alerts.filter((a) => a.level === "critical").length}!)`
              : ""}
          </button>
        ))}
      </div>

      {!loaded && <SkeletonList count={4} />}

      {loaded && tab === "command" && (
        <InfoTipProvider>
        <div className="space-y-3">
          {/* A failed leg is an error card with a Retry, never a permanent
              skeleton and never a silent hole (3.5 - the owner's screenshot
              was this tab skeletal forever because ONE fetch had failed). */}
          {commandErrs.length > 0 && (
            <div className="rounded-blob border-2 border-brandred/40 bg-brandred-soft p-3">
              <div className="text-[12px] font-extrabold text-brandred">
                Could not load: {commandErrs.join(", ")}
              </div>
              <button
                onClick={() => loadCommand()}
                className="btn btn-sm mt-2 rounded-xl border-2 border-brandred/40 px-3 text-[11px] font-extrabold text-brandred"
              >
                ↻ Retry
              </button>
            </div>
          )}
          {/* Live pulse */}
          {command ? (
            <>
              {/* A read that failed is the most urgent thing on this page:
                  every figure below is computed over a subset we cannot
                  describe - so the banner renders ABOVE the numbers. */}
              <DegradedBanner degraded={command.degraded} />
              <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                {/* StatTile renders null as a dash - "0 shop replies" in large
                    type during a total outage is the exact lie the fail-dark
                    work exists to prevent - and its type demands a
                    COMMAND_HELP entry, so a KPI cannot ship unexplained. */}
                <StatTile help={COMMAND_HELP} helpId="waSessions" emoji="🟢" value={command.stats.waSessions} />
                <StatTile help={COMMAND_HELP} helpId="repliesToday" emoji="📥" value={command.stats.repliesToday} />
                <StatTile help={COMMAND_HELP} helpId="offersToday" emoji="🤝" value={command.stats.offersToday} />
                <StatTile help={COMMAND_HELP} helpId="queuedMessages" emoji="🕘" value={command.stats.queuedMessages} />
                <StatTile help={COMMAND_HELP} helpId="openIssues" emoji="🐛" value={command.stats.openIssues} />
              </div>

              {/* Queued messages now live in the user-facing find-deals page
                  (item #2) - every traveller manages their own queue there. */}

              {/* Popular-questions manager: add (AI or by hand) / remove (#18) */}
              <FaqManager />

              {/* Needs your attention NOW */}
              <div className="surface rounded-blob p-4">
                <div className="mb-2 text-[13px] font-extrabold text-strong">
                  🎯 Needs your attention
                </div>
                {command.alerts.length === 0 ? (
                  <p className="rounded-xl bg-savings-soft p-3 text-center text-[12px] font-extrabold text-savings">
                    ✓ All clear - nothing needs you right now.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {command.alerts.map((a, i) => (
                      <button
                        key={i}
                        onClick={() => a.href && setTab(a.href as typeof tab)}
                        className={`block w-full rounded-xl border-2 p-2.5 text-left ${
                          a.level === "critical"
                            ? "border-brandred/40 bg-brandred-soft"
                            : a.level === "warning"
                            ? "border-brandyellow/40 bg-brandyellow-soft"
                            : "border-line bg-card2"
                        }`}
                      >
                        <div
                          className={`text-[12px] font-extrabold ${
                            a.level === "critical"
                              ? "text-brandred"
                              : a.level === "warning"
                              ? "text-warn"
                              : "text-strong"
                          }`}
                        >
                          {a.level === "critical" ? "🚨" : a.level === "warning" ? "⚠️" : "ℹ️"}{" "}
                          {a.title}
                        </div>
                        <div className="mt-0.5 text-[11px] text-soft">{a.detail}</div>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => loadCommand()}
                  className="btn btn-ghost btn-sm mt-2 w-full rounded-xl border-2 border-line text-[11px] font-extrabold text-brandblue"
                >
                  ↻ Refresh
                </button>
              </div>

              {/* X (Twitter) post studio - top model drafts 5 on-trend posts */}
              <div className="surface rounded-blob p-4">
                <div className="mb-1 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                  𝕏 Post studio
                  <span className="badge-flash rounded-full px-2 py-0.5 text-[9px] font-extrabold">
                    Top model
                  </span>
                </div>
                <p className="mb-2 text-[11px] text-faint">
                  Our best AI drafts 5 ready-to-post X ideas in WheelDeal&apos;s playful-pro
                  voice - on-trend hooks, emojis, hashtags and a funny image idea. Leave
                  the box empty for fresh trending ideas, or steer it with a theme.
                </p>
                <div className="mb-2 flex gap-2">
                  <input
                    value={xTheme}
                    onChange={(e) => setXTheme(e.target.value)}
                    placeholder="Optional theme, e.g. Songkran in Thailand, scooter myths..."
                    className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                  />
                  <button
                    onClick={genXPosts}
                    disabled={xBusy}
                    className="btn btn-primary btn-sm rounded-xl px-3 text-[12px] disabled:opacity-60"
                  >
                    {xBusy ? <LoadingDots light /> : xPosts.length ? "↻ New 5" : "✨ Draft 5"}
                  </button>
                </div>
                {xErr && <p className="mb-1 text-[11px] font-bold text-brandred">{xErr}</p>}
                <div className="space-y-2">
                  {xPosts.map((p, i) => (
                    <div key={i} className="rounded-xl border-2 border-line p-2.5">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold uppercase text-brandblue">
                          {p.angle || `Option ${i + 1}`}
                        </span>
                        <button
                          onClick={() => {
                            const full = `${p.text}\n\n${p.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")}`;
                            navigator.clipboard?.writeText(full);
                            setXCopied(i);
                            setTimeout(() => setXCopied(null), 1500);
                          }}
                          className="btn btn-sm chip rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandblue"
                        >
                          {xCopied === i ? "Copied ✓" : "Copy"}
                        </button>
                      </div>
                      <p className="whitespace-pre-wrap text-[12px] text-strong">{p.text}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.hashtags.map((h) => (
                          <span key={h} className="text-[10px] font-bold text-brandblue">
                            {h.startsWith("#") ? h : `#${h}`}
                          </span>
                        ))}
                      </div>
                      {p.imageIdea && (
                        <div className="mt-1 text-[10px] text-faint">📸 {p.imageIdea}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : commandErrs.length === 0 ? (
            <SkeletonList count={3} />
          ) : null}
        </div>
        </InfoTipProvider>
      )}

      {loaded && tab === "engine" && <EngineInspectorPanel />}

      {loaded && tab === "money" && <LifecyclePanel />}

      {loaded && tab === "waba" && <WabaConsolePanel />}
      {loaded && tab === "risk" && <BanRiskPanel />}
      {loaded && tab === "i18n" && <TranslationRepairPanel />}

      {loaded && tab === "ops" && isOwner && <OpsCenterPanel />}

      {loaded && tab === "settings" && (
        <div className="space-y-3">
          <div className="surface rounded-blob p-4">
            <div className="mb-1 text-[13px] font-extrabold text-strong">⚙️ Workspace settings</div>
            <p className="mb-3 text-[11px] text-faint">
              Theme and language for this device - the same controls travellers have, gathered in
              one place so they are never hunted for across tabs.
            </p>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <LanguageButton />
            </div>
          </div>
        </div>
      )}

      {/* Market floors - moved to Analytics (item #16), foldable */}
      {loaded && tab === "analytics" && (
        <div className="mb-3 space-y-3">
          <details className="surface rounded-blob p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span className="text-[13px] font-extrabold text-strong">
                📉 Cheapest-price table (market floors)
              </span>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {floors.length} rows ▾
              </span>
            </summary>
            <div className="mt-2">
            <p className="mb-2 text-[11px] text-faint">
              The lowest realistic daily price per area and vehicle bucket, from
              live web research (first search in an area triggers it), refreshed
              every 3 weeks; your manual edits always win. The bargaining agent
              never asks below these floors.
            </p>
            <div className="mb-2 flex items-start gap-2">
              <div className="flex-1">
                <PlaceAutocomplete
                  placeholder="Research an area now, e.g. koh samui, thailand"
                  value={floorRegion}
                  onText={setFloorRegion}
                />
              </div>
              <button
                onClick={async () => {
                  if (!floorRegion.trim()) return;
                  setFloorBusy(true);
                  setFloorMsg(null);
                  try {
                    const r = await (
                      await fetch("/api/admin/market", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ region: floorRegion }),
                      })
                    ).json();
                    setFloorMsg(r.note ?? r.error ?? null);
                    const m = await (await fetch("/api/admin/market")).json();
                    if (m.rows) setFloors(m.rows);
                  } finally {
                    setFloorBusy(false);
                  }
                }}
                disabled={floorBusy}
                className="btn btn-primary btn-sm rounded-xl px-3 text-[11px] disabled:opacity-60"
              >
                {floorBusy ? <LoadingDots light /> : "🔍 Research"}
              </button>
            </div>
            {floorMsg && <p className="mb-2 text-[11px] font-bold text-savings">{floorMsg}</p>}
            <div className="mb-2 rounded-xl bg-card2 p-2 text-[10px] leading-relaxed text-faint">
              🌐 <b>Autonomous:</b> a new area is researched from the live web and
              saved the first time a user searches there (or when you research it
              above), then refreshed every 3 weeks. We store ONE row per area +
              vehicle bucket - never per town - so the database stays small and
              every later visit to that area is instant. Prices are always in the
              area&apos;s <b>local currency</b>. 👑 = your manual edit (survives
              refreshes), 🌐 = web research, 🤖 = model estimate.
            </div>
            {floors.length === 0 ? (
              <p className="rounded-xl bg-card2 p-3 text-center text-[11px] font-bold text-faint">
                No areas researched yet - it happens automatically on the first search
                in an area, or run one above.
              </p>
            ) : (
              (() => {
                // 2-D matrix: one block per AREA, rows = vehicle bucket,
                // columns = floor / typical, in that area's local currency.
                const byArea = new Map<string, typeof floors>();
                for (const f of floors) {
                  if (!byArea.has(f.region_key)) byArea.set(f.region_key, []);
                  byArea.get(f.region_key)!.push(f);
                }
                const VLABEL: Record<string, string> = {
                  "scooter-110": "Scooter 110cc", "scooter-125": "Scooter 125cc", "scooter-160": "Scooter 160cc",
                  "motorbike-150": "Bike 150cc", "motorbike-300": "Bike 300cc", "motorbike-500": "Bike 500cc", "motorbike-big": "Bike 650cc+",
                  "car-economy": "Car economy", "car-sedan": "Car sedan", "car-suv": "Car SUV", "car-van": "Car van", "car-luxury": "Car luxury",
                };
                return (
                  <div className="space-y-3">
                    {[...byArea.entries()].map(([area, rows]) => (
                      <div key={area} className="rounded-xl border-2 border-line">
                        <div className="flex items-center justify-between bg-card2 px-2 py-1.5">
                          <span className="text-[11px] font-extrabold text-strong">📍 {area}</span>
                          <span className="text-[10px] font-bold text-faint">
                            {rows[0]?.currency} · {rows.length} vehicles
                          </span>
                        </div>
                        <table className="w-full text-[11px]">
                          <thead className="text-left text-[9px] uppercase text-faint">
                            <tr>
                              <th className="p-1.5">Vehicle</th>
                              <th className="p-1.5">Floor/day</th>
                              <th className="p-1.5">Typical</th>
                              <th className="p-1.5">Src</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((f) => (
                              <tr key={f.id} className="border-t border-line text-soft">
                                <td className="p-1.5 font-bold">{VLABEL[f.vehicle_key] ?? f.vehicle_key}</td>
                                <td className="p-1.5">
                                  <input
                                    defaultValue={f.floor_per_day}
                                    onBlur={async (e) => {
                                      const v = Number(e.target.value);
                                      if (v > 0 && v !== f.floor_per_day) {
                                        await fetch("/api/admin/market", {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ id: f.id, floor: v }),
                                        });
                                        const m = await (await fetch("/api/admin/market")).json();
                                        if (m.rows) setFloors(m.rows);
                                      }
                                    }}
                                    className="w-14 rounded border border-line bg-card p-1 text-strong"
                                  />
                                </td>
                                <td className="p-1.5">{f.typical_per_day ?? "-"}</td>
                                <td className="p-1.5">{f.source === "owner" ? "👑" : f.source === "web" ? "🌐" : "🤖"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ))}
                  </div>
                );
              })()
            )}
            </div>
          </details>
        </div>
      )}

      {/* Anti-Ban engine + Sponsored shops - moved to Command (item #16), foldable */}
      {loaded && tab === "command" && (
        <div className="mt-3 space-y-3">
          <details className="surface rounded-blob p-4">
            <summary className="cursor-pointer list-none text-[13px] font-extrabold text-strong">
              🛡 Anti-Ban engine <span className="text-[10px] font-bold text-faint">▾</span>
            </summary>
            <div className="mt-2">
            <p className="mb-2 text-[11px] text-faint">
              Dynamic trust scores per connected number (replies build trust and
              relax hourly limits) and every policy knob - edits apply live, no
              redeploy.
            </p>
            {waSec ? (
              <>
                {waSec.reputation.length > 0 && (
                  <div className="mb-3 space-y-1.5">
                    {waSec.reputation.map((r) => {
                      const paused = r.paused_until && new Date(r.paused_until).getTime() > Date.now();
                      const risk = r.risk?.score ?? r.risk_score ?? 0;
                      return (
                        <div key={r.sender_key} className="rounded-xl bg-card2 p-2 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-bold text-soft">{r.sender_key}</span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                                risk >= 70
                                  ? "bg-brandred text-white"
                                  : risk >= 40
                                  ? "bg-brandyellow-soft text-warn"
                                  : "bg-savings-soft text-savings"
                              }`}
                            >
                              risk {risk}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-faint">
                            <span>trust {r.trust_score}</span>
                            <span>{r.sent_total} sent</span>
                            <span>{r.replies_total} replies</span>
                            {(r.blocks_total ?? 0) > 0 && (
                              <span className="text-brandred">{r.blocks_total} blocks</span>
                            )}
                            {(r.fails_total ?? 0) > 0 && (
                              <span className="text-brandred">{r.fails_total} fails</span>
                            )}
                          </div>
                          {r.risk?.reasons?.length ? (
                            <div className="mt-0.5 text-[10px] text-faint">
                              {r.risk.reasons.join(" · ")}
                            </div>
                          ) : null}
                          {paused && (
                            <div className="mt-1 flex items-center justify-between rounded-lg bg-brandred-soft p-1.5">
                              <span className="text-[10px] font-extrabold text-brandred">
                                ⏸ Paused until {new Date(r.paused_until!).toLocaleTimeString()}
                              </span>
                              <button
                                onClick={async () => {
                                  await fetch("/api/admin/wa-security", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ action: "clear-pause", senderKey: r.sender_key }),
                                  });
                                  loadCommand();
                                }}
                                className="btn btn-sm rounded-lg bg-card px-2 text-[10px] font-extrabold text-brandblue"
                              >
                                Resume
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {Object.entries(waSec.policies).map(([k, v]) => {
                    const h = waSec.help?.[k];
                    return (
                      <label key={k} className="relative rounded-xl border-2 border-line p-2 text-[10px] font-bold text-faint">
                        <span className="flex items-center gap-1">
                          {h?.label ?? k.replace(/_/g, " ")}
                          {h && (
                            <button
                              type="button"
                              aria-label={`What is ${h?.label ?? k.replace(/_/g, " ")}?`}
                              onClick={(e) => {
                                e.preventDefault();
                                setWaHelp(waHelp === k ? null : k);
                              }}
                              className="flex h-4 w-4 items-center justify-center rounded-full bg-brandblue-soft text-[9px] font-extrabold text-brandblue"
                            >
                              i
                            </button>
                          )}
                        </span>
                        <input
                          // Keyed to the EFFECTIVE value: after a save (or a
                          // rejection) the field re-mounts showing what the
                          // engine actually holds, so the panel can never
                          // display "on" while the engine holds false.
                          key={`${k}:${String(v)}`}
                          defaultValue={String(v)}
                          onBlur={async (e) => {
                            const val = e.target.value.trim();
                            if (!val || val === String(v)) return;
                            const r = await (
                              await fetch("/api/admin/wa-security", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ key: k, value: val }),
                              })
                            ).json();
                            if (r.error) {
                              setWaPolicyErr({ key: k, error: String(r.error) });
                              e.target.value = String(v);
                              return;
                            }
                            setWaPolicyErr(null);
                            if (r.policies) setWaSec({ ...waSec, policies: r.policies });
                          }}
                          className="mt-0.5 w-full rounded border border-line bg-card p-1 text-[12px] font-extrabold text-strong"
                        />
                        {waPolicyErr?.key === k && (
                          <div className="mt-1 text-[10px] font-extrabold text-brandred">
                            {waPolicyErr.error}
                          </div>
                        )}
                        {waHelp === k && h && (
                          <div className="absolute left-0 top-full z-20 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-xl border-2 border-brandblue bg-card p-2.5 text-[11px] shadow-xl">
                            <div className="font-extrabold text-strong">{h.label}</div>
                            <div className="mt-1 font-normal text-soft">{h.help}</div>
                            <div className="mt-1.5 font-bold text-savings">✓ {h.best}</div>
                            <button
                              onClick={(e) => {
                                e.preventDefault();
                                setWaHelp(null);
                              }}
                              className="mt-1.5 text-[10px] font-extrabold text-brandblue"
                            >
                              Close
                            </button>
                          </div>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            ) : (
              <SkeletonList count={2} />
            )}
            </div>
          </details>

          {/* Sponsored shops: paid placements with the glowing Recommended card */}
          <details className="surface rounded-blob p-4">
            <summary className="flex cursor-pointer list-none items-center justify-between">
              <span className="text-[13px] font-extrabold text-strong">⭐ Sponsored shops</span>
              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                {sponsors.filter((s) => s.active).length} live ▾
              </span>
            </summary>
            <div className="mt-2">
            <p className="mb-2 text-[11px] text-faint">
              Shops that pay for placement appear FIRST under every sort, with a
              glowing frame and a &ldquo;Promoted - paid placement&rdquo; banner.
              The banner names it as paid, because a card that leads a sort it
              did not win must say why. Match by the shop&apos;s Google Maps name
              and/or phone number.
            </p>
            <div className="mb-2 space-y-1.5">
              <input
                value={spName}
                onChange={(e) => setSpName(e.target.value)}
                placeholder="Shop name exactly as on Google Maps"
                className="w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
              />
              <div className="flex gap-1.5">
                <input
                  value={spPhone}
                  onChange={(e) => setSpPhone(e.target.value)}
                  placeholder="Phone (optional, exact match)"
                  className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                />
                <input
                  value={spNotes}
                  onChange={(e) => setSpNotes(e.target.value)}
                  placeholder="Deal notes (private)"
                  className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                />
              </div>
              <button
                onClick={async () => {
                  if (!spName.trim()) return;
                  const r = await (
                    await fetch("/api/admin/sponsored", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: spName, phone: spPhone, notes: spNotes }),
                    })
                  ).json();
                  if (r.rows) {
                    setSponsors(r.rows);
                    setSpName("");
                    setSpPhone("");
                    setSpNotes("");
                  }
                }}
                className="btn btn-primary btn-sm w-full rounded-xl text-[12px]"
              >
                + Add sponsored shop
              </button>
            </div>
            {sponsors.length > 0 && (
              <div className="space-y-1.5">
                {sponsors.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-xl border-2 border-line p-2 text-[11px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-extrabold text-strong">
                        {s.active ? "⭐" : "💤"} {s.name}
                      </div>
                      <div className="truncate text-faint">
                        {s.phone ?? "no phone"} {s.notes ? `· ${s.notes}` : ""}
                      </div>
                    </div>
                    <div className="ml-2 flex shrink-0 gap-1.5">
                      <button
                        onClick={async () => {
                          const r = await (
                            await fetch("/api/admin/sponsored", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: s.id, active: !s.active }),
                            })
                          ).json();
                          if (r.rows) setSponsors(r.rows);
                        }}
                        className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandblue"
                      >
                        {s.active ? "Pause" : "Activate"}
                      </button>
                      <button
                        onClick={async () => {
                          const r = await (
                            await fetch(`/api/admin/sponsored?id=${s.id}`, { method: "DELETE" })
                          ).json();
                          if (r.rows) setSponsors(r.rows);
                        }}
                        className="btn btn-ghost btn-sm rounded-lg border-2 border-line px-2 text-[10px] font-extrabold text-brandred"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </div>
          </details>
        </div>
      )}


      {loaded && tab === "analytics" && analytics && (
        <div className="space-y-3">
          {/* Cost tracker: every request against the free quotas + est. cost */}
          {costs && (
            <div className="surface rounded-blob p-4">
              <div className="flex items-center justify-between">
                <div className="text-[13px] font-extrabold text-strong">💰 Cost tracker (this month)</div>
                {isOwner && (
                  <button
                    onClick={async () => {
                      // HONEST WRITE (OR11 D2.4 finally reaches a pixel): the
                      // route answers 502 "it is UNCHANGED" on a failed
                      // persist and a fleet warning on a memory-only one -
                      // this handler used to throw both away, so the one
                      // control labelled "for every user" was unverifiable
                      // from the screen it lives on.
                      setKillSwitchMsg(null);
                      try {
                        const res = await fetch("/api/admin/costs", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ killSwitch: !costs.killSwitch }),
                        });
                        const data = await res.json().catch(() => ({}) as { error?: string; warning?: string });
                        if (!res.ok) {
                          setKillSwitchMsg(data.error ?? "The switch did NOT change - the write failed.");
                        } else if (data.warning) {
                          setKillSwitchMsg(data.warning);
                        }
                      } catch {
                        setKillSwitchMsg("Could not reach the server - the switch is UNCHANGED.");
                      }
                      await refreshCosts();
                    }}
                    className={`btn btn-sm chip rounded-xl px-3 text-[11px] font-extrabold ${
                      costs.killSwitch ? "bg-brandred text-white" : "bg-card2 text-soft"
                    }`}
                  >
                    {costs.killSwitch ? "🔴 KILL SWITCH ON - tap to resume" : "⭕ Kill switch (owner)"}
                  </button>
                )}
              </div>
              {killSwitchMsg && (
                <p className="mt-1 rounded-xl border-2 border-brandyellow/50 bg-brandyellow-soft p-2 text-[11px] font-extrabold text-warn">
                  {killSwitchMsg}
                </p>
              )}
              {costs.killSwitch && (
                <p className="mt-1 rounded-xl bg-brandred-soft p-2 text-[11px] font-bold text-brandred">
                  All paid services and payments are PAUSED for every user.
                </p>
              )}
              <div className="mt-2 space-y-2">
                {(costs.apis ?? []).map((a: any) => (
                  <div key={a.kind}>
                    <div className="flex justify-between text-[11px] font-bold text-soft">
                      <span>{a.label}</span>
                      <span>
                        {a.used.toLocaleString()} / {a.free.toLocaleString()} free
                        {a.estCostUsd > 0 ? ` · ~$${a.estCostUsd} over` : " · $0.00"}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className={`h-full rounded-full ${
                          a.used >= a.free ? "bg-brandred" : a.used >= a.free * 0.8 ? "bg-brandyellow" : "bg-savings"
                        }`}
                        style={{ width: `${Math.min(100, (a.used / a.free) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="text-[11px] text-faint">
                  AI: {costs.stats?.aiCalls ?? 0} calls ·{" "}
                  {Object.entries(costs.aiTokens ?? {})
                    .map(([p, n]) => `${p} ${(n as number).toLocaleString()} tok`)
                    .join(" · ") || "0 tokens"}
                </div>
                {(costs.stats?.searchesThisMonth ?? 0) === 0 &&
                  (costs.stats?.aiCalls ?? 0) === 0 && (
                    <div className="rounded-xl bg-card2 p-2 text-[10px] text-faint">
                      No billable API usage recorded yet this month. Numbers
                      appear here as soon as real searches (Google Maps key set)
                      or AI calls happen. If you have used the app and this stays
                      at zero, run Test Supabase - the api_usage table may be
                      missing (re-run schema.sql).
                    </div>
                  )}
              </div>

              {/* Abuse limits - adjustable */}
              <div className="mt-3 border-t border-line pt-2">
                <div className="text-[12px] font-extrabold text-strong">🛡 Per-user abuse limits</div>
                <div className="mt-1 grid grid-cols-2 gap-2">
                  {Object.keys(costs.defaults ?? {}).map((name) => (
                    <label key={name} className="text-[10px] font-bold text-faint">
                      {name.replace("LIMIT_", "").replace(/_/g, " ").toLowerCase()}
                      <input
                        type="number"
                        min={1}
                        value={limitEdit[name] ?? ""}
                        onChange={(e) => setLimitEdit((p) => ({ ...p, [name]: e.target.value }))}
                        className="mt-0.5 w-full rounded-lg border-2 border-line bg-card p-1.5 text-[12px] font-bold text-strong"
                      />
                    </label>
                  ))}
                </div>
                <button
                  onClick={async () => {
                    setLimitsBusy(true);
                    setLimitsMsg(null);
                    // Same honesty as the kill switch: a failed persist must
                    // not repaint as saved.
                    try {
                      const res = await fetch("/api/admin/costs", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          limits: Object.fromEntries(
                            Object.entries(limitEdit).map(([k, v]) => [k, Number(v)])
                          ),
                        }),
                      });
                      const data = await res.json().catch(() => ({}) as { error?: string; warning?: string });
                      if (!res.ok) setLimitsMsg(data.error ?? "The limits did NOT save - the write failed.");
                      else if (data.warning) setLimitsMsg(data.warning);
                      await refreshCosts();
                    } catch {
                      setLimitsMsg("Could not reach the server - the limits are UNCHANGED.");
                    } finally {
                      setLimitsBusy(false);
                    }
                  }}
                  disabled={limitsBusy}
                  className="btn btn-primary btn-sm mt-2 w-full rounded-xl text-[12px] disabled:opacity-60"
                >
                  {limitsBusy ? <LoadingDots light label="Saving" /> : "Save limits"}
                </button>
                {limitsMsg && (
                  <p className="mt-1 rounded-xl border-2 border-brandyellow/50 bg-brandyellow-soft p-2 text-[11px] font-extrabold text-warn">
                    {limitsMsg}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Real durable stats (this month, from Supabase). `?? 0` was the
              fail-green lie: the route now sends exact counts that are null
              when unreadable, and a dash is the only honest render for null. */}
          <DegradedBanner degraded={costs?.degraded} />
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Searches this month" value={costs?.stats?.searchesThisMonth == null ? "-" : String(costs.stats.searchesThisMonth)} accent />
            <Metric label="Offers received" value={costs?.stats?.offersThisMonth == null ? "-" : String(costs.stats.offersThisMonth)} />
            <Metric label="Messages sent" value={costs?.stats?.messagesSent == null ? "-" : String(costs.stats.messagesSent)} />
            <Metric label="Total users" value={costs?.stats?.totalUsers == null ? "-" : String(costs.stats.totalUsers)} />
          </div>
          <div className="surface rounded-blob p-4">
            <div className="mb-3 flex items-center gap-1.5 text-sm font-extrabold text-strong">
              <Icon name="spark" className="h-4 w-4 text-brandred" /> Agent memory - negotiation playbook
            </div>
            <p className="mb-3 text-[12px] text-faint">
              Best performer:{" "}
              <span className="font-extrabold text-brandblue">{analytics.bestTactic ?? "-"}</span>
            </p>
            {/* Priors are not results. Every tactic still at its shipped
                baseline says so, and while ALL of them are, the panel says it
                once, loudly - "7/12 wins" on a fresh install is an invented
                number, and presenting it as evidence poisons every decision
                the owner makes against this screen. */}
            {analytics.allSeeded && (
              <p className="mb-2 rounded-xl bg-brandyellow-soft p-2.5 text-[11px] font-bold text-warn">
                These are the shipped starter priors - no live negotiation has been measured yet.
                The numbers below are a ranking aid, not results.
              </p>
            )}
            <div className="space-y-2">
              {analytics.tactics.map((t) => {
                const winRate = t.uses ? Math.round((t.wins / t.uses) * 100) : 0;
                return (
                  <div key={t.id} className="rounded-2xl bg-card2 p-3">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                        {t.label}
                        {t.seeded && (
                          <span
                            title="Still at the shipped starter priors - not yet measured in a live negotiation"
                            className="rounded-full bg-card px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-faint"
                          >
                            seeded
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-faint">
                        {t.wins}/{t.uses} wins · {t.avgDiscountPct}% avg cut
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
                      <div
                        className="h-full rounded-full bg-brandblue transition-all"
                        style={{ width: `${winRate}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {loaded && tab === "keys" && (
        <div className="space-y-3">
          {/* Ground truth first: what revision is serving, what the database
              actually has, whether anything is still draining the queue, and
              whether the agents have a model. A red line here explains a field
              failure before any code is suspected. */}
          <DeployInfoCard />

          {/* WHICH CEILING ARE WE CLOSEST TO. Above the roll call on purpose:
              every service can be answering while the pool is one user from
              the cap that gets a personal number banned. */}
          <ChokePointsCard />

          {/* Live service health with 10-minute auto-refresh (item #12) */}
          <HealthPanel />

          {/* WA doctor: one-tap inbound incident tracer + webhook re-arm */}
          <WaDoctorCard />

          {/* PayPal doctor: register/repair the billing webhook + reconcile
              plans against PayPal (4.3 - cancellations finally reach us). */}
          <PaypalDoctorCard />

          <div
            className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${
              persistent === null
                ? "border-line bg-card2 text-soft"
                : persistent
                  ? "border-savings bg-savings-soft text-savings"
                  : "border-brandyellow bg-brandyellow-soft text-warn"
            }`}
          >
            <Icon name="shield" className="mr-1 inline h-4 w-4" />
            {persistent === null
              ? "Checking the key vault connection…"
              : persistent
                ? "Persistence is on - edits are encrypted, saved to Supabase, applied within ~30s, and survive restarts."
                : "Persistence is OFF: Supabase is not connected, so anything you paste here resets on the next deploy and is NOT shared across instances. Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in your host env (GCP Secret Manager), run schema.sql, then redeploy - your saved keys are still in Supabase and reappear once it reconnects."}
          </div>

          {keyWarning && (
            <div className="rounded-2xl border-2 border-brandred bg-brandred-soft p-3 text-[12px] font-bold text-brandred">
              {keyWarning}
            </div>
          )}

          {/* One-tap live diagnostics */}
          <div className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">🩺 Connection tests</div>
            <p className="mb-2 text-[11px] text-faint">
              Fire a real request and get the exact error + fix, instead of guessing.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => runDiag("supabase")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
              >
                {diagBusy === "supabase" ? <LoadingDots label="Testing" /> : "Test Supabase"}
              </button>
              <button
                onClick={() => runDiag("maps")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
              >
                {diagBusy === "maps" ? <LoadingDots label="Testing" /> : "Test Google key"}
              </button>
              <button
                onClick={() => runDiag("email")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
              >
                {diagBusy === "email" ? <LoadingDots label="Sending" /> : "Send live test email"}
              </button>
            </div>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => runDiag("rpc")}
                disabled={diagBusy !== null}
                className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
                title="Checks whether the public anon key can still call prune_old_rows"
              >
                {diagBusy === "rpc" ? (
                  <LoadingDots label="Probing" />
                ) : (
                  "Check anon RPC lockdown"
                )}
              </button>
            </div>
            {diag && (
              <pre
                className={`mt-2 whitespace-pre-wrap rounded-xl p-2.5 font-sans text-[11px] font-bold ${
                  diag.ok ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
                }`}
              >
                {diag.text}
              </pre>
            )}
          </div>

          {/* WhatsApp host pool: live health + load across every free server */}
          <div className="surface rounded-blob p-4">
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">📡 WhatsApp host pool</div>
              <button
                onClick={loadWaHosts}
                disabled={waHostsBusy}
                className="btn btn-sm chip rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
              >
                {waHostsBusy ? <LoadingDots label="Checking" /> : waHosts ? "Refresh" : "Check hosts"}
              </button>
            </div>
            <p className="mb-2 mt-1 text-[11px] text-faint">
              Every free Evolution server you added in EVOLUTION_HOSTS, live. Users
              auto-spread across the healthy ones and fail over instantly if one sleeps.
            </p>
            {waHosts && (
              <>
                <div className="mb-2 flex gap-2">
                  <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                    {waHosts.healthy}/{waHosts.total} healthy
                  </span>
                  <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                    {waHosts.users} live sessions
                  </span>
                </div>
                {waHosts.total === 0 ? (
                  <p className="rounded-lg bg-card2 p-2 text-[11px] font-bold text-faint">
                    No hosts yet. Paste one url|key per line into EVOLUTION_HOSTS below,
                    then follow the deploy guide in GUIDE.md.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {waHosts.hosts.map((h) => (
                      <div
                        key={h.url}
                        className="rounded-xl border-2 border-line p-2"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                                h.healthy ? "bg-savings" : "bg-brandred"
                              }`}
                            />
                            <span className="truncate font-mono text-[11px] text-soft">
                              {h.url.replace(/^https?:\/\//, "")}
                            </span>
                          </div>
                          <span className="ml-2 shrink-0 text-[10px] font-extrabold text-faint">
                            {h.users} user{h.users === 1 ? "" : "s"}
                          </span>
                        </div>
                        {h.detail && (
                          <p
                            className={`mt-1 text-[10px] font-bold ${
                              h.healthy ? "text-savings" : "text-brandred"
                            }`}
                          >
                            {h.detail}
                          </p>
                        )}
                        <button
                          onClick={() => testOneWaHost(h.url)}
                          disabled={waHostTest[h.url]?.busy}
                          className="btn btn-sm chip mt-1.5 rounded-lg border-2 border-line px-2.5 text-[10px] font-extrabold text-brandblue disabled:opacity-60"
                        >
                          {waHostTest[h.url]?.busy ? <LoadingDots label="Testing" /> : "🩺 Test this server"}
                        </button>
                        {waHostTest[h.url] && !waHostTest[h.url].busy && waHostTest[h.url].detail && (
                          <p
                            className={`mt-1 rounded-lg p-1.5 text-[10px] font-bold ${
                              waHostTest[h.url].ok ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
                            }`}
                          >
                            {waHostTest[h.url].detail}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* AI providers: usage, remaining, switch, failover */}
          <div className="surface rounded-blob p-4">
            <div className="mb-1 text-[13px] font-extrabold text-strong">AI providers</div>
            <p className="mb-2 text-[11px] text-faint">
              The starred provider goes first; if it fails or runs out, the next
              one takes over automatically. Tap to switch.
            </p>
            <button
              onClick={runAiTest}
              disabled={aiTestBusy}
              className="btn btn-primary mb-2 w-full rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
            >
              {aiTestBusy ? "Testing every provider…" : "🧪 Test AI providers"}
            </button>
            {aiTestError && (
              <p className="mb-3 break-words text-[11.5px] font-bold text-brandred">
                The test call itself failed - that is unknown, not healthy.
                <span className="mt-0.5 block font-mono text-[10px]">{aiTestError}</span>
              </p>
            )}
            {aiTest !== null && (
              <div className="mb-3 space-y-1.5">
                {aiTest.map((t) => {
                  const drifted = t.ok && t.model && t.configuredModel && t.model !== t.configuredModel;
                  // A FAILURE IS NOT AUTOMATICALLY A FAULT. A 429 from a free
                  // tier at peak is the chain working as designed - red there
                  // sends the owner hunting for a broken key that is fine.
                  const kind = t.ok ? null : providerFailureKind(t.detail);
                  const ownerMustAct = kind !== null && providerNeedsOwner(kind);
                  // The same distinction INSIDE a green result: the fallback
                  // answering because the primary pool is busy/paywalled is
                  // the chain working (calm note, card stays green); the
                  // fallback answering because the primary id is dead is the
                  // drift this panel exists to catch (fix-me note, amber).
                  const driftKind = drifted ? providerFailureKind(t.primaryDetail) : null;
                  const driftBenign = driftKind === "busy" || driftKind === "paywalled";
                  return (
                    <div
                      key={t.name}
                      className={`rounded-2xl border-2 px-3 py-2 text-[11.5px] font-bold ${
                        !t.configured
                          ? "border-line bg-card2 text-faint"
                          : t.ok && (!drifted || driftBenign)
                            ? "border-savings/50 bg-savings-soft text-savings"
                            : kind === "paywalled"
                              ? "border-line bg-card2 text-faint"
                              : t.ok || !ownerMustAct
                                ? "border-brandyellow bg-brandyellow-soft text-warn"
                                : "border-brandred/60 bg-brandred-soft text-brandred"
                      }`}
                    >
                      <span className="capitalize">{t.name}</span>
                      {!t.configured ? (
                        " - no key set"
                      ) : t.ok ? (
                        <>
                          {" "}
                          - OK · <span className="font-mono text-[10.5px]">{t.model}</span>
                          {typeof t.ms === "number" ? ` · ${t.ms}ms` : ""}
                          {drifted && (
                            <div className="mt-0.5 font-mono text-[10px]">
                              {driftBenign
                                ? `primary ${t.configuredModel} is ${
                                    driftKind === "busy" ? "busy right now" : "behind a paywall"
                                  } - the fallback answered. Nothing to fix.`
                                : `primary ${t.configuredModel} FAILED - the fallback answered. Fix it or paste a working id as ${t.name.toUpperCase()}_MODEL.`}
                              {t.primaryDetail && (
                                <span className="mt-0.5 block break-words opacity-80">
                                  {t.primaryDetail}
                                </span>
                              )}
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {kind === "busy"
                            ? " - busy, not broken"
                            : kind === "paywalled"
                              ? " - paid now, skipped by design"
                              : " - failed"}
                          {/* The INTERPRETATION, then the evidence. Never one
                              without the other: a classifier that swallowed the
                              raw body would be the panel lying more politely. */}
                          <div className="mt-0.5 font-bold">
                            {providerFailureCopy(kind!, t.name)}
                          </div>
                          <div className="mt-0.5 break-words font-mono text-[10px] opacity-80">
                            {t.detail ?? "failed"}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="space-y-2">
              {aiProviders.map((p) => (
                <button
                  key={p.name}
                  onClick={() => switchProvider(p.name)}
                  className={`btn chip w-full rounded-2xl border-2 p-3 text-left ${
                    p.preferred ? "border-brandblue bg-brandblue-soft" : "border-line"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-extrabold capitalize text-strong">
                      {p.preferred ? "★ " : ""}
                      {p.name}
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                        p.configured ? "bg-savings-soft text-savings" : "bg-card2 text-faint"
                      }`}
                    >
                      {p.configured ? "key set" : "no key"}
                    </span>
                  </div>
                  {p.model && (
                    <div className="mt-0.5 font-mono text-[10px] text-faint">{p.model}</div>
                  )}
                  <div className="mt-0.5 text-[11px] text-soft">
                    {/* HONEST SCOPE LABEL (3.5): these counters live in process
                        memory, so on serverless they cover THIS INSTANCE since
                        its last cold start - not the fleet, not the cycle.
                        "Used here" read as a total; it is not one. The durable
                        cross-instance number is the "This day/month" line
                        below, from the ai_usage table. */}
                    This instance (since restart): {p.tokensUsed.toLocaleString()} tokens ·{" "}
                    {p.requests} calls
                    {p.failures > 0 ? ` · ${p.failures} failovers` : ""}
                  </div>
                  {p.cadence && p.cadence !== "none" && (
                    <div className="text-[11px] text-soft">
                      {/* `?? 0` here would have put the lie back one layer up:
                          null means the usage ledger could not be read, and a
                          zero reads as unused allowance. */}
                      This {p.cadence}:{" "}
                      {p.usedThisCycle === null || p.usedThisCycle === undefined ? (
                        <span className="font-bold text-brandred">usage unreadable</span>
                      ) : (
                        `${Number(p.usedThisCycle).toLocaleString()} tokens used`
                      )}
                      {" · "}
                      <span className="text-faint">
                        free tier resets {p.cadence === "day" ? "daily" : "monthly"}
                      </span>
                    </div>
                  )}
                  <div className="text-[11px] text-faint">
                    Remaining:{" "}
                    {p.remaining ??
                      (p.cadenceNote ?? "this provider does not expose remaining quota")}
                  </div>
                  {/* I-7: WHAT THE PROVIDER ACTUALLY SAID.
                      "14 calls, 14 failovers, 0 tokens" told the owner a
                      provider was failing and nothing about why - the reason
                      was caught into a local array and discarded. A drifted
                      model id answering 400 is the leading hypothesis, and the
                      served model id is printed next to it because with
                      <PROVIDER>_MODEL now settable it is no longer inferable
                      from the code. */}
                  {p.lastFailure && (
                    <div className="mt-1 rounded-lg bg-card2 p-1.5 text-left">
                      <div className="text-[10px] font-extrabold uppercase text-brandred">
                        Last failure
                      </div>
                      {p.lastFailure.model && (
                        <div className="font-mono text-[10px] text-faint">
                          sent as {p.lastFailure.model}
                        </div>
                      )}
                      <div className="mt-0.5 break-words font-mono text-[10px] text-soft">
                        {p.lastFailure.detail || "no detail recorded"}
                      </div>
                    </div>
                  )}
                </button>
              ))}
            </div>
            {isOwner && (
              <div className="mt-3 border-t border-line pt-3">
                <button
                  onClick={runDistill}
                  disabled={distillBusy}
                  className="btn btn-sm btn-ghost w-full rounded-xl border border-line py-2 text-[12px] font-extrabold disabled:opacity-50"
                >
                  {distillBusy ? "Distilling…" : "🧪 Distill now (teach the free models)"}
                </button>
                <p className="mt-1 text-[10px] text-faint">
                  Mines winning negotiation turns and distils them (DeepSeek-preferred) into few-shot
                  tactics the free models reuse next turn. Runs ~$0.
                </p>
                {distillMsg && <p className="mt-1 text-[11px] font-bold text-soft">{distillMsg}</p>}
              </div>
            )}
          </div>

          {/* Owner-only: reveal & copy raw values */}
          {isOwner && (
            <div className="surface rounded-blob p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[13px] font-extrabold text-strong">
                    👑 Owner: reveal all keys
                  </div>
                  <p className="text-[11px] text-faint">
                    Visible and copyable only for you. Keep this screen private.
                  </p>
                </div>
                <button onClick={toggleReveal} className="btn btn-sm btn-ghost rounded-xl px-3 text-[12px]">
                  {revealed ? "Hide" : "Reveal"}
                </button>
              </div>
              {revealed && (
                <div className="mt-2 space-y-1.5">
                  {revealed.map((v) => (
                    <div key={v.name} className="flex items-center gap-2 rounded-xl bg-card2 p-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] font-extrabold text-faint">{v.name}</div>
                        <div className="truncate font-mono text-[11px] text-strong">
                          {v.value || "- not set -"}
                        </div>
                      </div>
                      {v.value && (
                        <button
                          onClick={() => navigator.clipboard?.writeText(v.value)}
                          className="btn btn-sm chip shrink-0 rounded-lg bg-brandblue-soft px-2.5 py-1 text-[11px] font-extrabold text-brandblue"
                        >
                          Copy
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {(() => {
            const order = ["ai", "messaging", "maps", "email", "billing", "auth", "data"];
            const groupLabel: Record<string, string> = {
              ai: "🧠 AI providers",
              messaging: "💬 WhatsApp & messaging",
              maps: "🗺 Google Maps",
              email: "✉️ Email",
              billing: "💳 Payments & ads",
              auth: "🔐 Auth & social",
              data: "🗄 Data (bootstrap)",
            };
            const sorted = [...keys].sort(
              (a, b) => order.indexOf(a.scope) - order.indexOf(b.scope)
            );
            let lastScope = "";
            return sorted.map((k) => {
              const isFirstOfScope = k.scope !== lastScope;
              lastScope = k.scope;
              const collapsed = collapsedScopes[k.scope];
              const inScope = sorted.filter((x) => x.scope === k.scope);
              const doneCount = inScope.filter((x) => x.configured).length;
              const header = isFirstOfScope ? (
                <button
                  key={`hdr-${k.scope}`}
                  onClick={() =>
                    setCollapsedScopes((s) => ({ ...s, [k.scope]: !s[k.scope] }))
                  }
                  className="mt-3 flex w-full items-center gap-2 rounded-xl bg-card2 px-3 py-2 text-left"
                >
                  <span className="text-[10px] text-faint">{collapsed ? "▶" : "▼"}</span>
                  <span className="flex-1 text-[11px] font-extrabold uppercase tracking-wide text-strong">
                    {groupLabel[k.scope] ?? k.scope}
                  </span>
                  <span className="rounded-full bg-card px-2 py-0.5 text-[9px] font-bold text-faint">
                    {doneCount}/{inScope.length} set
                  </span>
                </button>
              ) : null;
              // Collapsed group: show only its header row.
              if (collapsed) {
                return header ? <div key={k.name}>{header}</div> : null;
              }
              return (
                <div key={k.name}>
                  {header}
                  <div className="surface rounded-blob p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[13px] font-extrabold text-strong">{k.label}</div>
                        <div className="font-mono text-[11px] text-faint">{k.name}</div>
                      </div>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
                          k.configured ? "bg-savings-soft text-savings" : "bg-card2 text-faint"
                        }`}
                      >
                        {k.configured ? "configured" : "missing"}
                      </span>
                    </div>
                    {!k.configured && k.docUrl && (
                      <a
                        href={k.docUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-[11px] font-extrabold text-brandblue underline"
                      >
                        Get this key ↗
                      </a>
                    )}
              <div className="mt-2 font-mono text-[12px] text-soft">{k.masked}</div>
              {/* The test button used to be gated on `editable`, which quietly
                  meant "no probe for anything the owner cannot paste here" -
                  and REDIS_URL is exactly that: env-only, and the one
                  dependency whose silence multiplies every daily cap by the
                  instance count. `testable` is the explicit allowlist. */}
              {(k.testable ?? k.editable) && (
                <>
                  <button
                    onClick={() => testKey(k.name)}
                    disabled={keyTestBusy !== null}
                    className="btn btn-sm chip mt-2 rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
                  >
                    {keyTestBusy === k.name ? <LoadingDots label="Testing" /> : "🩺 Test API"}
                  </button>
                  {keyTests[k.name] && (
                    <p
                      // Several probes answer in LINES (the host pool, the
                      // WABA block's shape/reachability/drift report). Without
                      // this they collapsed into one unreadable run-on.
                      className={`mt-1 whitespace-pre-wrap break-words rounded-lg p-2 text-[11px] font-bold ${
                        keyTests[k.name].ok
                          ? "bg-savings-soft text-savings"
                          : "bg-brandred-soft text-brandred"
                      }`}
                    >
                      {keyTests[k.name].detail}
                    </p>
                  )}
                </>
              )}
              {k.editable ? (
                k.name === "EVOLUTION_HOSTS" ? (
                  <div className="mt-2">
                    <textarea
                      rows={4}
                      placeholder={"https://host-1.onrender.com|apikey1\nhttps://host-2.koyeb.app|apikey2\nhttps://host-3.fly.dev|apikey3"}
                      value={editing[k.name] ?? ""}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [k.name]: e.target.value }))}
                      className="w-full rounded-xl border-2 border-line bg-card p-2 font-mono text-[12px] text-strong focus:border-brandblue focus:outline-none"
                    />
                    <p className="mt-1 text-[11px] text-faint">
                      One server per line as <span className="font-mono">url|apikey</span>. Add up
                      to 8+ free servers - users spread across them and fail over automatically.
                    </p>
                    <button
                      onClick={() => saveKey(k.name)}
                      disabled={savingKey === k.name}
                      className="btn btn-primary btn-sm mt-2 w-full rounded-xl px-3 text-[12px] disabled:opacity-60"
                    >
                      {savingKey === k.name ? <LoadingDots light /> : saved === k.name ? "Saved" : "Apply pool"}
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    {/* A SETTING is typed in the clear - a value entered blind
                        into a password box cannot be read back or corrected,
                        and for a flag that meant 'on' and 'off' were the same
                        four dots. Credentials keep the password field. */}
                    <input
                      type={k.secret === false ? "text" : "password"}
                      placeholder={k.secret === false ? "Set value (shown in the clear - it is a setting)" : "Set / rotate value"}
                      value={editing[k.name] ?? ""}
                      onChange={(e) => setEditing((ed) => ({ ...ed, [k.name]: e.target.value }))}
                      className="flex-1 rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
                    />
                    <button
                      onClick={() => saveKey(k.name)}
                      disabled={savingKey === k.name}
                      className="btn btn-primary btn-sm rounded-xl px-3 text-[12px] disabled:opacity-60"
                    >
                      {savingKey === k.name ? (
                        <LoadingDots light />
                      ) : saved === k.name ? (
                        "Saved"
                      ) : (
                        "Apply"
                      )}
                    </button>
                    {/* Every flag's label spells its dialect ('on' = ...), so
                        the two states are one tap instead of typed prose. The
                        saveKey path still verifies the write like any other. */}
                    {k.secret === false && /'(on|off)'/.test(k.label) && (
                      <>
                        {(["on", "off"] as const).map((v) => (
                          <button
                            key={v}
                            onClick={() => {
                              setEditing((ed) => ({ ...ed, [k.name]: v }));
                              void saveKey(k.name, v);
                            }}
                            disabled={savingKey === k.name}
                            className="btn btn-sm rounded-xl border-2 border-line px-2.5 text-[11px] font-extrabold text-soft disabled:opacity-60"
                          >
                            {v}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                )
                    ) : (
                      <div className="mt-2 text-[11px] text-faint">
                        Bootstrap secret - set via host environment variables only.
                      </div>
                    )}
                  </div>
                </div>
              );
            });
          })()}
        </div>
      )}

      {loaded && tab === "users" && (
        <div className="space-y-3">
          {/* Private-beta invite list (owner only) */}
          {isOwner && <BetaManager />}

          {/* Add management - OWNER ONLY (the API enforces it; this only
              stops the button offering an action that will be refused). */}
          {isOwner && (
          <div className="surface rounded-blob p-4">
            <div className="mb-2 text-[13px] font-extrabold text-strong">
              Add management user
            </div>
            <div className="flex gap-2">
              <input
                type="email"
                value={newAdmin}
                onChange={(e) => setNewAdmin(e.target.value)}
                placeholder="colleague@email.com"
                className="flex-1 rounded-xl border-2 border-line bg-card p-2.5 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
              />
              <button
                onClick={() => {
                  if (newAdmin.trim()) {
                    userAction({ email: newAdmin.trim(), action: "promote" });
                    setNewAdmin("");
                  }
                }}
                className="btn btn-primary btn-sm rounded-xl px-4 text-[12px]"
              >
                Promote
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-faint">
              Only the owner can add or remove admins. The owner can never be demoted.
            </p>
          </div>
          )}

          {userMsg && (
            <div className="rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
              {userMsg}
            </div>
          )}

          {/* Search + sort */}
          <div className="flex gap-2">
            <input
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Search email, phone, role..."
              className="flex-1 rounded-xl border-2 border-line bg-card p-2.5 text-[13px] text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            <select
              value={userSort}
              onChange={(e) => setUserSort(e.target.value as typeof userSort)}
              className="rounded-xl border-2 border-line bg-card p-2.5 text-[12px] font-bold text-strong"
            >
              <option value="new">Newest first</option>
              <option value="old">Oldest first</option>
              <option value="management">Management first</option>
            </select>
          </div>

          {users.length === 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No registered users found. If someone signed up but is missing
              here, Supabase is not connected - run Test Supabase in Keys.
            </div>
          )}
          {visibleUsers.length === 0 && users.length > 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No users match &quot;{userSearch}&quot;.
            </div>
          )}
          {visibleUsers.map((u) => (
            <div key={u.email} className="surface rounded-blob p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-extrabold text-strong">
                      {u.email}
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                        u.role === "owner"
                          ? "bg-brandyellow text-[#4a3300]"
                          : u.role === "admin"
                          ? "bg-brandblue text-white"
                          : "bg-card2 text-faint"
                      }`}
                    >
                      {u.role.toUpperCase()}
                    </span>
                    {u.plan && u.role === "user" && u.plan !== "free" && (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold text-white ${
                          u.plan === "ultra" || u.plan === "business" ? "badge-ultra" : "bg-brandblue"
                        }`}
                      >
                        {(u.plan === "business" ? "ultra" : u.plan).toUpperCase()}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-faint">
                    {u.phone ?? "no phone"} · {u.provider} · seen{" "}
                    {new Date(u.lastSeen).toLocaleString()}
                  </div>
                </div>
              </div>
              {u.role !== "owner" && (
                <div className="mt-2 flex gap-2">
                  {isOwner && (
                  <button
                    onClick={() =>
                      userAction({
                        email: u.email,
                        action: u.role === "admin" ? "demote" : "promote",
                      })
                    }
                    className="btn btn-sm chip flex-1 rounded-xl bg-brandblue-soft py-1.5 text-[12px] font-extrabold text-brandblue"
                  >
                    {u.role === "admin" ? "Remove admin" : "Make admin"}
                  </button>
                  )}
                  {/* Blocking an ADMIN is an owner action (the route enforces
                      it), and it is a real one now: a blocked admin's session
                      is refused on their next request. Hiding the button from a
                      peer admin keeps the panel from offering something that
                      will come back 403. */}
                  {(u.role !== "admin" || isOwner) && (
                  <button
                    onClick={() =>
                      userAction({
                        email: u.email,
                        status: u.status === "active" ? "blocked" : "active",
                      })
                    }
                    className={`btn btn-sm chip flex-1 rounded-xl py-1.5 text-[12px] font-extrabold ${
                      u.status === "active"
                        ? "bg-brandred-soft text-brandred"
                        : "bg-savings-soft text-savings"
                    }`}
                    title={
                      u.role === "admin"
                        ? "Blocks this admin immediately - their next request is refused, including the Key Vault"
                        : undefined
                    }
                  >
                    {u.status === "active" ? "Block" : "Unblock"}
                  </button>
                  )}
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          `Permanently erase ${u.email}? This deletes their account, data, and WhatsApp link. This cannot be undone.`
                        )
                      )
                        userAction({ email: u.email, action: "delete" });
                    }}
                    className="btn btn-sm chip rounded-xl border-2 border-brandred/40 px-3 py-1.5 text-[12px] font-extrabold text-brandred"
                    title="Permanently erase this user"
                  >
                    🗑 Erase
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loaded && tab === "data" && (
        <div className="space-y-3">
          <DegradedBanner degraded={dataDegraded} />
          <div className="surface rounded-blob p-4">
            <div className="text-[13px] font-extrabold text-strong">🗄 Data explorer</div>
            <p className="mb-2 text-[11px] text-faint">
              Every record the app stores. Read-only, newest first. Tap a table to view.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {dataTables.map((tbl) => (
                <button
                  key={tbl.name}
                  onClick={() => openDataTable(tbl.name)}
                  className={`btn btn-sm chip rounded-xl border-2 px-3 py-1.5 text-[11px] font-extrabold ${
                    dataTable === tbl.name ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
                  }`}
                >
                  {tbl.label} <span className="text-faint">({tbl.count})</span>
                </button>
              ))}
            </div>
          </div>

          {dataBusy && <SkeletonList count={3} />}

          {!dataBusy && dataTable && (
            <div className="surface rounded-blob p-4">
              <div className="mb-2 text-[13px] font-extrabold text-strong">
                {dataTables.find((t) => t.name === dataTable)?.label ?? dataTable}
                <span className="ml-2 text-[11px] font-bold text-faint">{dataRows.length} rows</span>
              </div>
              {dataRows.length === 0 ? (
                <p className="rounded-xl bg-card2 p-3 text-center text-[11px] font-bold text-faint">
                  No records yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {dataRows.map((row, i) => (
                    <details key={i} className="rounded-xl border-2 border-line p-2.5">
                      <summary className="cursor-pointer truncate text-[11px] font-bold text-soft">
                        {String(
                          (row as any).email ??
                            (row as any).vendor_name ??
                            (row as any).type ??
                            (row as any).event ??
                            (row as any).text ??
                            Object.values(row)[1] ??
                            `row ${i + 1}`
                        ).slice(0, 60)}
                      </summary>
                      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-card2 p-2 text-[10px] leading-relaxed text-soft">
                        {JSON.stringify(row, null, 2)}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {loaded && tab === "feedback" && (
        <div className="space-y-3">
          {/* Summary counts */}
          <div className="grid grid-cols-3 gap-2">
            <Metric
              label="High severity"
              value={String(feedbackRows.filter((f) => f.is_real_issue && f.severity === "high").length)}
              accent
            />
            <Metric label="Real issues" value={String(feedbackRows.filter((f) => f.is_real_issue).length)} />
            {/* Two different facts, named apart: how many exist, and how many
                are on screen right now. They used to be the same number by
                accident, which is how 100 could mean "all of them". */}
            <Metric
              label={feedbackTotal == null ? "Shown" : "Total"}
              value={feedbackTotal == null ? String(feedbackRows.length) : String(feedbackTotal)}
            />
          </div>
          {feedbackTotal != null && feedbackTotal > feedbackRows.length && (
            <div className="text-center text-[11px] font-bold text-faint">
              Showing {feedbackRows.length} of {feedbackTotal}
            </div>
          )}
          {/* Filter chips */}
          <div className="flex gap-1.5">
            {(["all", "high", "issues", "noise"] as const).map((fl) => (
              <button
                key={fl}
                onClick={() => setFeedbackFilter(fl)}
                className={`chip flex-1 rounded-xl border-2 py-1.5 text-[11px] font-extrabold capitalize ${
                  feedbackFilter === fl
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft"
                }`}
              >
                {fl}
              </button>
            ))}
          </div>
          {/* CATEGORY chips (W6.2). The category was stored and displayed but
              filtered nothing. Counts come from the whole table, so they stay
              true while the list itself is one page deep; picking one refetches
              server-side rather than filtering the page, or a busy category
              would be silently truncated by the 100-row window. */}
          {Object.keys(feedbackByCategory).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {[["", "all"] as const, ...Object.entries(feedbackByCategory)
                .sort((a, b) => b[1] - a[1])
                .map(([c, n]) => [c, `${c} ${n}`] as const)].map(([value, label]) => (
                <button
                  key={value || "all"}
                  onClick={() => {
                    setFeedbackCategory(value);
                    fetch(`/api/admin/feedback${value ? `?category=${encodeURIComponent(value)}` : ""}`)
                      .then((r) => r.json())
                      .then((d) => {
                        setFeedbackRows(d.feedback ?? []);
                        setFeedbackByCategory(d.byCategory ?? {});
                        // A new filter is a new list - carrying the old
                        // paging cursor over would append page 2 of the
                        // previous category onto page 1 of this one.
                        setFeedbackTotal(typeof d.total === "number" ? d.total : null);
                        setFeedbackNextOffset(Number(d.nextOffset) || 0);
                        setFeedbackHasMore(Boolean(d.hasMore));
                      })
                      .catch(() => {});
                  }}
                  className={`chip rounded-xl border-2 px-2.5 py-1 text-[10px] font-extrabold capitalize ${
                    feedbackCategory === value
                      ? "border-brandblue bg-brandblue-soft text-brandblue"
                      : "border-line text-soft"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {feedbackRows.length === 0 && (
            <div className="surface rounded-blob p-4 text-center text-[12px] text-faint">
              No feedback yet (or Supabase is not connected - run Test Supabase
              in Keys).
            </div>
          )}
          {feedbackRows
            .filter((f) =>
              feedbackFilter === "all"
                ? true
                : feedbackFilter === "high"
                ? f.is_real_issue && f.severity === "high"
                : feedbackFilter === "issues"
                ? f.is_real_issue
                : !f.is_real_issue
            )
            .map((f) => (
            <div key={f.id} className="surface rounded-blob p-3">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                    f.is_real_issue
                      ? f.severity === "high"
                        ? "bg-brandred text-white"
                        : "bg-brandyellow text-[#4a3300]"
                      : "bg-card2 text-faint"
                  }`}
                >
                  {f.is_real_issue ? (f.severity ?? "issue").toUpperCase() : "NOISE"}
                </span>
                <span className="text-[11px] font-bold capitalize text-soft">{f.category}</span>
                <span className="ml-auto text-[10px] text-faint">
                  {new Date(f.created_at).toLocaleString()}
                </span>
              </div>
              <div className="mt-1 text-[13px] font-extrabold text-strong">
                {f.summary || f.body.slice(0, 80)}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-soft">{f.body}</p>
              {(f.images?.length ?? 0) > 0 && (
                <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
                  {f.images!.map((src, i) => (
                    <a key={i} href={src} target="_blank" rel="noreferrer" className="shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt=""
                        className="h-24 w-24 rounded-xl border-2 border-line object-cover"
                      />
                    </a>
                  ))}
                  {/* CAPPED, NOT HIDDEN (W6.2). The inbox used to inline up to
                      200 base64 screenshots in one JSON response. The route
                      caps what it SENDS and reports the real count, so a
                      withheld screenshot says so instead of vanishing. */}
                  {f.image_count > (f.images?.length ?? 0) && (
                    <span className="flex h-24 shrink-0 items-center rounded-xl border-2 border-dashed border-line px-3 text-[10px] font-extrabold text-faint">
                      +{f.image_count - (f.images?.length ?? 0)} more
                      <br />
                      (not loaded)
                    </span>
                  )}
                </div>
              )}
              <div className="mt-1 text-[10px] text-faint">
                {f.reporter_email ?? "anonymous"}
                {f.image_count > 0 ? ` · ${f.image_count} screenshot(s)` : ""}
                {f.triage_reason ? ` · ${f.triage_reason}` : ""}
              </div>

              {/* Triage workflow: status chips + owner note (New#11) */}
              <div className="mt-2 flex flex-wrap gap-1">
                {(["open", "in-progress", "resolved", "dismissed"] as const).map((st) => {
                  const active = (f.status ?? "open") === st;
                  return (
                    <button
                      key={st}
                      onClick={async () => {
                        // AdminReplyThread's lesson, applied to its neighbours:
                        // paint only what the server confirmed landed.
                        const res = await fetch("/api/admin/feedback", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ id: f.id, status: st }),
                        }).catch(() => null);
                        if (!res?.ok) {
                          alert("The status change did NOT save - try again.");
                          return;
                        }
                        setFeedbackRows((rows) =>
                          rows.map((r) => (r.id === f.id ? { ...r, status: st } : r))
                        );
                      }}
                      className={`chip rounded-lg border-2 px-2 py-0.5 text-[10px] font-extrabold capitalize ${
                        active
                          ? st === "resolved"
                            ? "border-savings bg-savings-soft text-savings"
                            : st === "dismissed"
                            ? "border-line bg-card2 text-faint"
                            : st === "in-progress"
                            ? "border-brandyellow bg-brandyellow-soft text-warn"
                            : "border-brandblue bg-brandblue-soft text-brandblue"
                          : "border-line text-faint"
                      }`}
                    >
                      {st}
                    </button>
                  );
                })}
              </div>
              <textarea
                rows={1}
                defaultValue={f.owner_note ?? ""}
                placeholder="Add an owner note (what you'll do about it)..."
                onBlur={async (e) => {
                  const note = e.target.value.trim();
                  if (note !== (f.owner_note ?? "")) {
                    const res = await fetch("/api/admin/feedback", {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ id: f.id, note }),
                    }).catch(() => null);
                    if (!res?.ok) {
                      alert("The note did NOT save - it is shown in the box but not stored.");
                      return;
                    }
                    setFeedbackRows((rows) =>
                      rows.map((r) => (r.id === f.id ? { ...r, owner_note: note } : r))
                    );
                  }
                }}
                className="mt-1.5 w-full rounded-lg border-2 border-line bg-card p-1.5 text-[11px] text-strong focus:border-brandblue focus:outline-none"
              />
              {/* User-visible reply thread (distinct from the internal note
                  above): what the reporter reads and can answer in Your reports. */}
              <AdminReplyThread
                report={f}
                onReplied={(reply) =>
                  setFeedbackRows((rows) =>
                    rows.map((r) =>
                      r.id === f.id ? { ...r, replies: [...(r.replies ?? []), reply] } : r
                    )
                  )
                }
              />
              {/* Delete this report for good (spam / resolved noise) */}
              <div className="mt-1.5 flex justify-end">
                <button
                  onClick={async () => {
                    if (!confirm("Delete this feedback permanently? This cannot be undone.")) return;
                    const res = await fetch(`/api/admin/feedback?id=${f.id}`, { method: "DELETE" });
                    if (res.ok) {
                      setFeedbackRows((rows) => rows.filter((r) => r.id !== f.id));
                    }
                  }}
                  className="btn btn-sm rounded-lg border-2 border-line px-2.5 py-0.5 text-[10px] font-extrabold text-brandred hover:bg-brandred-soft"
                >
                  🗑 Delete
                </button>
              </div>
            </div>
          ))}
          {/* THE REST OF THEM. Without this the 101st report was unreachable
              through any UI - the list stopped at the route's page cap and the
              category chips were capped with it. */}
          {feedbackHasMore && (
            <button
              onClick={async () => {
                setFeedbackLoadingMore(true);
                try {
                  const q = new URLSearchParams({ offset: String(feedbackNextOffset) });
                  if (feedbackCategory) q.set("category", feedbackCategory);
                  const d = await fetch(`/api/admin/feedback?${q.toString()}`).then((r) => r.json());
                  // Append, never replace - the reader keeps their place.
                  setFeedbackRows((rows) => [...rows, ...(d.feedback ?? [])]);
                  setFeedbackNextOffset(Number(d.nextOffset) || 0);
                  setFeedbackHasMore(Boolean(d.hasMore));
                } catch {
                  /* leave the button so it can simply be pressed again */
                } finally {
                  setFeedbackLoadingMore(false);
                }
              }}
              disabled={feedbackLoadingMore}
              className="btn w-full rounded-2xl border-2 border-line py-2 text-[12px] font-extrabold text-strong disabled:opacity-60"
            >
              {feedbackLoadingMore ? (
                <LoadingDots label="Loading more feedback" />
              ) : (
                `Load more${feedbackTotal != null ? ` (${feedbackTotal - feedbackRows.length} left)` : ""}`
              )}
            </button>
          )}
        </div>
      )}

      {loaded && tab === "billing" && (
        <div className="space-y-3">
          <div
            className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${
              billingOn
                ? "border-savings bg-savings-soft text-savings"
                : "border-brandyellow bg-brandyellow-soft text-warn"
            }`}
          >
            <Icon name="card" className="mr-1 inline h-4 w-4" />
            {billingOn
              ? "Payments are connected. Users see the 80% launch offer (billed every 3 months) via the upgrade chip and at signup."
              : "Billing preview. Connect PayPal (no merchant-approval gate, $0/month, pays out to Israeli bank accounts) - add the PAYPAL_* keys in the Keys tab."}
          </div>
          {plans.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-16 sm:max-w-lg md:max-w-2xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-2xl">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <div>
              <h1 className="font-display text-lg font-extrabold leading-none text-strong">
                Management
              </h1>
              <p className="text-[10px] font-bold text-faint">WheelDeal workspace</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <ThemeToggle />
            <LanguageButton />
            <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
              ← App
            </a>
          </div>
        </div>
      </div>
      <div className="rise-in px-4 pt-4">{children}</div>
    </main>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="surface rounded-blob p-4 text-center">
      <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">{label}</div>
      <div className={`mt-1 text-xl font-extrabold ${accent ? "text-brandblue" : "text-strong"}`}>
        {value}
      </div>
    </div>
  );
}

// Compact label/value stat used in the Intel expandable detail grid.
function Stat({
  label,
  value,
  good,
  bad,
}: {
  label: string;
  value: string;
  good?: boolean;
  bad?: boolean;
}) {
  return (
    <div className="rounded-lg bg-card p-1.5">
      <div className="text-[8px] font-bold uppercase tracking-wide text-faint">{label}</div>
      <div
        className={`text-[11px] font-extrabold ${
          good ? "text-savings" : bad ? "text-brandred" : "text-strong"
        }`}
      >
        {value}
      </div>
    </div>
  );
}


// FAQ manager (#18): owner adds popular questions (AI-written or typed) and
// removes them. Travellers see them as an expandable section in the app.
function FaqManager() {
  const [items, setItems] = useState<{ id: string; q: string; a: string }[]>([]);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const d = await (await fetch("/api/faq")).json();
    setItems(d.items ?? []);
  }
  useEffect(() => {
    load();
  }, []);

  async function add(generate: boolean) {
    if (!q.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const d = await (
        await fetch("/api/faq", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: q.trim(), answer: a.trim(), generate }),
        })
      ).json();
      if (d.items) {
        setItems(d.items);
        setQ("");
        setA("");
      } else setMsg(d.error ?? "Could not add.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const d = await (await fetch(`/api/faq?id=${id}`, { method: "DELETE" })).json();
    if (d.items) setItems(d.items);
  }

  return (
    <div className="surface rounded-blob p-4">
      <div className="mb-1 text-[13px] font-extrabold text-strong">💬 Popular questions</div>
      <p className="mb-2 text-[11px] text-faint">
        Shown to travellers on the home screen. Add a question and either write the
        answer or let the AI write it. Remove any at any time.
      </p>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Question, e.g. Do I need an international licence?"
        className="mb-1.5 w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
      />
      <textarea
        value={a}
        onChange={(e) => setA(e.target.value)}
        rows={2}
        placeholder="Answer (leave empty and tap 'AI write' to generate one)"
        className="mb-1.5 w-full rounded-xl border-2 border-line bg-card p-2 text-[12px] text-strong focus:border-brandblue focus:outline-none"
      />
      {msg && <p className="mb-1.5 text-[11px] font-bold text-brandred">{msg}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => add(false)}
          disabled={busy || !q.trim() || !a.trim()}
          className="btn btn-primary btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-50"
        >
          {busy ? <LoadingDots light /> : "Add"}
        </button>
        <button
          onClick={() => add(true)}
          disabled={busy || !q.trim()}
          className="btn btn-sm flex-1 rounded-xl border-2 border-line text-[12px] font-extrabold text-brandblue disabled:opacity-50"
        >
          🤖 AI write
        </button>
      </div>
      <div className="mt-3 space-y-1.5">
        {items.map((it) => (
          <div key={it.id} className="rounded-xl bg-card2 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="text-[12px] font-bold text-strong">{it.q}</div>
              <button onClick={() => remove(it.id)} className="shrink-0 text-[11px] font-bold text-brandred">
                Remove
              </button>
            </div>
            <div className="mt-0.5 text-[11px] text-soft">{it.a}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Private-beta invite manager (owner only). Paste the tester emails with a
// plan each; the app blocks everyone else at login. Stored in Supabase config,
// applied instantly with no redeploy. The ceiling is served by the route
// (BETA_ALLOWLIST_MAX) rather than written here - the two used to be separate
// literals, so raising one left the panel confidently quoting the other.
function BetaManager() {
  const [text, setText] = useState("");
  const [counts, setCounts] = useState<{ total: number; free: number; pro: number; ultra: number } | null>(null);
  const [max, setMax] = useState<number | null>(null);
  const [lock, setLock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testMode, setTestMode] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  async function load() {
    const d = await (await fetch("/api/admin/beta")).json();
    setLock(Boolean(d.lockEnabled));
    setCounts(d.counts ?? null);
    setMax(typeof d.max === "number" ? d.max : null);
    setText(
      (d.entries ?? [])
        .map(
          (e: { email: string; plan: string; test?: boolean }) =>
            `${e.email}, ${e.plan}${e.test ? ", test" : ""}`
        )
        .join("\n")
    );
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((p) => setTestMode(Boolean(p.testMode)))
      .catch(() => {});
  }
  useEffect(() => {
    load();
  }, []);

  async function toggleTestMode() {
    setTestBusy(true);
    setMsg(null);
    // A money-affecting switch may not paint optimistically: verify the write,
    // then repaint from the EFFECTIVE value the public config actually serves -
    // never from the assumption that the flip landed.
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TEST_MODE", value: testMode ? "off" : "on" }),
      });
      const data = await res.json().catch(() => ({}) as { error?: string; warning?: string });
      if (!res.ok || data.error) {
        setMsg(data.error ?? "Test Mode did NOT change - the write failed.");
      } else if (data.warning) {
        setMsg(data.warning);
      }
      const p = await fetch("/api/config/public").then((r) => r.json()).catch(() => null);
      if (p) setTestMode(Boolean(p.testMode));
    } catch {
      setMsg("Could not reach the server - Test Mode is UNCHANGED.");
    } finally {
      setTestBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const entries = text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [email, plan, flag] = line.split(/[,:|]/).map((x) => x.trim());
        return {
          email: (email ?? "").toLowerCase(),
          plan: (plan ?? "free").toLowerCase(),
          test: (flag ?? "").toLowerCase() === "test",
        };
      })
      .filter((e) => e.email.includes("@"));
    try {
      const d = await (
        await fetch("/api/admin/beta", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries }),
        })
      ).json();
      if (d.entries) {
        setMsg(
          d.note
            ? d.note
            : `Saved - ${d.entries.length} account(s) can log in (incl. you).`
        );
        await load();
      } else setMsg(d.error ?? "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface rounded-blob border-2 !border-brandblue p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-extrabold text-strong">🔒 Private beta - invite list</div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-extrabold ${
            lock ? "bg-savings-soft text-savings" : "bg-brandred-soft text-brandred"
          }`}
        >
          {lock ? "LOCK ON" : "LOCK OFF"}
        </span>
      </div>
      <p className="mb-2 text-[11px] text-faint">
        Only these accounts (plus you) can log in - everyone else is blocked at the
        door. One per line: <span className="font-mono">email, plan</span> where plan
        is free / pro / ultra - append <span className="font-mono">, test</span> to
        make someone a TEST USER. Up to {max ?? "-"} testers
        {counts ? ` (${counts.total} on the list now)` : ""}. Applies instantly, no
        redeploy. Being invited is not a linked WhatsApp socket - Evolution host
        capacity is enforced separately at link time.
      </p>
      {/* Global Test Mode switch: test users ride Ultra free + sandbox billing */}
      <div className="mb-2 flex items-center justify-between rounded-xl bg-card2 p-2.5">
        <div>
          <div className="text-[12px] font-extrabold text-strong">🧪 Test Mode</div>
          <div className="text-[10px] text-faint">
            ON: testers marked &quot;test&quot; get Ultra free, checkout applies plans
            instantly (no charge), a banner shows app-wide. OFF: fully live.
          </div>
        </div>
        <button
          onClick={toggleTestMode}
          disabled={testBusy}
          className={`btn btn-sm rounded-full px-4 py-1.5 text-[11px] font-extrabold disabled:opacity-50 ${
            testMode ? "bg-brandyellow text-[#4a3300]" : "btn-ghost border border-line"
          }`}
        >
          {testBusy ? "..." : testMode ? "ON - go live" : "OFF - enable"}
        </button>
      </div>
      {counts && (
        <div className="mb-2 flex flex-wrap gap-1.5 text-[10px] font-bold">
          <span className="rounded-full bg-card2 px-2 py-0.5 text-faint">{counts.total} total</span>
          <span className="rounded-full bg-card2 px-2 py-0.5 text-faint">{counts.free} free</span>
          <span className="rounded-full bg-card2 px-2 py-0.5 text-brandblue">{counts.pro} pro</span>
          <span className="rounded-full bg-card2 px-2 py-0.5 text-savings">{counts.ultra} ultra</span>
        </div>
      )}
      <textarea
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"tester1@gmail.com, free\ntester2@gmail.com, pro\ntester3@gmail.com, ultra"}
        className="w-full rounded-xl border-2 border-line bg-card p-2 font-mono text-[12px] text-strong focus:border-brandblue focus:outline-none"
      />
      {msg && <p className="mt-1.5 text-[11px] font-bold text-savings">{msg}</p>}
      <button
        onClick={save}
        disabled={busy}
        className="btn btn-primary mt-2 w-full rounded-xl py-2.5 text-[13px] disabled:opacity-60"
      >
        {busy ? <LoadingDots light /> : "Save invite list"}
      </button>
      {!lock && (
        <p className="mt-1.5 text-[10px] font-bold text-brandred">
          Lock is OFF (BETA_LOCK=off) - anyone can sign up. To enforce this list,
          set the repo variable BETA_LOCK=on under Settings, Secrets and variables,
          Actions, Variables, so it survives every deploy; a Cloud Run console
          value is wiped on the next push.
        </p>
      )}
    </div>
  );
}
