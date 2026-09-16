"use client";

// Will's client half: sends the traveller's words + a compact context
// snapshot to /api/will, then executes the returned typed command against
// the page's EXISTING setters (the bridge). Transcript + standing notes ride
// in sessionStorage("wd_will") so a Profile round-trip loses nothing.

import { useCallback, useEffect, useRef, useState } from "react";
import type { WillCommand, WillContext } from "./will-commands";
import { pickVariant } from "./will-variants";
import { rememberSession } from "@/lib/cookies/client";

export interface WillMsg {
  role: "user" | "will";
  text: string;
  receipt?: string; // short pill describing an executed command
  /**
   * The owner has Will's ACTING half switched off (WILL_ACTIONS). The message
   * is real guidance - it names the control to use - and it is flagged so the
   * bubble can say "under development" instead of reading like a refusal.
   */
  underDevelopment?: boolean;
  at: number;
}

export interface WillBridge {
  getContext(): WillContext;
  setRadius(km: number): void;
  patchFilters(patch: Record<string, unknown>): void;
  setBudget(v: number | null): void;
  startSearch(text?: string): void;
  clearSearch(): void; // opens the existing confirm modal
  pause(): Promise<void>;
  resume(): Promise<void>;
  massBargain(): void;
  openVendor(id: string): void;
  compare(ids: string[]): void;
  openFeedback(): void; // opens the feedback modal on the hosting page
}

const STORE_KEY = "wd_will";

interface Stored {
  messages: WillMsg[];
  notes: string[];
}

function load(): Stored {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        messages: Array.isArray(p.messages) ? p.messages.slice(-40) : [],
        notes: Array.isArray(p.notes) ? p.notes.slice(-10) : [],
      };
    }
  } catch {}
  return { messages: [], notes: [] };
}

export function useWill(bridge: WillBridge) {
  const [messages, setMessages] = useState<WillMsg[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  useEffect(() => {
    const s = load();
    setMessages(s.messages);
    setNotes(s.notes);
  }, []);

  useEffect(() => {
    // `preferences` category. Without it Will still answers - the thread just
    // does not survive a page hop within the visit.
    rememberSession(STORE_KEY, JSON.stringify({ messages: messages.slice(-40), notes }));
  }, [messages, notes]);

  const receiptFor = (cmd: WillCommand): string | undefined => {
    switch (cmd.action) {
      case "set_radius":
        return `Radius → ${cmd.km} km`;
      case "set_budget":
        return cmd.maxPricePerDay ? `Budget → ${cmd.maxPricePerDay}/day` : "Budget cleared";
      case "set_filter":
        return cmd.label ?? "Filters updated";
      case "pause_session":
        return "Session paused";
      case "resume_session":
        return "Session resumed";
      case "mass_bargain":
        return "Mass bargain fired";
      case "compare":
        return "Comparing offers";
      case "start_search":
        return "New search";
      case "clear_search":
        return "Clear requested";
      case "remember":
        return "Noted";
      case "open_deals":
        return "Opening My deals";
      case "open_pricing":
        return "Opening plans";
      case "open_feedback":
        return "Opening feedback";
      default:
        return undefined;
    }
  };

  const execute = useCallback(async (cmd: WillCommand) => {
    const b = bridgeRef.current;
    switch (cmd.action) {
      case "set_radius":
        b.setRadius(cmd.km);
        break;
      case "set_filter":
        b.patchFilters(cmd.patch as Record<string, unknown>);
        break;
      case "set_budget":
        b.setBudget(cmd.maxPricePerDay);
        break;
      case "start_search":
        b.startSearch(cmd.text);
        break;
      case "clear_search":
        b.clearSearch(); // routed through the existing confirm dialog - never silent
        break;
      case "pause_session":
        await b.pause();
        break;
      case "resume_session":
        await b.resume();
        break;
      case "mass_bargain":
        b.massBargain();
        break;
      case "open_vendor":
        b.openVendor(cmd.vendorId);
        break;
      case "compare":
        b.compare(cmd.vendorIds);
        break;
      case "remember":
        setNotes((n) => [...n.slice(-9), cmd.note]);
        break;
      case "open_deals":
        window.location.href = "/deals";
        break;
      case "open_pricing":
        window.location.href = "/pricing";
        break;
      case "open_feedback":
        b.openFeedback();
        break;
      case "help":
      case "answer":
      case "clarify":
        break; // pure speech
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setMessages((m) => [...m, { role: "user", text: trimmed, at: Date.now() }]);
      try {
        const context = { ...bridgeRef.current.getContext(), notes };
        const history = messages.slice(-8).map((m) => ({
          role: m.role === "will" ? ("assistant" as const) : ("user" as const),
          content: m.text,
        }));
        const res = await fetch("/api/will", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, context, history }),
        });
        const d = await res.json();
        if (d?.command) {
          // WHEN ACTIONS ARE OFF the server has already turned the command into
          // an `answer` carrying directions, so executing it is a no-op by
          // construction - there is no path where the UI acts on something the
          // switch was meant to stop.
          await execute(d.command as WillCommand);
          setMessages((m) => [
            ...m,
            {
              role: "will",
              text: String(d.say ?? "Done."),
              receipt: d?.underDevelopment
                ? undefined
                : receiptFor(d.command as WillCommand),
              underDevelopment: Boolean(d?.underDevelopment),
              at: Date.now(),
            },
          ]);
        } else {
          setMessages((m) => [
            ...m,
            { role: "will", text: d?.error ?? pickVariant("hiccup"), at: Date.now() },
          ]);
        }
      } catch {
        setMessages((m) => [
          ...m,
          { role: "will", text: pickVariant("reconnect"), at: Date.now() },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [busy, messages, notes, execute]
  );

  const reset = useCallback(() => {
    setMessages([]);
    setNotes([]);
    try {
      sessionStorage.removeItem(STORE_KEY);
    } catch {}
  }, []);

  return { messages, notes, busy, send, reset };
}
