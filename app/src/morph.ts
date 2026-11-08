/**
 * Globe <-> flat map "unwrap" animation.
 *
 * MapLibre can blend projections (a zoom-interpolated `type` expression),
 * but deck.gl only knows the two end states: its overlay throws on a blended
 * projection, and a deck layer drawn mid-blend would sit in the wrong place.
 * So for the length of the morph the deck layers step aside and a snapshot of
 * the current frame, colorized on the CPU and warped to Mercator rows, rides
 * along as a MapLibre image layer that MapLibre bends with the basemap.
 */
import type maplibregl from "maplibre-gl";
import * as zarr from "zarrita";
import type { Catalog, Variable } from "./catalog.js";
import type { ColormapName } from "./colormaps.js";
import { COLORMAP_INDEX } from "./colormaps.js";
import { cellAt } from "./probe.js";

const MAX_LAT = 85.0511287798066; // Web Mercator's square-world latitude
const SNAP_ID = "morph-snapshot";
const DURATION_MS = 1600;

export type SnapshotStyle = {
  sprite: ImageData;
  cmap: ColormapName;
  reversed: boolean;
  vmin: number;
  vmax: number;
};

/**
 * The shown year at 2x (0.5°), colorized and resampled onto a Mercator grid.
 * The 2x chunk is usually already in the store cache from the detail layer.
 */
export async function snapshot(
  store: zarr.Readable,
  catalog: Catalog,
  v: Variable,
  yearIdx: number,
  style: SnapshotStyle,
): Promise<HTMLCanvasElement> {
  const level = "2x" in v.arrays ? "2x" : ".";
  const factor = level === "2x" ? 2 : 1;
  const path = level === "." ? `${v.path}/${v.name}` : `${v.path}/${level}/${v.name}`;
  const arr = await zarr.open(zarr.root(store).resolve(path), { kind: "array" });
  if (!arr.is("float32")) throw new Error(`${v.path}: expected float32`);
  const sel = arr.shape.length === 3 ? [yearIdx, null, null] : [null, null];
  const chunk = await zarr.get(arr, sel);
  const [, nx] = chunk.shape.slice(-2) as [number, number];

  const W = 1440;
  const H = 1440;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const row0 = COLORMAP_INDEX[style.cmap] * 256 * 4;
  const span = style.vmax - style.vmin || 1;
  // source column per output column (independent of row)
  const cols = new Int32Array(W);
  for (let x = 0; x < W; x++) cols[x] = cellAt(catalog, -180 + ((x + 0.5) * 360) / W, 0, factor)!.col;
  for (let y = 0; y < H; y++) {
    const merc = 1 - (2 * (y + 0.5)) / H;
    const lat = (Math.atan(Math.sinh(Math.PI * merc)) * 180) / Math.PI;
    const cell = cellAt(catalog, 0, lat, factor);
    if (!cell) continue;
    const base = cell.row * nx;
    for (let x = 0; x < W; x++) {
      const val = chunk.data[base + cols[x]!]!;
      if (Number.isNaN(val)) continue;
      let i = Math.round(((val - style.vmin) / span) * 255);
      i = Math.max(0, Math.min(255, i));
      if (style.reversed) i = 255 - i;
      const src = row0 + i * 4;
      const dst = (y * W + x) * 4;
      img.data[dst] = style.sprite.data[src]!;
      img.data[dst + 1] = style.sprite.data[src + 1]!;
      img.data[dst + 2] = style.sprite.data[src + 2]!;
      img.data[dst + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Zoom at which the whole Mercator world spans ~94% of the map's width. */
export function fitWorldZoom(map: maplibregl.Map): number {
  return Math.log2((map.getCanvas().clientWidth * 0.94) / 512);
}

type MorphArgs = {
  map: maplibregl.Map;
  toFlat: boolean;
  frame: HTMLCanvasElement | null;
  opacity: number;
  beforeId: string | undefined;
  /** 0 = globe, 1 = flat; called every frame (e.g. to fade the globe halo) */
  onProgress?: (flatness: number) => void;
};

/** Run the unwrap (or wrap) animation; resolves when the map is in its new projection. */
export function morph({ map, toFlat, frame, opacity, beforeId, onProgress }: MorphArgs): Promise<void> {
  if (frame) {
    map.addSource(SNAP_ID, {
      type: "image",
      url: frame.toDataURL(),
      coordinates: [
        [-180, MAX_LAT],
        [180, MAX_LAT],
        [180, -MAX_LAT],
        [-180, -MAX_LAT],
      ],
    });
    map.addLayer(
      { id: SNAP_ID, type: "raster", source: SNAP_ID, paint: { "raster-opacity": opacity, "raster-fade-duration": 0 } },
      beforeId,
    );
  }
  // deck's overlay reads map.getProjection() on every event and throws on a
  // blended one; report the start state until the morph lands
  const real = map.getProjection.bind(map);
  const start = real();
  map.getProjection = () => start;

  const c = map.getCenter();
  const from = { zoom: map.getZoom(), lat: c.lat };
  const to = toFlat ? { zoom: fitWorldZoom(map), lat: 0 } : { zoom: 2.05, lat: 20 };
  if (toFlat) map.setRenderWorldCopies(false);
  const sky = map.getSky();

  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now: number) => {
      // rAF timestamps can predate t0 by a frame: clamp to [0, 1]
      const k = ease(Math.max(0, Math.min(1, (now - t0) / DURATION_MS)));
      const flat = toFlat ? k : 1 - k;
      map.jumpTo({ zoom: from.zoom + (to.zoom - from.zoom) * k, center: [c.lng, from.lat + (to.lat - from.lat) * k] });
      // MapLibre blends projections through a zoom interpolation, so place the
      // two stops around the current zoom such that the blend there is `flat`
      const z = map.getZoom();
      map.setProjection({
        type: ["interpolate", ["linear"], ["zoom"], z - flat, "vertical-perspective", z + 1 - flat, "mercator"],
      });
      // the atmosphere rim is drawn for a sphere: fade it out as the sphere flattens
      if (sky) map.setSky({ ...sky, "atmosphere-blend": Math.max(0, 1 - 4 * flat) });
      onProgress?.(flat);
      if (k < 1) {
        requestAnimationFrame(step);
        return;
      }
      if (toFlat) {
        map.setProjection({ type: "mercator" });
      } else {
        // MapLibre skips setProjection when the current projection's name
        // matches the new type, and the blend expressions above already made a
        // projection named "globe", so {type: "globe"} alone would keep the
        // last frame's expression (Mercator just above this zoom: zooming in
        // then hands deck.gl Mercator clip planes and the globe gets clipped).
        // A different type first forces a fresh globe with its default spec.
        map.setProjection({ type: "vertical-perspective" });
        map.setProjection({ type: "globe" });
      }
      map.getProjection = real;
      if (sky) map.setSky(sky);
      if (!toFlat) map.setRenderWorldCopies(true);
      resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Drop the snapshot once deck has had a moment to draw over it. */
export function clearSnapshot(map: maplibregl.Map, delayMs = 700) {
  window.setTimeout(() => {
    if (map.getLayer(SNAP_ID)) map.removeLayer(SNAP_ID);
    if (map.getSource(SNAP_ID)) map.removeSource(SNAP_ID);
  }, delayMs);
}
