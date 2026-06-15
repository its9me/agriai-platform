"use client";

import "leaflet/dist/leaflet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Pane,
  Polygon,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents
} from "react-leaflet";
import type { LatLngExpression } from "leaflet";
import type { Map as LeafletMap } from "leaflet";

type MapLayer = "satellite" | "roads" | "agriculture";

type SatelliteLandMapProps = {
  center: [number, number];
  polygon: [number, number][];
  autoLocate?: boolean;
  readOnly?: boolean;
  visible?: boolean;
  onPolygonChange: (points: [number, number][]) => void;
  onCenterChange: (center: [number, number]) => void;
};

function MapLifecycle({
  center,
  visible,
  layer,
  pointsCount
}: {
  center: [number, number];
  visible: boolean;
  layer: MapLayer;
  pointsCount: number;
}) {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();
    if (!container?.isConnected) return;

    try {
      window.setTimeout(() => {
        map.invalidateSize({ pan: false });
        map.setView(center, map.getZoom(), { animate: false });
      }, 80);
    } catch {
      // Leaflet can briefly expose a disposed map during Fast Refresh/remount.
    }
  }, [center, visible, layer, pointsCount, map]);

  useEffect(() => {
    const container = map.getContainer();
    if (!container?.isConnected || typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(() => {
      map.invalidateSize({ pan: false });
    });
    resizeObserver.observe(container);

    const handleResize = () => map.invalidateSize({ pan: false });
    window.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
    };
  }, [map]);

  return null;
}

function PolygonClickHandler({
  points,
  readOnly,
  onPolygonChange,
  onCenterChange
}: {
  points: [number, number][];
  readOnly: boolean;
  onPolygonChange: (points: [number, number][]) => void;
  onCenterChange: (center: [number, number]) => void;
}) {
  useMapEvents({
    click(event) {
      if (readOnly) return;
      onPolygonChange([...points, [event.latlng.lat, event.latlng.lng]]);
    },
    moveend(event) {
      const center = event.target.getCenter();
      onCenterChange([center.lat, center.lng]);
    }
  });

  return null;
}

function LayerTiles({ layer }: { layer: MapLayer }) {
  if (layer === "roads") {
    return (
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
        updateWhenIdle
        keepBuffer={2}
      />
    );
  }

  if (layer === "agriculture") {
    return (
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
        updateWhenIdle
        keepBuffer={2}
      />
    );
  }

  return (
    <TileLayer
      attribution="Tiles &copy; Esri"
      url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      maxZoom={19}
      updateWhenIdle
      keepBuffer={2}
    />
  );
}

function readableLocationError(error: GeolocationPositionError) {
  if (error.code === error.PERMISSION_DENIED) {
    return "لم يتم السماح بتحديد الموقع. يمكنك تفعيل الإذن من المتصفح أو تحريك الخريطة يدوياً.";
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    return "تعذر الحصول على الموقع الحالي من الجهاز.";
  }

  if (error.code === error.TIMEOUT) {
    return "استغرق تحديد الموقع وقتاً أطول من المتوقع.";
  }

  return "تعذر تحديد الموقع.";
}

export function SatelliteLandMap({
  center,
  polygon,
  autoLocate = false,
  readOnly = false,
  visible = true,
  onPolygonChange,
  onCenterChange
}: SatelliteLandMapProps) {
  const [layer, setLayer] = useState<MapLayer>("satellite");
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [mapKey] = useState(() => `satellite-map-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mapRef = useRef<LeafletMap | null>(null);
  const positions = polygon as LatLngExpression[];
  const lineOptions = {
    color: "#00e676",
    fillColor: "#00e676",
    fillOpacity: 0.18,
    opacity: 1,
    weight: 5
  };

  const pointLabel = useMemo(() => {
    if (readOnly) return "عرض فقط: تحديد وتعديل الأرض من صلاحيات المدير";
    if (polygon.length === 0) return "انقر على أول زاوية من حدود الأرض";
    if (polygon.length < 3) return `تم اختيار ${polygon.length} نقطة، أكمل الزوايا حتى يتشكل المضلع`;
    return `الأرض محددة من ${polygon.length} نقاط ويمكن حفظها`;
  }, [polygon.length, readOnly]);

  const locateUser = useCallback(() => {
    setLocationError("");

    if (!navigator.geolocation) {
      setLocationError("المتصفح لا يدعم تحديد الموقع.");
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        onCenterChange([position.coords.latitude, position.coords.longitude]);
      },
      (error) => {
        setLocating(false);
        setLocationError(readableLocationError(error));
      },
      {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 30000
      }
    );
  }, [onCenterChange]);

  useEffect(() => {
    if (autoLocate) {
      locateUser();
    }
  }, [autoLocate, locateUser]);

  useEffect(() => {
    return () => {
      try {
        mapRef.current?.remove();
      } catch {
        // The map may already be removed by React Leaflet during reloads.
      } finally {
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div className="mapWorkspace">
      <div className="mapToolbar">
        <div className="segmented" aria-label="طبقات الخريطة">
          <button
            type="button"
            className={layer === "satellite" ? "active" : ""}
            onClick={() => setLayer("satellite")}
          >
            قمر صناعي
          </button>
          <button
            type="button"
            className={layer === "roads" ? "active" : ""}
            onClick={() => setLayer("roads")}
          >
            طرق ومدن
          </button>
          <button
            type="button"
            className={layer === "agriculture" ? "active" : ""}
            onClick={() => setLayer("agriculture")}
          >
            أراضي زراعية
          </button>
        </div>
        <button type="button" className="ghostButton" onClick={locateUser}>
          {locating ? "جاري تحديد الموقع..." : "موقعي الآن"}
        </button>
      </div>

      <div className="mapFrame">
        <MapContainer key={mapKey} ref={mapRef} center={center} zoom={16} className="map" preferCanvas>
          <MapLifecycle center={center} visible={visible} layer={layer} pointsCount={polygon.length} />
          <LayerTiles layer={layer} />
          <PolygonClickHandler
            points={polygon}
            readOnly={readOnly}
            onPolygonChange={onPolygonChange}
            onCenterChange={onCenterChange}
          />
          <Pane name="selection-lines" style={{ zIndex: 650 }}>
            {polygon.length >= 2 ? (
              <Polyline positions={positions} pathOptions={lineOptions} />
            ) : null}
            {polygon.length >= 3 ? (
              <Polygon positions={positions} pathOptions={lineOptions} />
            ) : null}
          </Pane>
          <Pane name="selection-points" style={{ zIndex: 660 }}>
            {polygon.map((point, index) => (
              <CircleMarker
                key={`${point[0]}-${point[1]}-${index}`}
                center={point}
                radius={7}
                pathOptions={{
                  color: "#ffffff",
                  fillColor: "#00e676",
                  fillOpacity: 1,
                  opacity: 1,
                  weight: 3
                }}
              />
            ))}
          </Pane>
        </MapContainer>
        <div className="mapHint">
          <strong>{pointLabel}</strong>
          <span>يمكنك التبديل بين القمر الصناعي والطرق والأراضي الزراعية بدون فقدان الحدود المرسومة.</span>
        </div>
      </div>

      <div className="mapTools">
        {!readOnly ? (
          <>
            <button type="button" className="secondary" onClick={() => onPolygonChange(polygon.slice(0, -1))}>
              تراجع نقطة
            </button>
            <button type="button" className="secondary" onClick={() => onPolygonChange([])}>
              مسح الحدود
            </button>
          </>
        ) : null}
        {locationError ? <span className="inlineError">{locationError}</span> : null}
      </div>
    </div>
  );
}
