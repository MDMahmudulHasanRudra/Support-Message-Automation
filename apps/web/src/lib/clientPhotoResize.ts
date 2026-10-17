/** Shrinks a chosen picture to a ≤256 px WebP in the browser (also dropping its metadata). The server checks it again. */
export async function shrinkPicture(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(16, Math.round(bitmap.width * scale));
  canvas.height = Math.max(16, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob) throw new Error("This browser could not resize the picture.");
  return new File([blob], "photo.webp", { type: "image/webp" });
}

