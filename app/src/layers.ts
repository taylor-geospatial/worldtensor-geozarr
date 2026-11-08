import type { MinimalTileData, RenderTileResult } from "@developmentseed/deck.gl-raster";
import { Colormap, LinearRescale } from "@developmentseed/deck.gl-raster/gpu-modules";
import type { GetTileDataOptions } from "@developmentseed/deck.gl-zarr";
import { ZarrLayer, ZarrSource } from "@developmentseed/deck.gl-zarr";
import type { Texture } from "@luma.gl/core";
import * as zarr from "zarrita";
import type { Catalog, Variable } from "./catalog.js";
import { factorOf, levelsOf } from "./catalog.js";
import { SampleTexture2DArray } from "./gpu/sample-texture-2d-array.js";

export type TileData = MinimalTileData & { texture: Texture; depth: number };

/**
 * Overview (all years in one texture) uses 8x and coarser: for t2m the
 * all-years chunk is ~2.9 MB at 8x vs 11.5 MB at 4x (lossless). Detail uses
 * base + 2x, which are chunked one year at a time. On play, every year of 2x
 * is stacked into one texture and replaces the overview once loaded.
 */
const OVERVIEW_MIN_FACTOR = 8;
const DETAIL_MAX_FACTOR = 2;
const PLAYBACK_FACTOR = 2;

/**
 * GeoZarr (spatial: / proj: / multiscales) attrs for a subset of a variable's
 * pyramid, derived from the catalog. The store itself carries CF metadata
 * only, which deck.gl-zarr doesn't read.
 */
function geoZarrAttrs(catalog: Catalog, v: Variable, levels: string[]) {
  const { resolution: res, lat_first, lon_first } = catalog.grid;
  return {
    "spatial:dimensions": ["lat", "lon"],
    // affine gives cell centres
    "spatial:registration": "node",
    "proj:code": "EPSG:4326",
    multiscales: {
      layout: levels.map((level) => {
        const f = factorOf(level);
        const shape = v.arrays[level]!.shape;
        // first centre of a 2^k coarsened level = mean of the first f centres
        const off = ((f - 1) * res) / 2;
        return {
          asset: level === "." ? v.name : `${level}/${v.name}`,
          "spatial:transform": [res * f, 0, lon_first + off, 0, res * f, lat_first + off],
          "spatial:shape": shape.slice(-2),
        };
      }),
    },
  };
}

export type Sources = {
  /** coarse levels, every year in one texture (null for static variables) */
  overview: ZarrSource<"float32"> | null;
  /**
   * 2x only, every year stacked in one texture: 4x sharper than the overview
   * and what detail shows at globe zoom, but ~15x the bytes (86 one-year
   * chunks, 43 MB for t2m), so it is fetched in the background for the selected variable only, once
   * its paused view has loaded (or on play, if that comes first)
   */
  playback: ZarrSource<"float32"> | null;
  /** fine levels for static variables, or one year at a time */
  detail: ZarrSource<"float32">;
};

export async function openSources(
  store: zarr.AsyncReadable,
  catalog: Catalog,
  v: Variable,
): Promise<Sources> {
  const levels = levelsOf(v);
  const temporal = v.arrays["."]!.shape.length === 3;
  const open = async (lv: string[]) => {
    const src = await ZarrSource.open(store, {
      path: v.path,
      geoZarrMetadata: geoZarrAttrs(catalog, v, lv),
    });
    if (!src.is("float32")) throw new Error(`${v.path}: expected float32`);
    return src;
  };
  if (!temporal) return { overview: null, playback: null, detail: await open(levels) };
  const coarse = levels.filter((l) => factorOf(l) >= OVERVIEW_MIN_FACTOR);
  const fine = levels.filter((l) => factorOf(l) <= DETAIL_MAX_FACTOR);
  const mid = levels.filter((l) => factorOf(l) === PLAYBACK_FACTOR);
  const [overview, detail, playback] = await Promise.all([
    open(coarse),
    open(fine),
    mid.length ? open(mid) : Promise.resolve(null),
  ]);
  return { overview, playback, detail };
}

async function getTileData(
  arr: zarr.Array<"float32", zarr.Readable>,
  options: GetTileDataOptions,
): Promise<TileData> {
  const { device, sliceSpec, width, height, signal } = options;
  const chunk = await zarr.get(arr, sliceSpec, { signal });
  const depth = chunk.shape.length === 3 ? chunk.shape[0]! : 1;
  // overview tiles (every year, 8x+) are coarse: smooth them when the GPU can
  // filter float textures; detail tiles stay nearest so real pixels show
  const filter = depth > 1 && device.features.has("float32-filterable") ? "linear" : "nearest";
  const texture = device.createTexture({
    dimension: "2d-array",
    format: "r32float",
    width,
    height,
    depth,
    mipLevels: 1,
    data: chunk.data,
    sampler: {
      minFilter: filter,
      magFilter: filter,
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    },
  });
  return { texture, depth, width, height, byteLength: chunk.data.byteLength };
}

export type Style = {
  colormapTexture: Texture;
  colormapIndex: number;
  reversed: boolean;
  vmin: number;
  vmax: number;
  opacity: number;
};

function renderer(style: Style, layerIndex: number) {
  return (data: TileData): RenderTileResult => ({
    renderPipeline: [
      {
        module: SampleTexture2DArray,
        props: { dataTex: data.texture, layerIndex: Math.min(layerIndex, data.depth - 1) },
      },
      { module: LinearRescale, props: { rescaleMin: style.vmin, rescaleMax: style.vmax } },
      {
        module: Colormap,
        props: {
          colormapTexture: style.colormapTexture,
          colormapIndex: style.colormapIndex,
          reversed: style.reversed,
        },
      },
    ],
  });
}

type BuildArgs = {
  sources: Sources;
  variable: Variable;
  style: Style;
  /** index into the variable's years shown by the overview (instant) */
  yearIdx: number;
  /** year index the detail layer fetches; frozen while it is hidden */
  detailYearIdx: number;
  /** false while playing/scrubbing: overview only, no fetches */
  showDetail: boolean;
  /**
   * true once the detail layer has loaded the viewport. The overview is then
   * hidden: where detail is NaN (water) it would otherwise show through, and a
   * coastal 8x cell averages its land part into a smear over the sea.
   */
  detailCovered: boolean;
  /** detail tiles for the current viewport finished loading */
  onDetailLoad: () => void;
  /** fetch the 2x playback stack (the selected variable has loaded, or play was pressed) */
  wantPlayback: boolean;
  /** the 2x playback stack has loaded and replaces the overview */
  playbackReady: boolean;
  onPlaybackLoad: () => void;
  beforeId?: string;
};

export function buildLayers(a: BuildArgs) {
  const { sources, variable: v, style } = a;
  const common = {
    getTileData,
    onTileUnload: (tile: { content?: TileData | null }) => tile.content?.texture.destroy(),
    opacity: style.opacity,
    // The raster mesh is coplanar with the globe basemap, so skip the depth
    // compare and rely on face culling to hide the far hemisphere. Our grid is
    // stored south-up (lat ascending, affine e > 0), which mirrors the mesh
    // winding, so the *front* faces are the far side: cull those instead of
    // GlobeView's default back faces. Culling back faces here draws the far
    // hemisphere through the globe, mirrored (looks like a 180° lon shift).
    parameters: { depthCompare: "always" as const, cullMode: "front" as const },
    beforeId: a.beforeId,
    debug: new URLSearchParams(location.search).has("debug"),
  };
  const styleKey = [style.colormapIndex, style.reversed, style.vmin, style.vmax];
  const layers = [];
  const coarseHidden = a.showDetail && a.detailCovered;
  const usePlayback = a.wantPlayback && a.playbackReady && sources.playback !== null;
  if (sources.playback && a.wantPlayback) {
    // added (and fetching) while hidden; shown once its tile has loaded
    layers.push(
      new ZarrLayer<TileData, "float32">({
        ...common,
        id: `pb:${v.path}`,
        source: sources.playback,
        selection: { time: null },
        visible: usePlayback && !coarseHidden,
        onViewportLoad: a.onPlaybackLoad,
        renderTile: renderer(style, a.yearIdx),
        updateTriggers: { renderTile: [a.yearIdx, ...styleKey] },
      }),
    );
  }
  if (sources.overview) {
    layers.push(
      new ZarrLayer<TileData, "float32">({
        ...common,
        id: `ov:${v.path}`,
        source: sources.overview,
        selection: { time: null },
        visible: !usePlayback && !coarseHidden,
        renderTile: renderer(style, a.yearIdx),
        updateTriggers: { renderTile: [a.yearIdx, ...styleKey] },
      }),
    );
  }
  const temporal = sources.overview !== null;
  layers.push(
    new ZarrLayer<TileData, "float32">({
      ...common,
      id: `dt:${v.path}`,
      source: sources.detail,
      // a changed selection refetches every tile, even on a hidden layer, so
      // it only moves once the year settles
      selection: temporal ? { time: a.detailYearIdx } : {},
      visible: !temporal || a.showDetail,
      onViewportLoad: a.onDetailLoad,
      renderTile: renderer(style, 0),
      updateTriggers: { renderTile: styleKey },
    }),
  );
  return layers;
}
