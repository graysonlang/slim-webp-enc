// Feature detection: prefer native canvas.toBlob('image/webp') where it
// actually produces WebP. Safari accepts the MIME type but silently falls
// back to PNG, so the resulting blob's type must be verified.

let cached: boolean | null = null;

/** True if the browser's canvas.toBlob natively produces image/webp. */
export async function hasNativeWebPEncoder(): Promise<boolean> {
  if (cached !== null) return cached;
  if (typeof document === "undefined") {
    cached = false;
    return cached;
  }
  cached = await new Promise<boolean>((resolve) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      canvas.toBlob((blob) => resolve(blob?.type === "image/webp"), "image/webp");
    } catch {
      resolve(false);
    }
  });
  return cached;
}
