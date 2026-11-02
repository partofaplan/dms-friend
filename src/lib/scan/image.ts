import {
  MAX_IMAGE_BASE64_LENGTH,
  SUPPORTED_IMAGE_TYPES,
  type ImageMimeType,
} from "@/lib/ai/contracts";

/*
 * Client-side helpers for the scan flow: check a picked file, read it as a
 * data URL, and optionally downscale it before upload. Limits come from the
 * shared extract contract so the client rejects exactly what the server would.
 */

export const ACCEPTED_IMAGE_TYPES = SUPPORTED_IMAGE_TYPES.join(",");

/**
 * Files larger than this aren't even read: well past what downscaling can
 * reasonably rescue, and reading them would stall a phone.
 */
export const MAX_SOURCE_FILE_BYTES = 40 * 1024 * 1024;

/** Longest side, in pixels, after downscaling. Plenty for reading a sheet. */
export const MAX_IMAGE_DIMENSION = 2048;

export type ImageCheck = { ok: true } | { ok: false; message: string };

export const UNSUPPORTED_TYPE_MESSAGE =
  "That file type isn't supported. Choose a PNG, JPEG, WebP, or GIF image.";
export const TOO_LARGE_MESSAGE =
  "That image is too large. Try a smaller photo or a lower camera resolution.";

export function isSupportedImageType(type: string): type is ImageMimeType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type);
}

/** Pre-read check of the picked file's type and size. */
export function checkImageFile(file: File): ImageCheck {
  if (!isSupportedImageType(file.type)) {
    return { ok: false, message: UNSUPPORTED_TYPE_MESSAGE };
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    return { ok: false, message: TOO_LARGE_MESSAGE };
  }
  return { ok: true };
}

/** Length of the base64 payload of a data URL (what the extract limit measures). */
export function base64Length(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? dataUrl.length : dataUrl.length - comma - 1;
}

/** Post-read check that the (possibly downscaled) image fits the extract limit. */
export function checkImageDataUrl(dataUrl: string): ImageCheck {
  return base64Length(dataUrl) > MAX_IMAGE_BASE64_LENGTH
    ? { ok: false, message: TOO_LARGE_MESSAGE }
    : { ok: true };
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read the image."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

/**
 * Shrinks an image so its longest side is at most `maxDimension`, preserving
 * aspect ratio, and re-encodes it as JPEG. Returns the original whenever
 * downscaling isn't needed, isn't possible, or wouldn't make it smaller.
 */
export async function downscaleImage(
  dataUrl: string,
  maxDimension = MAX_IMAGE_DIMENSION,
): Promise<string> {
  try {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const { naturalWidth: width, naturalHeight: height } = image;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    if (!(scale > 0) || scale === 1) return dataUrl;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    // JPEG has no alpha; paint transparent PNG/GIF areas white, not black.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const resized = canvas.toDataURL("image/jpeg", 0.85);
    return resized.startsWith("data:image/jpeg") && resized.length < dataUrl.length
      ? resized
      : dataUrl;
  } catch {
    return dataUrl;
  }
}
