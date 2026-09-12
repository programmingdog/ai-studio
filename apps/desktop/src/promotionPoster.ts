export const PROMOTION_POSTER_COUNT = 8;
export const QR_PROMOTION_POSTER_COUNT = 4;
export const PROMOTION_QR_PROMPT = "扫描二维码下载注册";

type PosterQrRegion = {
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

// The four source posters use different canvas sizes and QR placeholders. These
// bounds follow the actual white rectangles in each source PNG, including their
// anti-aliased edge, instead of assuming one shared bottom offset.
export const PROMOTION_POSTER_QR_REGIONS: Record<number, PosterQrRegion> = {
  1: { sourceWidth: 1536, sourceHeight: 2736, x: 599, y: 2286, width: 338, height: 341 },
  2: { sourceWidth: 1584, sourceHeight: 2816, x: 581, y: 2256, width: 421, height: 425 },
  3: { sourceWidth: 1584, sourceHeight: 2816, x: 540, y: 2093, width: 503, height: 505 },
  4: { sourceWidth: 1536, sourceHeight: 2736, x: 499, y: 1962, width: 537, height: 540 },
};

export function promotionPosterHasQr(index: number): boolean {
  return Number.isInteger(index) && index >= 1 && index <= QR_PROMOTION_POSTER_COUNT;
}

export function promotionQrLayout(index: number, width: number, height: number) {
  const source = PROMOTION_POSTER_QR_REGIONS[index];
  if (!source) return undefined;

  const scaleX = width / source.sourceWidth;
  const scaleY = height / source.sourceHeight;
  const region = {
    x: Math.round(source.x * scaleX),
    y: Math.round(source.y * scaleY),
    width: Math.round(source.width * scaleX),
    height: Math.round(source.height * scaleY),
  };
  const shortestSide = Math.min(region.width, region.height);
  const outerPadding = Math.max(8, Math.round(shortestSide * 0.04));
  const textGap = Math.max(6, Math.round(shortestSide * 0.025));
  const fontSize = Math.max(14, Math.round(shortestSide * 0.065));
  const qrSize = Math.floor(Math.min(
    region.width - outerPadding * 2,
    region.height - outerPadding * 2 - textGap - fontSize,
  ));
  const qrX = region.x + Math.round((region.width - qrSize) / 2);
  const qrY = region.y + outerPadding;

  return {
    region,
    qr: { x: qrX, y: qrY, size: qrSize },
    text: {
      x: region.x + region.width / 2,
      y: qrY + qrSize + textGap + fontSize / 2,
      fontSize,
    },
  };
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("推广海报读取失败，请重新选择"));
    image.src = source;
  });
}

export async function renderPromotionPoster(source: string, qrCanvas: HTMLCanvasElement | null, posterIndex: number): Promise<string> {
  const poster = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = poster.naturalWidth;
  canvas.height = poster.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前设备无法生成推广海报");
  context.drawImage(poster, 0, 0);
  const layout = promotionQrLayout(posterIndex, canvas.width, canvas.height);
  if (layout) {
    if (!qrCanvas) throw new Error("推广二维码尚未生成，请稍后重试");
    context.imageSmoothingEnabled = false;
    context.drawImage(qrCanvas, layout.qr.x, layout.qr.y, layout.qr.size, layout.qr.size);
    context.imageSmoothingEnabled = true;
    context.fillStyle = "#171717";
    context.font = `600 ${layout.text.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(PROMOTION_QR_PROMPT, layout.text.x, layout.text.y, layout.region.width - 16);
  }
  return canvas.toDataURL("image/png");
}
