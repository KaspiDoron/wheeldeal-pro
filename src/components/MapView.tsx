"use client";

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { lockBodyScroll } from "@/lib/scroll-lock";
import {
  MapContainer,
  TileLayer,
  Marker,
  Circle,
  useMap,
} from "react-leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Vendor } from "@/lib/types";
import { Icon } from "./icons";
import { stageCaption, StageBadge } from "./Tracker";
import { ShopAvatar } from "./ShopAvatar";
import { ShopPhoto } from "./ShopPhoto";
import { moneyLocal } from "@/lib/currency";
import { useI18n } from "@/lib/i18n";
import { useAppTheme } from "@/lib/client/theme";
import { OSM_TILES, tilesForTheme, type MapTiles } from "@/lib/map-tiles";
import { loadPublicConfig } from "@/lib/client/public-config";

// Google-Maps-style map: Voyager cartography, price-bubble pins, and a
// booking.com-style swipeable shop list along the bottom (in BOTH the compact
// and fullscreen views). Zoom controls sit on the right edge, clear of the
// card strip.

function pinColor(v: Vendor): string {
  switch (v.stage) {
    case "offer-received":
      return "#16a34a";
    case "negotiating":
      return "#ef4444";
    case "awaiting-response":
      return "#e79b00";
    case "no-response":
    case "declined":
      return "#9aa3b2";
    default:
      return "#2f6fed";
  }
}

function priceIcon(v: Vendor, selected: boolean): L.DivIcon {
  const color = pinColor(v);
  // A shop offering a CHOICE has no single price. Prefix "from" and use the
  // cheapest tier rather than asserting a number the traveller has not picked.
  const opts = v.offer?.options;
  const label = v.offer
    ? opts && opts.length >= 2
      ? `from ${moneyLocal(Math.min(...opts.map((o) => o.pricePerDay)), v.offer.currency)}`
      : moneyLocal(v.offer.pricePerDay, v.offer.currency)
    : v.rating
    ? `★${v.rating.toFixed(1)}`
    : "🛵";
  const scale = selected ? 1.18 : 1;
  const ring = selected
    ? `<span style="position:absolute;left:50%;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:999px;background:${color};animation:ping-ring 1.6s cubic-bezier(0,0,0.2,1) infinite;z-index:-1"></span>`
    : "";
  const z = selected ? 1000 : 400;
  // A properly-sized icon so every pin sits exactly on its own coordinate
  // (a 0x0 icon can make markers visually clump together).
  return L.divIcon({
    className: "wd-pin",
    html: `
      <div style="position:relative;z-index:${z};transform:scale(${scale});transform-origin:bottom center;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.35))">
        ${ring}
        <div style="background:${color};color:#fff;font:800 12px/1 Nunito,system-ui;padding:6px 10px;border-radius:999px;border:2px solid #fff;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.2)">${label}</div>
        <div style="width:0;height:0;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid ${color};margin-top:-1px"></div>
      </div>`,
    iconSize: [70, 44],
    iconAnchor: [35, 44],
  });
}

const stayIcon = L.divIcon({
  className: "",
  html: `
    <div style="display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.35))">
      <div style="background:#ef4444;border:3px solid #fff;border-radius:999px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px">🏨</div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:7px solid #ef4444;margin-top:-1px"></div>
    </div>`,
  iconSize: [24, 31],
  iconAnchor: [12, 31],
});

function Controls({ origin }: { origin: { lat: number; lng: number } }) {
  const map = useMap();
  const btn =
    "flex h-10 w-10 items-center justify-center rounded-xl bg-card text-strong shadow-lg text-lg font-extrabold btn btn-sm lift";
  // Right edge, vertically centred - never overlapped by the bottom card strip.
  return (
    <div className="absolute right-3 top-1/2 z-[500] flex -translate-y-1/2 flex-col gap-2">
      <button className={btn} onClick={() => map.zoomIn()} aria-label="Zoom in">+</button>
      <button className={btn} onClick={() => map.zoomOut()} aria-label="Zoom out">−</button>
      <button
        className={btn}
        aria-label="My location"
        onClick={() => {
          navigator.geolocation?.getCurrentPosition(
            (pos) => map.setView([pos.coords.latitude, pos.coords.longitude], 15),
            () => map.setView([origin.lat, origin.lng], 14)
          );
        }}
      >
        ◎
      </button>
    </div>
  );
}

function Recenter({
  origin,
  radiusKm,
  vendors,
  focus,
}: {
  origin: { lat: number; lng: number };
  radiusKm: number;
  vendors: Vendor[];
  focus: { lat: number; lng: number } | null;
}) {
  const map = useMap();
  useEffect(() => {
    // Fit to the actual shop spread so pins never visually clump at one spot.
    const pts: [number, number][] = vendors.map((v) => [v.lat, v.lng]);
    pts.push([origin.lat, origin.lng]);
    if (pts.length > 1) {
      map.fitBounds(pts as any, { padding: [50, 50], maxZoom: 15 });
    } else {
      const dLat = radiusKm / 111;
      map.fitBounds([
        [origin.lat - dLat, origin.lng - dLat],
        [origin.lat + dLat, origin.lng + dLat],
      ]);
    }
    setTimeout(() => map.invalidateSize(), 250);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin.lat, origin.lng, radiusKm, vendors.length, map]);
  useEffect(() => {
    if (focus) map.setView([focus.lat, focus.lng], Math.max(map.getZoom(), 15), { animate: true });
  }, [focus, map]);
  return null;
}

// One card design, used in both the compact and fullscreen strips.
function ShopCard({
  v,
  selected,
  onSelect,
  onOpen,
}: {
  v: Vendor;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  // The shop's last line + its English gloss (W1.5: the gloss is visible
  // everywhere). Data the card already holds - one small line, no new fetch.
  const lastLine = v.lastInboundText || v.offer?.message || "";
  const lastLineEnglish = v.lastInboundText ? v.lastInboundEnglish : v.offer?.messageEnglish;
  return (
    <div
      onClick={onSelect}
      className={`surface-strong pop-in w-[78vw] max-w-xs shrink-0 snap-center overflow-hidden rounded-blob text-left transition ${
        selected ? "ring-2 ring-brandblue" : ""
      }`}
    >
      {v.photoUrl && <ShopPhoto src={v.photoUrl} className="h-24 w-full" />}
      <div className="p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" retryKey={v.stage} photoUrl={v.photoUrl} />
            <span className="truncate text-[14px] font-extrabold text-strong">{v.name}</span>
          </span>
          <span className="shrink-0 text-[14px] font-extrabold text-strong">
            {v.offer
              ? v.offer.options && v.offer.options.length >= 2
                ? `from ${moneyLocal(
                    Math.min(...v.offer.options.map((o) => o.pricePerDay)),
                    v.offer.currency
                  )}/d`
                : `${moneyLocal(v.offer.pricePerDay, v.offer.currency)}/d`
              : ""}
          </span>
        </div>
        {/* There is no room for three buttons on a 78vw card - say a choice
            exists and let "View details" carry them to it. */}
        {v.offer?.options && v.offer.options.length >= 2 && (
          <div className="mt-1 inline-block rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
            🛵 {v.offer.options.length} options
          </div>
        )}
        {v.stage && v.stage !== "queued" && (
          <div className="mt-1">
            <StageBadge stage={v.stage} />
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-soft">
          <span className="inline-flex items-center gap-0.5">
            <Icon name="star" className="h-3 w-3 text-brandyellow" />
            {v.rating ? v.rating.toFixed(1) : "New"} ({v.reviews})
          </span>
          <span>{v.distanceKm?.toFixed(1)} km</span>
          {v.openNow !== undefined && (
            <span className={v.openNow ? "font-bold text-savings" : "font-bold text-brandred"}>
              {v.openNow ? t("Open now") : t("Closed")}
            </span>
          )}
        </div>
        {v.todayHours && (
          <div className="mt-0.5 truncate text-[10px] font-bold text-faint">🕒 {v.todayHours}</div>
        )}
        {v.address && <div className="truncate text-[10px] text-faint">{v.address}</div>}
        {lastLine && (
          <div className="mt-1 rounded-lg bg-card2 px-1.5 py-1 text-[10px] text-soft">
            <div className="truncate">💬 {lastLine}</div>
            {lastLineEnglish && lastLineEnglish.trim() !== lastLine.trim() && (
              <div className="truncate italic text-faint">🌐 {lastLineEnglish}</div>
            )}
          </div>
        )}
        <div className="mt-1">
          {(v.orders ?? 0) > 0 ? (
            <span className="rounded-md bg-savings-soft px-1.5 py-0.5 text-[9px] font-extrabold text-savings">
              ✓ {v.orders} {t("booked here")}
            </span>
          ) : (
            <span className="rounded-md bg-brandblue-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandblue">
              ✨ {t("New on WheelDeal")}
            </span>
          )}
        </div>
        {v.stage && v.stage !== "offer-received" && v.stage !== "queued" && (
          <div className="mt-1.5 flex items-start gap-1 rounded-lg bg-card2 p-1.5 text-[10px] font-bold text-soft">
            <span className="shrink-0">{stageCaption(v.stage).emoji}</span>
            <span className="leading-snug">{t(stageCaption(v.stage).text)}</span>
          </div>
        )}
        {onOpen && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="btn btn-sm mt-2 flex w-full items-center justify-center rounded-xl bg-brandblue py-1.5 text-center text-[12px] font-extrabold text-white"
          >
            {t("View details")}
          </button>
        )}
      </div>
    </div>
  );
}

export default function MapView({
  origin,
  radiusKm,
  vendors,
  selectedId,
  onSelect,
  onOpenVendor,
}: {
  origin: { lat: number; lng: number };
  radiusKm: number;
  vendors: Vendor[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenVendor?: (v: Vendor) => void;
}) {
  const [full, setFull] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  // CSS variables restyle every OTHER surface on a theme flip; raster tiles are
  // pixels, so dark mode needs its own treatment. The keyless default has ONE
  // tile source and inverts it with the filter openstreetmap.org uses for its
  // own dark mode; a keyed provider that ships real dark cartography supplies a
  // second URL instead and is never filtered. Keyed below so react-leaflet
  // recreates the layer on either change.
  const theme = useAppTheme();
  // Starts on the keyless default so the map draws on the very first paint,
  // then upgrades if the owner has configured a provider. A dead config
  // endpoint leaves the default in place - never a grey void.
  const [tiles, setTiles] = useState<MapTiles>(OSM_TILES);
  useEffect(() => {
    let alive = true;
    loadPublicConfig()
      .then((c) => {
        if (alive && c.map?.url) setTiles(c.map);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const { url: tileUrl, className: tileClass } = tilesForTheme(tiles, theme === "dark" ? "dark" : "light");

  // Lock the page behind the fullscreen map so touch-scroll doesn't move it.
  useEffect(() => {
    if (!full) return;
    const unlock = lockBodyScroll();
    return () => {
      unlock();
    };
  }, [full]);

  // CRITICAL pin fix: shops with a missing or duplicate Google location all
  // collapse onto ONE point and their rating bubbles stack unusably. Spread
  // exact-duplicate coordinates onto a small deterministic golden-angle fan
  // (~80-150m) around the shared spot so every pin is visible and tappable.
  const spread = useMemo(() => {
    const seen = new Map<string, number>();
    return vendors.map((v) => {
      const key = `${v.lat.toFixed(4)},${v.lng.toFixed(4)}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      if (n === 0) return v;
      const angle = (n * 137.5 * Math.PI) / 180;
      const r = 0.0008 + 0.00025 * n;
      return { ...v, lat: v.lat + r * Math.sin(angle), lng: v.lng + r * Math.cos(angle) };
    });
  }, [vendors]);

  const selected = spread.find((v) => v.id === selectedId) ?? null;

  // Keep the selected card scrolled into view in the strip.
  useEffect(() => {
    if (!selectedId || !stripRef.current) return;
    const el = stripRef.current.querySelector<HTMLElement>(`[data-vid="${selectedId}"]`);
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [selectedId]);

  const map = (
    <MapContainer
      center={[origin.lat, origin.lng]}
      zoom={13}
      scrollWheelZoom
      className="h-full w-full"
      zoomControl={false}
    >
      <TileLayer
        // Keyed on the URL too, not just the theme: a provider swap arriving
        // from /api/config/public must recreate the layer, and a keyless
        // single-source basemap changes className rather than url between
        // themes - which Leaflet would otherwise never repaint.
        key={`${theme}|${tileUrl}`}
        attribution={tiles.attribution}
        url={tileUrl}
        className={tileClass}
        maxZoom={tiles.maxZoom}
        {...(tiles.subdomains ? { subdomains: tiles.subdomains } : {})}
      />
      <Recenter origin={origin} radiusKm={radiusKm} vendors={spread} focus={selected} />
      <Controls origin={origin} />

      <Circle
        center={[origin.lat, origin.lng]}
        radius={radiusKm * 1000}
        pathOptions={{ color: "#2f6fed", fillColor: "#2f6fed", fillOpacity: 0.04, weight: 1.5 }}
      />
      <Marker position={[origin.lat, origin.lng]} icon={stayIcon} />

      {spread.map((v) => (
        <Marker
          key={v.id}
          position={[v.lat, v.lng]}
          icon={priceIcon(v, v.id === selectedId)}
          eventHandlers={{ click: () => onSelect(v.id) }}
        />
      ))}
    </MapContainer>
  );

  // Swipeable horizontal strip of shop cards (shared by both views).
  const strip = (fs: boolean) => (
    <div
      ref={fs ? undefined : stripRef}
      className="no-scrollbar flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3"
    >
      {vendors.map((v) => (
        <div key={v.id} data-vid={v.id} className="snap-center">
          <ShopCard
            v={v}
            selected={v.id === selectedId}
            onSelect={() => onSelect(v.id)}
            onOpen={
              onOpenVendor
                ? () => {
                    if (fs) setFull(false);
                    onOpenVendor(v);
                  }
                : undefined
            }
          />
        </div>
      ))}
    </div>
  );

  if (full) {
    return createPortal(
      <div className="fixed inset-0 z-[1100] bg-base">
        <div className="absolute inset-0">{map}</div>

        <button
          onClick={() => setFull(false)}
          className="btn absolute right-4 z-[1150] rounded-2xl bg-card px-4 py-2.5 text-sm font-extrabold text-strong shadow-lg lift"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
        >
          ✕ Close map
        </button>

        <div className="absolute inset-x-0 bottom-0 z-[1140] pb-safe">{strip(true)}</div>
      </div>,
      document.body
    );
  }

  // Compact view: the cards live BELOW the map so the map itself stays fully
  // visible; only the fullscreen view overlays the strip on the map.
  return (
    <div className="w-full">
      <div className="relative z-0 h-[44vh] w-full overflow-hidden rounded-blob border-2 border-line md:h-[56vh]">
        {map}
        <button
          onClick={() => setFull(true)}
          aria-label="Expand map"
          className="btn absolute right-3 top-3 z-[500] rounded-xl bg-card px-3 py-2 text-[12px] font-extrabold text-strong shadow-lg lift"
        >
          ⛶ Expand
        </button>
      </div>

      {/* Swipeable shop strip UNDER the map (tap a card to focus its pin) */}
      {vendors.length > 0 && <div className="mt-3 -mx-4">{strip(false)}</div>}
    </div>
  );
}
