"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface TacticalMapProps {
  svgUrl: string;
  mapName: string;
  onClose?: () => void;
}

interface LayerVisibility {
  players: boolean;
  utility: boolean;
  arrows: boolean;
  zones: boolean;
}

interface TooltipData {
  text: string;
  x: number;
  y: number;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

const ROLE_MAP: Record<string, string> = {
  I: "IGL",
  A: "AWP",
  E: "Entry",
  L: "Lurker",
  S: "Support",
};

const UTILITY_TYPE_MAP: Record<string, string> = {
  S: "Smoke",
  F: "Flash",
  M: "Molotov",
  H: "HE Grenade",
};

const BASE_SCALE = 1.25;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

/* -------------------------------------------------------------------------- */
/*  SVG Annotation – walk DOM and tag interactive elements                    */
/* -------------------------------------------------------------------------- */

function annotateSvg(svgEl: SVGSVGElement) {
  // ── Players ──────────────────────────────────────────────────────────
  const circles = svgEl.querySelectorAll("circle");
  circles.forEach((el) => {
    const r = el.getAttribute("r");
    const fill = el.getAttribute("fill") || "";
    const stroke = el.getAttribute("stroke");

    if (r === "14" && stroke === "white") {
      const team = fill === "#EF5350" ? "T" : "CT";
      el.setAttribute("data-tm-type", "player");
      el.setAttribute("data-tm-team", team);
      el.classList.add("tm-player");

      const prev = el.previousElementSibling;
      if (prev && prev.tagName === "circle") {
        const prevFill = prev.getAttribute("fill") || "";
        if (prevFill === "rgba(0,0,0,0.4)") {
          prev.setAttribute("data-tm-type", "player");
          prev.classList.add("tm-player");
        }
      }

      const next = el.nextElementSibling;
      if (next && next.tagName === "text") {
        const letter = (next.textContent || "").trim();
        const role = ROLE_MAP[letter] || letter;
        el.setAttribute("data-tm-role", role);
        next.setAttribute("data-tm-type", "player");
        next.classList.add("tm-player");
        const tooltipText = `${team} ${role}`;
        el.setAttribute("data-tm-tooltip", tooltipText);
      }
    }
  });

  // ── Utility markers (smoke circles r=10) ─────────────────────────────
  circles.forEach((el) => {
    if (el.hasAttribute("data-tm-type")) return;
    const r = el.getAttribute("r");
    if (r === "10") {
      el.setAttribute("data-tm-type", "utility");
      el.classList.add("tm-utility");

      const typeText = el.nextElementSibling;
      if (typeText && typeText.tagName === "text") {
        const letter = (typeText.textContent || "").trim();
        const utilType = UTILITY_TYPE_MAP[letter] || letter;
        el.setAttribute("data-tm-utility-type", utilType);
        typeText.setAttribute("data-tm-type", "utility");
        typeText.classList.add("tm-utility");

        const labelText = typeText.nextElementSibling;
        if (labelText && labelText.tagName === "text") {
          const label = (labelText.textContent || "").trim();
          el.setAttribute("data-tm-label", label);
          el.setAttribute("data-tm-tooltip", `${utilType}: ${label}`);
          labelText.setAttribute("data-tm-type", "utility");
          labelText.classList.add("tm-utility");
        } else {
          el.setAttribute("data-tm-tooltip", utilType);
        }
      }
    }
  });

  // ── Utility markers (flash star polygons) ─────────────────────────────
  const polygons = svgEl.querySelectorAll("polygon");
  polygons.forEach((el) => {
    if (el.hasAttribute("data-tm-type")) return;
    const fill = el.getAttribute("fill") || "";
    if (fill === "#FFD600") {
      el.setAttribute("data-tm-type", "utility");
      el.setAttribute("data-tm-utility-type", "Flash");
      el.classList.add("tm-utility");

      const typeText = el.nextElementSibling;
      if (typeText && typeText.tagName === "text") {
        typeText.setAttribute("data-tm-type", "utility");
        typeText.classList.add("tm-utility");
      }
      const labelText = typeText?.nextElementSibling;
      if (labelText && labelText.tagName === "text") {
        const label = (labelText.textContent || "").trim();
        el.setAttribute("data-tm-label", label);
        el.setAttribute("data-tm-tooltip", `Flash: ${label}`);
        labelText.setAttribute("data-tm-type", "utility");
        labelText.classList.add("tm-utility");
      } else {
        el.setAttribute("data-tm-tooltip", "Flash");
      }
    }
  });

  // ── Arrows (lines with marker-end) ───────────────────────────────────
  svgEl.querySelectorAll("line").forEach((el) => {
    const markerEnd = el.getAttribute("marker-end");
    if (markerEnd) {
      el.setAttribute("data-tm-type", "arrow");
      el.classList.add("tm-arrow");
      const arrowKind = markerEnd.includes("Push") ? "Push" : "Throw";
      el.setAttribute("data-tm-tooltip", `${arrowKind} arrow`);
    } else {
      const dash = el.getAttribute("stroke-dasharray");
      if (dash) {
        el.setAttribute("data-tm-type", "utility");
        el.classList.add("tm-utility");
      }
    }
  });

  // ── Zones (polygons with rgba fills) ─────────────────────────────────
  polygons.forEach((el) => {
    if (el.hasAttribute("data-tm-type")) return;
    const fill = el.getAttribute("fill") || "";
    if (fill.startsWith("rgba")) {
      el.setAttribute("data-tm-type", "zone");
      el.classList.add("tm-zone");

      const nextText = el.nextElementSibling;
      if (nextText && nextText.tagName === "text") {
        const callout = (nextText.textContent || "").trim();
        el.setAttribute("data-tm-callout", callout);
        el.setAttribute("data-tm-tooltip", callout);
        nextText.setAttribute("data-tm-type", "zone");
        nextText.classList.add("tm-zone");
      }
    }
  });

  // ── Title bar / legend (system, always visible) ──────────────────────
  svgEl.querySelectorAll("rect").forEach((el) => {
    const fill = el.getAttribute("fill") || "";
    if (
      fill === "rgba(0,0,0,0.65)" ||
      fill === "rgba(0,0,0,0.55)"
    ) {
      el.setAttribute("data-tm-type", "system");
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Apply layer visibility to annotated SVG elements                          */
/* -------------------------------------------------------------------------- */

function applyLayerVisibility(
  svgEl: SVGSVGElement,
  layers: LayerVisibility
) {
  const typed = svgEl.querySelectorAll("[data-tm-type]");
  typed.forEach((el) => {
    const type = el.getAttribute("data-tm-type")!;
    let visible = true;
    switch (type) {
      case "player":
        visible = layers.players;
        break;
      case "utility":
        visible = layers.utility;
        break;
      case "arrow":
        visible = layers.arrows;
        break;
      case "zone":
        visible = layers.zones;
        break;
      default:
        visible = true;
    }
    (el as HTMLElement).style.visibility = visible ? "visible" : "hidden";
    (el as HTMLElement).style.pointerEvents = visible ? "auto" : "none";
  });
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export default function TacticalMap({ svgUrl, mapName, onClose }: TacticalMapProps) {
  /* ── State ─────────────────────────────────────────────────────────── */
  const [svgContent, setSvgContent] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [layers, setLayers] = useState<LayerVisibility>({
    players: true,
    utility: true,
    arrows: true,
    zones: true,
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ── Refs ──────────────────────────────────────────────────────────── */
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const lastTouchDist = useRef(0);
  const lastTouchCenter = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });

  // Keep refs in sync with state for use in callbacks
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { panRef.current = pan; }, [pan]);

  /* ── Fetch SVG ─────────────────────────────────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetch(svgUrl)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load tactical map");
        return res.text();
      })
      .then((svg) => {
        if (!cancelled) {
          setSvgContent(svg);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [svgUrl]);

  /* ── Annotate SVG after injection ──────────────────────────────────── */
  useEffect(() => {
    if (!svgContent || !svgRef.current) return;
    const svgEl = svgRef.current.querySelector("svg");
    if (!svgEl) return;

    // Make SVG fill its container, preserve aspect ratio
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
    svgEl.style.display = "block";

    // Fix: make the DISPLAY_SCALE 1.25 from map-renderer actually visible.
    // The renderer outputs viewBox="0 0 1280 1280" + <g transform="scale(1.25)">
    // which cancels out visually. We change viewBox to "0 0 1024 1024" and
    // remove the internal scale — the component applies a CSS base scale instead.
    const vb = svgEl.getAttribute("viewBox") || "";
    if (vb === "0 0 1280 1280") {
      svgEl.setAttribute("viewBox", "0 0 1024 1024");
    }
    const g = svgEl.querySelector("g");
    if (g && g.getAttribute("transform") === "scale(1.25)") {
      g.removeAttribute("transform");
    }

    annotateSvg(svgEl);
  }, [svgContent]);

  /* ── Apply layer visibility ────────────────────────────────────────── */
  useEffect(() => {
    if (!svgRef.current) return;
    const svgEl = svgRef.current.querySelector("svg");
    if (!svgEl) return;
    applyLayerVisibility(svgEl, layers);
  }, [layers, svgContent, isMinimized]);

  /* ── Clamp pan to keep SVG visible ─────────────────────────────────── */
  const clampPan = useCallback((p: { x: number; y: number }, z: number, containerW: number, containerH: number) => {
    const effectiveZ = z * BASE_SCALE;
    if (effectiveZ <= 1) return { x: 0, y: 0 };
    const scaledW = containerW * effectiveZ;
    const scaledH = containerH * effectiveZ;
    // With transform-origin: 0 0, content expands right/down when scaled.
    // Valid range: x in [-(scaledW - containerW), 0], y in [-(scaledH - containerH), 0]
    return {
      x: Math.max(-(scaledW - containerW), Math.min(0, p.x)),
      y: Math.max(-(scaledH - containerH), Math.min(0, p.y)),
    };
  }, []);

  /* ── Wheel zoom (centered on cursor) ───────────────────────────────── */
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomRef.current + delta));
      if (newZoom === zoomRef.current) return;

      const rect = svgRef.current!.getBoundingClientRect();
      // Mouse position relative to container
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Zoom centered on cursor: keep the content point under the cursor fixed
      const ratio = newZoom / zoomRef.current;
      const newPan = {
        x: panRef.current.x * ratio + mx * (1 - ratio),
        y: panRef.current.y * ratio + my * (1 - ratio),
      };

      setZoom(newZoom);
      setPan(clampPan(newPan, newZoom, rect.width, rect.height));
    },
    [clampPan]
  );

  /* ── Mouse drag pan ────────────────────────────────────────────────── */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      isDragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY };
      panStart.current = { ...panRef.current };
      if (svgRef.current)
        svgRef.current.style.cursor = "grabbing";
    },
    []
  );

  const handleGlobalMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const newPan = {
        x: panStart.current.x + dx,
        y: panStart.current.y + dy,
      };
      setPan(clampPan(newPan, zoomRef.current, rect.width, rect.height));
    },
    [clampPan]
  );

  const handleGlobalMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false;
      if (svgRef.current)
        svgRef.current.style.cursor = "grab";
    }
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [handleGlobalMouseMove, handleGlobalMouseUp]);

  /* ── Tooltip via mouseover delegation ──────────────────────────────── */
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isDragging.current) {
        setTooltip(null);
        return;
      }
      const target = e.target as Element;
      const annotated =
        target.closest("[data-tm-tooltip]") ||
        target.closest("[data-tm-type]");
      if (!annotated) {
        if (tooltip) setTooltip(null);
        return;
      }
      const tipText = annotated.getAttribute("data-tm-tooltip");
      if (!tipText) {
        setTooltip(null);
        return;
      }
      const rect = svgRef.current!.getBoundingClientRect();
      setTooltip({
        text: tipText,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
    },
    [tooltip]
  );

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  /* ── Touch: pinch-to-zoom + drag-to-pan ────────────────────────────── */
  const getTouchDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        lastTouchDist.current = getTouchDistance(e.touches);
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        lastTouchCenter.current = { x: cx, y: cy };
      } else if (e.touches.length === 1) {
        isDragging.current = true;
        dragStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
        panStart.current = { ...panRef.current };
      }
    },
    []
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const newDist = getTouchDistance(e.touches);
        const ratio = newDist / (lastTouchDist.current || 1);
        lastTouchDist.current = newDist;

        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;

        // Midpoint of pinch in container coordinates
        const mx = lastTouchCenter.current.x - rect.left;
        const my = lastTouchCenter.current.y - rect.top;

        const currentZoom = zoomRef.current;
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * ratio));
        if (newZoom === currentZoom) return;
        const effectiveRatio = newZoom / currentZoom;
        const currentPan = panRef.current;
        setZoom(newZoom);
        setPan(
          clampPan(
            { x: currentPan.x * effectiveRatio + mx * (1 - effectiveRatio), y: currentPan.y * effectiveRatio + my * (1 - effectiveRatio) },
            newZoom,
            rect.width,
            rect.height
          )
        );
      } else if (e.touches.length === 1 && isDragging.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - dragStart.current.x;
        const dy = e.touches[0].clientY - dragStart.current.y;
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        const newPan = {
          x: panStart.current.x + dx,
          y: panStart.current.y + dy,
        };
        setPan(clampPan(newPan, zoomRef.current, rect.width, rect.height));
      }
    },
    [clampPan]
  );

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  /* ── Zoom helpers ──────────────────────────────────────────────────── */
  const zoomIn = () => {
    const newZoom = Math.min(MAX_ZOOM, zoom + ZOOM_STEP);
    setZoom(newZoom);
  };
  const zoomOut = () => {
    const newZoom = Math.max(MIN_ZOOM, zoom - ZOOM_STEP);
    setZoom(newZoom);
  };
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /* ── Layer toggle ──────────────────────────────────────────────────── */
  const toggleLayer = (layer: keyof LayerVisibility) =>
    setLayers((prev) => ({ ...prev, [layer]: !prev[layer] }));

  /* ── Escape key to exit fullscreen ─────────────────────────────────── */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  /* ── Render ────────────────────────────────────────────────────────── */
  // Transform with base scale so DISPLAY_SCALE=1.25 is actually visible
  const effectiveZoom = zoom * BASE_SCALE;
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${effectiveZoom})`;

  const layerBtn = (
    label: string,
    layer: keyof LayerVisibility,
    icon: string
  ) => (
    <button
      onClick={() => toggleLayer(layer)}
      className={`tm-toolbar-btn ${layers[layer] ? "tm-toolbar-btn-active" : ""}`}
      title={`Toggle ${label}`}
    >
      {icon} {label}
    </button>
  );

  return (
    <div
      ref={containerRef}
      className={`tm-wrapper ${isFullscreen ? "tm-fullscreen" : ""} ${isMinimized && !isFullscreen ? "tm-minimized" : ""}`}
    >
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div className="tm-toolbar">
        <span className="tm-title">
          {mapName} Tactical Map
        </span>

        {layerBtn("Players", "players", "👤")}
        {layerBtn("Utility", "utility", "💨")}
        {layerBtn("Arrows", "arrows", "➡")}
        {layerBtn("Zones", "zones", "🗺")}

        <span className="tm-sep" />

        <button
          onClick={zoomOut}
          disabled={zoom <= MIN_ZOOM}
          className="tm-toolbar-btn"
          style={{ opacity: zoom <= MIN_ZOOM ? 0.4 : 1 }}
          title="Zoom out"
        >
          −
        </button>
        <span className="tm-zoom-label">{Math.round(effectiveZoom * 100)}%</span>
        <button
          onClick={zoomIn}
          disabled={zoom >= MAX_ZOOM}
          className="tm-toolbar-btn"
          style={{ opacity: zoom >= MAX_ZOOM ? 0.4 : 1 }}
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={resetView}
          className="tm-toolbar-btn"
          title="Reset view"
        >
          ↺
        </button>

        <span className="tm-spacer" />

        <button
          onClick={() => setIsMinimized((p) => !p)}
          className="tm-toolbar-btn"
          title={isMinimized ? "Expand" : "Minimize"}
        >
          {isMinimized ? "▾" : "▴"}
        </button>
        <button
          onClick={() => setIsFullscreen((p) => !p)}
          className="tm-toolbar-btn"
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? "✕" : "⛶"}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            className="tm-toolbar-btn"
            style={{ color: "#EF5350" }}
            title="Close map"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── SVG Container ────────────────────────────────────────── */}
      {isMinimized && !isFullscreen ? (
        <div
          className="tm-minimized-msg"
          onClick={() => setIsMinimized(false)}
        >
          Map minimized — tap to expand
        </div>
      ) : (
        <div
          ref={svgRef}
          className={`tm-svg-container ${isFullscreen ? "tm-svg-fullscreen" : ""}`}
          style={{
            cursor: isDragging.current ? "grabbing" : "grab",
          }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {loading && <div className="tm-loading">Loading map...</div>}
          {error && <div className="tm-error">{error}</div>}
          {svgContent && (
            <div
              className="tm-svg-inner"
              style={{
                transform,
                transition: isDragging.current ? "none" : "transform 0.1s ease-out",
              }}
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          )}

          {/* Tooltip */}
          {tooltip && (
            <div className="tm-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
              {tooltip.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
