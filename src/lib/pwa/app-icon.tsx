import { ImageResponse } from "next/og";

import { BACKGROUND_COLOR } from "./constants";

/** Base64 SVG of the app icon art (same artwork as public/icons/icon.svg). */
const APP_ICON_SVG_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiB2aWV3Qm94PSIwIDAgNTEyIDUxMiI+PHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIGZpbGw9IiMxYzE1MTEiLz48cGF0aCBkPSJNMTY0IDcydjU0bTE4NC01NHY1NCIgc3Ryb2tlPSIjYTU4NDUwIiBzdHJva2Utd2lkdGg9IjE0Ii8+PHBhdGggZD0iTTI1NiAxMDdjLTU0IDAtNjcgMzAtMTE2IDMwSDg2djI0MWg1NGM0OSAwIDYyIDI3IDExNiAyN3M2Ny0yNyAxMTYtMjdoNTRWMTM3aC01NGMtNDkgMC02Mi0zMC0xMTYtMzBaIiBmaWxsPSIjMzgyOTFlIiBzdHJva2U9IiNlNmJjNzUiIHN0cm9rZS13aWR0aD0iOCIvPjxwYXRoIGQ9Im0yNTYgMTYwIDgzIDQ4djk2bC04MyA0OC04My00OHYtOTZaIiBmaWxsPSIjMjExODEyIiBzdHJva2U9IiNlNmJjNzUiIHN0cm9rZS13aWR0aD0iNyIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjxwYXRoIGQ9Im0yNTYgMTYwLTQ4IDEyOGg5NmwtNDgtMTI4Wm0tODMgNDggMzUgODAtMzUgMTZtMTY2LTk2LTM1IDgwIDM1IDE2bS0xMzEtMTYgNDggNjQgNDgtNjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2U2YmM3NSIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PHBhdGggZD0ibTI1NiAyMjkgNyAxOCAxOSA3LTE5IDctNyAxOC03LTE4LTE5LTcgMTktN1oiIGZpbGw9IiNmNWVhZDUiLz48ZyBmaWxsPSIjZTZiYzc1Ij48Y2lyY2xlIGN4PSIxMDkiIGN5PSIxNjEiIHI9IjUiLz48Y2lyY2xlIGN4PSI0MDMiIGN5PSIxNjEiIHI9IjUiLz48Y2lyY2xlIGN4PSIxMDkiIGN5PSIzNTQiIHI9IjUiLz48Y2lyY2xlIGN4PSI0MDMiIGN5PSIzNTQiIHI9IjUiLz48L2c+PC9zdmc+";

/** Rasterizes the app icon art at the requested install-icon size. */
export function renderAppIcon(size: number): ImageResponse {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", background: BACKGROUND_COLOR }}>
      {/* Inline vector artwork, rasterized at the requested install-icon size. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img width={size} height={size} alt="" src={APP_ICON_SVG_DATA_URI} />
    </div>,
    { width: size, height: size },
  );
}
