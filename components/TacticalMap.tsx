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

const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
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

    // Main player circle: r=14, has white stroke
    if (r === "14" && stroke === "white") {
      const team = fill === "#EF5350" ? "T" : "CT";
      el.setAttribute("data-tm-type", "player");
      el.setAttribute("data-tm-team", team);
      el.classList.add("tm-player");

      // Mark shadow circle (previous sibling)
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === "circle") {
        const prevFill = prev.getAttribute("fill") || "";
        if (prevFill === "rgba(0,0,0,0.4)") {
          prev.setAttribute("data-tm-type", "player");
          prev.classList.add("tm-player");
        }
      }

      // Extract role from next text sibling
      const next = el.nextElementSibling;
      if (next && next.tagName === "text") {
        const letter = (next.textContent || "").trim();
        const role = ROLE_MAP[letter] || letter;
        el.setAttribute("data-tm-role", role);
        next.setAttribute("data-tm-type", "player");
        next.classList.add("tm-player");

        // Build tooltip text
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

      // Type letter from next text sibling
      const typeText = el.nextElementSibling;
      if (typeText && typeText.tagName === "text") {
        const letter = (typeText.textContent || "").trim();
        const utilType = UTILITY_TYPE_MAP[letter] || letter;
        el.setAttribute("data-tm-utility-type", utilType);
        typeText.setAttribute("data-tm-type", "utility");
        typeText.classList.add("tm-utility");

        // Label text from the text after that
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

      // Type letter text
      const typeText = el.nextElementSibling;
      if (typeText && typeText.tagName === "text") {
        typeText.setAttribute("data-tm-type", "utility");
        typeText.classList.add("tm-utility");
      }
      // Label text
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
      // Thin utility trajectory lines (dashed, no marker-end)
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

      // Callout name from next text sibling
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
/*  Styles                                                                    */
/* -------------------------------------------------------------------------- */

const STYLES = {
  wrapper: {
    position: "relative" as const,
    background: "#1a1a2e",
    borderRadius: "12px",
    border: "1px solid rgba(255,255,255,0.1)",
    overflow: "hidden",
    marginTop: "8px",
    fontFamily: "sans-serif",
    width: "100%",
  },
  wrapperFullscreen: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    borderRadius: 0,
    border: "none",
    margin: 0,
  },
  wrapperMinimized: {
    height: "48px",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "6px 10px",
    background: "rgba(0,0,0,0.5)",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    flexWrap: "wrap" as const,
  },
  toolbarBtn: {
    background: "rgba(255,255,255,0.08)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "6px",
    color: "#ccc",
    cursor: "pointer",
    fontSize: "12px",
    padding: "4px 8px",
    lineHeight: "18px",
    transition: "all 0.15s ease",
    userSelect: "none" as const,
    touchAction: "manipulation",
  },
  toolbarBtnActive: {
    background: "rgba(124,77,255,0.3)",
    borderColor: "rgba(124,77,255,0.5)",
    color: "#fff",
  },
  toolbarBtnHover: {
    background: "rgba(255,255,255,0.15)",
  },
  separator: {
    width: "1px",
    height: "18px",
    background: "rgba(255,255,255,0.12)",
    margin: "0 4px",
  },
  mapTitle: {
    color: "#eee",
    fontSize: "13px",
    fontWeight: 600,
    marginRight: "8px",
    textTransform: "capitalize" as const,
    whiteSpace: "nowrap" as const,
  },
  spacer: {
    flex: 1,
  },
  svgContainer: {
    width: "100%",
    overflow: "hidden",
    cursor: "grab",
    position: "relative" as const,
    background: "#1a1a2e",
    touchAction: "none",
    aspectRatio: "1 / 1",
  },
  svgContainerFullscreen: {
    height: "calc(100vh - 42px)",
    maxHeight: "none",
  },
  svgInner: {
    transformOrigin: "0 0",
    transition: "transform 0.1s ease-out",
    width: "100%",
  },
  svgInnerDragging: {
    transition: "none",
  },
  tooltip: {
    position: "absolute" as const,
    zIndex: 100,
    background: "rgba(0,0,0,0.88)",
    color: "#fff",
    fontSize: "12px",
    padding: "5px 10px",
    borderRadius: "6px",
    pointerEvents: "none" as const,
    whiteSpace: "nowrap" as const,
    border: "1px solid rgba(255,255,255,0.15)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    transform: "translate(-50%, -100%)",
    marginTop: "-8px",
  },
  loadingOverlay: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "200px",
    color: "#888",
    fontSize: "14px",
  },
  errorOverlay: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "200px",
    color: "#EF5350",
    fontSize: "14px",
  },
  zoomLabel: {
    color: "#aaa",
    fontSize: "11px",
    minWidth: "32px",
    textAlign: "center" as const,
  },
  minimizedContent: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "48px",
    color: "#aaa",
    fontSize: "13px",
    cursor: "pointer",
  },
};

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
  const panCallback = useRef(setPan);

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

    // Make SVG responsive
    svgEl.setAttribute("width", "100%");
    svgEl.removeAttribute("height");
    svgEl.style.maxHeight = "100%";
    svgEl.style.display = "block";

    annotateSvg(svgEl);
  }, [svgContent]);

  /* ── Apply layer visibility ────────────────────────────────────────── */
  useEffect(() => {
    if (!svgRef.current) return;
    const svgEl = svgRef.current.querySelector("svg");
    if (!svgEl) return;
    applyLayerVisibility(svgEl, layers);
  }, [layers, svgContent, isMinimized]);

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

  /* ── Wheel zoom ────────────────────────────────────────────────────── */
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setZoom((prev) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev + delta)));
    },
    []
  );

  /* ── Mouse drag pan ────────────────────────────────────────────────── */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (zoom <= 1) return;
      isDragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY };
      panStart.current = { ...pan };
      if (containerRef.current)
        containerRef.current.style.cursor = "grabbing";
    },
    [zoom, pan]
  );

  const handleGlobalMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      panCallback.current({
        x: panStart.current.x + dx,
        y: panStart.current.y + dy,
      });
    },
    []
  );

  const handleGlobalMouseUp = useCallback(() => {
    if (isDragging.current) {
      isDragging.current = false;
      if (containerRef.current)
        containerRef.current.style.cursor = zoom > 1 ? "grab" : "default";
    }
  }, [zoom]);

  useEffect(() => {
    window.addEventListener("mousemove", handleGlobalMouseMove);
    window.addEventListener("mouseup", handleGlobalMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [handleGlobalMouseMove, handleGlobalMouseUp]);

  /* ── Touch: pinch-to-zoom + drag-to-pan ────────────────────────────── */
  const getTouchDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchCenter = (touches: React.TouchList) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  });

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        // Pinch start
        lastTouchDist.current = getTouchDistance(e.touches);
        lastTouchCenter.current = getTouchCenter(e.touches);
      } else if (e.touches.length === 1 && zoom > 1) {
        // Pan start
        isDragging.current = true;
        dragStart.current = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
        };
        panStart.current = { ...pan };
      }
    },
    [zoom, pan]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const newDist = getTouchDistance(e.touches);
        const scale = newDist / (lastTouchDist.current || 1);
        lastTouchDist.current = newDist;
        setZoom((prev) =>
          Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev * scale))
        );
      } else if (e.touches.length === 1 && isDragging.current) {
        e.preventDefault();
        const dx = e.touches[0].clientX - dragStart.current.x;
        const dy = e.touches[0].clientY - dragStart.current.y;
        setPan({
          x: panStart.current.x + dx,
          y: panStart.current.y + dy,
        });
      }
    },
    []
  );

  const handleTouchEnd = useCallback(() => {
    isDragging.current = false;
  }, []);

  /* ── Zoom helpers ──────────────────────────────────────────────────── */
  const zoomIn = () =>
    setZoom((prev) => Math.min(MAX_ZOOM, prev + ZOOM_STEP));
  const zoomOut = () =>
    setZoom((prev) => Math.max(MIN_ZOOM, prev - ZOOM_STEP));
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
  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  const layerBtn = (
    label: string,
    layer: keyof LayerVisibility,
    icon: string
  ) => (
    <button
      onClick={() => toggleLayer(layer)}
      style={{
        ...STYLES.toolbarBtn,
        ...(layers[layer] ? STYLES.toolbarBtnActive : {}),
      }}
      title={`Toggle ${label}`}
    >
      {icon} {label}
    </button>
  );

  return (
    <div
      ref={containerRef}
      className="tactical-map-wrapper"
      style={{
        ...STYLES.wrapper,
        ...(isFullscreen ? STYLES.wrapperFullscreen : {}),
        ...(isMinimized && !isFullscreen ? STYLES.wrapperMinimized : {}),
      }}
    >
      {/* ── Toolbar ──────────────────────────────────────────────── */}
      <div className="tactical-map-toolbar" style={STYLES.toolbar}>
        <span className="tactical-map-title" style={STYLES.mapTitle}>
          {mapName} Tactical Map
        </span>

        {layerBtn("Players", "players", "👤")}
        {layerBtn("Utility", "utility", "💨")}
        {layerBtn("Arrows", "arrows", "➡")}
        {layerBtn("Zones", "zones", "🗺")}

        <span style={STYLES.separator} />

        <button
          onClick={zoomOut}
          disabled={zoom <= MIN_ZOOM}
          style={{
            ...STYLES.toolbarBtn,
            opacity: zoom <= MIN_ZOOM ? 0.4 : 1,
          }}
          title="Zoom out"
        >
          −
        </button>
        <span style={STYLES.zoomLabel}>{Math.round(zoom * 100)}%</span>
        <button
          onClick={zoomIn}
          disabled={zoom >= MAX_ZOOM}
          style={{
            ...STYLES.toolbarBtn,
            opacity: zoom >= MAX_ZOOM ? 0.4 : 1,
          }}
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={resetView}
          style={STYLES.toolbarBtn}
          title="Reset view"
        >
          ↺
        </button>

        <span style={STYLES.spacer} />

        <button
          onClick={() => setIsMinimized((p) => !p)}
          style={STYLES.toolbarBtn}
          title={isMinimized ? "Expand" : "Minimize"}
        >
          {isMinimized ? "▾" : "▴"}
        </button>
        <button
          onClick={() => setIsFullscreen((p) => !p)}
          style={STYLES.toolbarBtn}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? "✕" : "⛶"}
        </button>
        {onClose && (
          <button
            onClick={onClose}
            style={{ ...STYLES.toolbarBtn, color: "#EF5350" }}
            title="Close map"
          >
            ✕
          </button>
        )}
      </div>

      {/* ── SVG Container ────────────────────────────────────────── */}
      {isMinimized && !isFullscreen ? (
        <div
          style={STYLES.minimizedContent}
          onClick={() => setIsMinimized(false)}
        >
          Map minimized — click to expand
        </div>
      ) : (
        <div
          ref={svgRef}
          className="tactical-map-svg-container"
          style={{
            ...STYLES.svgContainer,
            ...(isFullscreen ? STYLES.svgContainerFullscreen : {}),
            cursor: zoom > 1 ? (isDragging.current ? "grabbing" : "grab") : "default",
          }}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {loading && <div style={STYLES.loadingOverlay}>Loading map...</div>}
          {error && <div style={STYLES.errorOverlay}>{error}</div>}
          {svgContent && (
            <div
              style={{
                ...STYLES.svgInner,
                ...(isDragging.current ? STYLES.svgInnerDragging : {}),
                transform,
              }}
              dangerouslySetInnerHTML={{ __html: svgContent }}
            />
          )}

          {/* Tooltip */}
          {tooltip && (
            <div style={{ ...STYLES.tooltip, left: tooltip.x, top: tooltip.y }}>
              {tooltip.text}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
