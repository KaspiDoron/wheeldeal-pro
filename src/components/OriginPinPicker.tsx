"use client";

// Premium pin-drop location picker: instead of typing a hotel name, drop (or
// drag) a pin on a live map and search exactly there. Reuses the app's
// existing Leaflet stack + /api/geocode reverse lookup - zero new
// dependencies, and the confirmed point flows into the SAME origin state the
// text picker fills, radius circle included.

import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, TileLayer, Marker, Circle, useMapEvents } from "react-leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { LoadingDots } from "./LoadingDots";
import type { Origin } from "./OriginPicker";
import { useAppTheme } from "@/lib/client/theme";
import { OSM_TILES, tilesForTheme, type MapTiles } from "@/lib/map-tiles";
import { loadPublicConfig } from "@/lib/client/public-config";

const pinIcon = L.divIcon({
  className: "",
  html: `<div style="font-size:34px;line-height:1;transform:translate(-4px,-6px);filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))">📍</div>`,
  iconSize: [34, 34],
  iconAnchor: [17, 30],
});

function ClickCatcher({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click: (e) => onPick(e.latlng.lat, e.latlng.lng),
  });
  return null;
}

export default function OriginPinPicker({
  initial,
  radiusKm,
  onConfirm,
  onClose,
}: {
  initial: { lat: number; lng: number } | null;
  radiusKm: number;
  onConfirm: (o: Origin) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  // Default view: the current origin, or a world-friendly fallback (Bangkok -
  // the app's busiest market) until the user taps.
  const start = initial ?? { lat: 13.7563, lng: 100.5018 };
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(initial);
  const [label, setLabel] = useState<string>("");
  const [resolving, setResolving] = useState(false);
  const seq = useRef(0);

  // The same basemap the main map draws (see lib/map-tiles). This surface used
  // to hard-code the keyless CARTO voyager URL, so it inherited the "API KEY
  // REQUIRED" watermark independently, and it never followed the theme.
  const theme = useAppTheme();
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
  const { url: tileUrl, className: tileClass } = tilesForTheme(
    tiles,
    theme === "dark" ? "dark" : "light"
  );

  // Reverse-geocode the pin into a real place name (same API the GPS flow
  // uses) - the label drives currency + language resolution downstream.
  useEffect(() => {
    if (!pin) return;
    const mySeq = ++seq.current;
    setResolving(true);
    fetch(`/api/geocode?lat=${pin.lat}&lng=${pin.lng}`)
      .then((r) => r.json())
      .then((d) => {
        if (seq.current !== mySeq) return; // a newer pin superseded this one
        const name = d?.place?.label ?? `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`;
        setLabel(String(name));
      })
      .catch(() => {
        if (seq.current === mySeq) setLabel(`${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`);
      })
      .finally(() => {
        if (seq.current === mySeq) setResolving(false);
      });
  }, [pin]);

  const marker = useMemo(
    () =>
      pin ? (
        <Marker
          position={[pin.lat, pin.lng]}
          icon={pinIcon}
          draggable
          eventHandlers={{
            dragend: (e) => {
              const ll = (e.target as L.Marker).getLatLng();
              setPin({ lat: ll.lat, lng: ll.lng });
            },
          }}
        />
      ) : null,
    [pin]
  );

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="layer-lightbox fixed inset-0 flex flex-col bg-black/70 pt-safe pb-safe">
      <div className="mx-auto flex h-full w-full max-w-lg flex-col p-3">
        <div className="surface-strong flex-1 overflow-hidden rounded-blob">
          <div className="flex items-center justify-between p-3 pb-2">
            <div>
              <div className="text-[15px] font-extrabold text-strong">📍 {t("Drop a pin")}</div>
              <div className="text-[11px] text-soft">
                {t("Tap the map (or drag the pin) to search exactly there")}
              </div>
            </div>
            <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
              ✕
            </button>
          </div>
          <div className="relative h-[calc(100%-118px)] min-h-[280px]">
            <MapContainer
              center={[start.lat, start.lng]}
              zoom={pin ? 14 : 11}
              className="h-full w-full"
            >
              {/* The credit was suppressed entirely here (attributionControl
                  false, no attribution prop) - a live compliance gap under
                  every raster provider's terms, independent of the watermark
                  this component was carrying. */}
              <TileLayer
                key={`${theme}|${tileUrl}`}
                url={tileUrl}
                className={tileClass}
                attribution={tiles.attribution}
                maxZoom={tiles.maxZoom}
                {...(tiles.subdomains ? { subdomains: tiles.subdomains } : {})}
              />
              <ClickCatcher onPick={(lat, lng) => setPin({ lat, lng })} />
              {marker}
              {pin && (
                <Circle
                  center={[pin.lat, pin.lng]}
                  radius={radiusKm * 1000}
                  pathOptions={{ color: "#2f6fed", weight: 1.5, fillOpacity: 0.08 }}
                />
              )}
            </MapContainer>
            {!pin && (
              <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] mx-auto w-fit rounded-full bg-card2/95 px-3 py-1.5 text-[11px] font-extrabold text-soft shadow backdrop-blur">
                {t("Tap anywhere to place your pin")}
              </div>
            )}
          </div>
          <div className="p-3 pt-2">
            <div className="min-h-[18px] text-[12px] text-soft">
              {resolving ? (
                <LoadingDots label={t("Finding the place name")} />
              ) : pin && label ? (
                <span className="font-bold text-strong">📌 {label}</span>
              ) : (
                <span className="text-faint">
                  {t("The search will cover")} {radiusKm} {t("km around your pin")}
                </span>
              )}
            </div>
            <button
              onClick={() => {
                if (!pin) return;
                onConfirm({
                  label: label || `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`,
                  lat: pin.lat,
                  lng: pin.lng,
                });
              }}
              disabled={!pin || resolving}
              className="btn btn-primary mt-2 w-full rounded-2xl py-3 text-[14px] disabled:opacity-50"
            >
              {pin
                ? `${t("Search here")} · ${radiusKm} ${t("km")}`
                : t("Place a pin first")}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
