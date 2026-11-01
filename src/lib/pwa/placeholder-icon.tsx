import { ImageResponse } from "next/og";

import { THEME_COLOR } from "./constants";

/** Renders the brass d20 artwork at each installable icon size. */
export function renderPlaceholderIcon(size: number): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: THEME_COLOR,
        }}
      >
        <svg width={size} height={size} viewBox="0 0 512 512">
          <circle cx="256" cy="256" r="196" fill="#19242e" />
          <path d="m256 94 142 82v160l-142 82-142-82V176L256 94Z" fill="#24333f" stroke="#d8b77a" strokeWidth="9" strokeLinejoin="round" />
          <path d="m256 94-82 230h164L256 94Z" fill="#19242e" stroke="#d8b77a" strokeWidth="9" strokeLinejoin="round" />
          <path d="m114 176 60 148-60 12m284-160-60 148 60 12M174 324l82 94 82-94M114 176h284" fill="none" stroke="#d8b77a" strokeWidth="9" strokeLinejoin="round" />
          <path d="m256 221 8 21 22 8-22 8-8 21-8-21-22-8 22-8Z" fill="#f2ede3" />
        </svg>
      </div>
    ),
    { width: size, height: size },
  );
}
