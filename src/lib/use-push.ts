"use client";

// Reusable browser-push controller for a real on/off toggle. Server truth (a row
// in push_subscriptions) is authoritative; localStorage is only a hint. Used by
// the Profile "Alerts" section. The funnel keeps its own inline opt-in flow.

import { useCallback, useEffect, useState } from "react";
import { rememberLocal } from "@/lib/cookies/client";

export type PushState =
  | "loading"
  | "unconfigured" // server has no VAPID keys
  | "unsupported" // browser can't do push
  | "ios-install" // iOS Safari not installed to Home Screen
  | "off"
  | "on"
  // SERVER SAYS YES, THIS PHONE SAYS NO. The subscribe endpoint answers with an
  // ACCOUNT-WIDE truth (any row, any device), so a traveller who had enabled
  // alerts on a laptop saw a confident "Alerts on" while THIS phone had no
  // PushSubscription at all and could never receive anything. That is the field
  // failure - "Alerts on", zero pushes - and it needs its own state, not a lie.
  | "on-elsewhere"
  // This device HAS a subscription, but the server does not know it (the row
  // was pruned after a VAPID rotation, or the save failed). One tap re-registers.
  | "stale"
  | "busy"
  | "denied"
  | "error";

/**
 * iPadOS 13+ REPORTS ITSELF AS A MAC. `/iphone|ipad|ipod/` therefore misses
 * every modern iPad, so an iPad user who had not installed the app to the Home
 * Screen (where push is possible) was told "your browser cannot do push" -
 * final, and wrong. Touch points are the standard discriminator: a Macintosh
 * UA with a touchscreen is an iPad.
 */
function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface UsePushAlerts {
  state: PushState;
  devices: number;
  note: string | null;
  enable: () => Promise<void>;
  /** Disable on THIS device only (the endpoint we hold), not every device. */
  disable: () => Promise<void>;
  /** Explicitly drop every device on the account. */
  disableEverywhere: () => Promise<void>;
  /** Send a real push to this account and report what actually happened. */
  test: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePushAlerts(): UsePushAlerts {
  const [state, setState] = useState<PushState>("loading");
  const [devices, setDevices] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const supported = () =>
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
  const standalone = () =>
    typeof window !== "undefined" &&
    ((window.navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true);

  const refresh = useCallback(async () => {
    try {
      const d = await (await fetch("/api/push/subscribe")).json();
      setDevices(Number(d?.devices ?? 0));
      if (!d?.configured) {
        setState("unconfigured");
        return;
      }
      if (!supported()) {
        setState(isIOS() && !standalone() ? "ios-install" : "unsupported");
        return;
      }
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        setState("denied");
        return;
      }
      // DEVICE TRUTH. Ask the browser what THIS device actually holds and
      // reconcile it with the server's account-wide answer - the whole reason
      // "Alerts on" could be true while nothing could ever arrive here.
      let mine: PushSubscription | null = null;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        mine = (await reg?.pushManager.getSubscription()) ?? null;
      } catch {
        /* treat an unreadable registration as "no subscription here" */
      }
      const serverOn = Boolean(d?.on);
      const knownHere =
        Boolean(mine) &&
        Array.isArray(d?.endpoints) &&
        (d.endpoints as string[]).includes(mine!.endpoint);
      if (mine && !knownHere) setState("stale");
      else if (!mine && serverOn) setState("on-elsewhere");
      else setState(serverOn && mine ? "on" : "off");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    setNote(null);
    if (!supported()) {
      setState(isIOS() && !standalone() ? "ios-install" : "unsupported");
      return;
    }
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState("denied");
        return;
      }
      const vapid = await (await fetch("/api/push/vapid")).json();
      if (!vapid?.key) {
        setState("unconfigured");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const key = urlBase64ToUint8Array(vapid.key) as BufferSource;
      let sub: PushSubscription;
      try {
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch (e) {
        // AFTER A VAPID ROTATION the browser refuses to re-subscribe with a
        // different applicationServerKey (InvalidStateError) while the old
        // subscription still exists - so "Fix alerts on this phone" failed
        // forever with no way out but clearing site data. Drop the stale one
        // and take the new key.
        const old = await reg.pushManager.getSubscription();
        if (!old) throw e;
        await old.unsubscribe().catch(() => {});
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setState("error");
        setNote("Couldn't save your alert subscription - try again.");
        return;
      }
      // `preferences` category. The SUBSCRIPTION is server-side and unaffected
      // - this only mirrors it so the button shows the right state instantly.
      rememberLocal("wd_push_on", "1");
      await refresh();
    } catch {
      setState("error");
      setNote("Something interrupted turning on alerts - try again.");
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    setNote(null);
    setState("busy");
    try {
      // THIS DEVICE, not the account. "Turn alerts off" on a phone used to
      // delete EVERY registered device - a traveller silencing their phone in
      // a meeting also silenced the tablet they were watching offers on.
      let endpoint: string | undefined;
      if (supported()) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        endpoint = sub?.endpoint;
        await sub?.unsubscribe().catch(() => {});
      }
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(endpoint ? { endpoint } : {}),
      });
      try {
        localStorage.removeItem("wd_push_on");
      } catch {}
      await refresh();
    } catch {
      setState("error");
      setNote("Couldn't turn alerts off - try again.");
    }
  }, [refresh]);

  /** Explicitly drop EVERY device on the account (the old disable behaviour,
   *  now something the traveller asks for rather than a side effect). */
  const disableEverywhere = useCallback(async () => {
    setNote(null);
    setState("busy");
    try {
      if (supported()) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        await sub?.unsubscribe().catch(() => {});
      }
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      try {
        localStorage.removeItem("wd_push_on");
      } catch {}
      await refresh();
    } catch {
      setState("error");
      setNote("Couldn't turn alerts off everywhere - try again.");
    }
  }, [refresh]);

  /** PROVE IT. A real push to this account, reporting what actually happened
   *  per device - the only way to tell "configured" from "arriving". */
  const test = useCallback(async () => {
    setNote(null);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (d?.reason === "vapid-unconfigured") setNote("Push is not configured on the server yet.");
      else if (d?.reason === "no-subscriptions") setNote("No device is registered for alerts yet.");
      else if (!d?.delivered) {
        setNote(
          `Nothing was accepted (${d?.attempted ?? 0} device${d?.attempted === 1 ? "" : "s"} tried). Tap "Fix alerts on this phone".`
        );
      } else {
        setNote(
          `Sent to ${d.delivered} of ${d.attempted} device${d.attempted === 1 ? "" : "s"}${d.pruned ? ` - removed ${d.pruned} dead one${d.pruned === 1 ? "" : "s"}` : ""}.`
        );
      }
      await refresh();
    } catch {
      setNote("Could not send a test alert just now.");
    }
  }, [refresh]);

  return { state, devices, note, enable, disable, disableEverywhere, test, refresh };
}
