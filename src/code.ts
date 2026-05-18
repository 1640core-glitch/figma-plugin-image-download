import type { PluginToUiMessage, UiToPluginMessage } from './messages';

figma.showUI(__html__, { width: 360, height: 420, title: 'Image Download' });

function postToUi(msg: PluginToUiMessage): void {
  figma.ui.postMessage(msg);
}

function getSelectedFrames(): SceneNode[] {
  const frames: SceneNode[] = [];
  for (const n of figma.currentPage.selection) {
    if (
      n.type === 'FRAME' ||
      n.type === 'COMPONENT' ||
      n.type === 'INSTANCE' ||
      n.type === 'COMPONENT_SET' ||
      n.type === 'SECTION' ||
      n.type === 'GROUP' ||
      typeof (n as unknown as { exportAsync?: unknown }).exportAsync === 'function'
    ) {
      frames.push(n);
    }
  }
  return frames;
}

function sendSelectionInfo(): void {
  const frames = getSelectedFrames();
  if (frames.length > 0) {
    const names: string[] = [];
    for (const f of frames) names.push(f.name);
    postToUi({ type: 'selection', count: frames.length, names: names });
  } else {
    postToUi({ type: 'no-selection' });
  }
}

sendSelectionInfo();
figma.on('selectionchange', sendSelectionInfo);

interface ImageInfo {
  hash: string;
  nodeName: string;
  frameName: string;
}

// getBytesAsync 並列度上限。Figma plugin host の負荷を考慮し 3〜5 の範囲で 4 に固定。
const FETCH_CONCURRENCY = 4;

let cancelRequested = false;

function collectImageFills(node: SceneNode, frameName: string, result: ImageInfo[]): void {
  if (cancelRequested) return;
  if (!node.visible) return;

  if ('fills' in node) {
    const fills = (node as GeometryMixin).fills;
    if (Array.isArray(fills)) {
      for (const fill of fills) {
        if (fill.type === 'IMAGE' && fill.visible !== false) {
          const imgFill = fill as ImagePaint;
          if (imgFill.imageHash) {
            result.push({
              hash: imgFill.imageHash,
              nodeName: node.name,
              frameName: frameName,
            });
          }
        }
      }
    }
  }

  if ('children' in node) {
    const children = (node as FrameNode).children;
    for (const child of children) {
      collectImageFills(child, frameName, result);
    }
  }
}

figma.ui.onmessage = async function (msg: UiToPluginMessage): Promise<void> {
  if (msg.type === 'cancel') {
    cancelRequested = true;
    return;
  }
  if (msg.type !== 'export-images') return;

  cancelRequested = false;
  const frames = getSelectedFrames();
  if (frames.length === 0) {
    postToUi({ type: 'error', message: 'レイヤーを選択してください' });
    return;
  }

  const dedup = msg.dedup !== false;

  try {
    postToUi({ type: 'phase', phase: 'collect', current: 0, total: frames.length });
    const allImages: ImageInfo[] = [];
    for (let fi = 0; fi < frames.length; fi++) {
      if (cancelRequested) {
        postToUi({ type: 'cancelled' });
        return;
      }
      collectImageFills(frames[fi], frames[fi].name, allImages);
      postToUi({
        type: 'phase',
        phase: 'collect',
        current: fi + 1,
        total: frames.length,
      });
    }
    if (cancelRequested) {
      postToUi({ type: 'cancelled' });
      return;
    }

    let uniqueImages: ImageInfo[];
    if (dedup) {
      const seenInFrame: Record<string, boolean> = {};
      uniqueImages = [];
      for (const item of allImages) {
        const key = item.frameName + '::' + item.hash;
        if (!seenInFrame[key]) {
          seenInFrame[key] = true;
          uniqueImages.push(item);
        }
      }
    } else {
      uniqueImages = allImages;
    }

    // 採用方針: (a) total を実送信件数に揃える。
    // getImageByHash が null を返すエントリを事前に除外し、
    // フィルタ後の件数を total として通知することで total と実 image-data 送信数を一致させる。
    const sendable: { info: ImageInfo; image: Image }[] = [];
    for (const info of uniqueImages) {
      const img = figma.getImageByHash(info.hash);
      if (img) {
        sendable.push({ info, image: img });
      }
    }

    postToUi({
      type: 'image-export-start',
      total: sendable.length,
    });

    // 既知 hash 早期スキップ: 同一 hash に対する getBytesAsync を 1 回に集約する。
    // COMPONENT_SET 等の走査で複数 ImageFill が同一 hash を共有するケースで getBytesAsync 自体を回避する。
    const hashImage: Record<string, Image> = {};
    const uniqueHashes: string[] = [];
    for (const entry of sendable) {
      const sh = entry.info.hash;
      if (!(sh in hashImage)) {
        hashImage[sh] = entry.image;
        uniqueHashes.push(sh);
      }
    }

    const hashBytes: Record<string, Uint8Array> = {};
    let nextFetchIdx = 0;
    let fetchError: unknown = null;

    async function fetchWorker(): Promise<void> {
      while (true) {
        if (cancelRequested || fetchError) return;
        const idx = nextFetchIdx++;
        if (idx >= uniqueHashes.length) return;
        const h = uniqueHashes[idx];
        try {
          hashBytes[h] = await hashImage[h].getBytesAsync();
        } catch (e) {
          fetchError = e;
          return;
        }
      }
    }

    const poolSize = Math.min(FETCH_CONCURRENCY, uniqueHashes.length);
    const fetchPool: Promise<void>[] = Array.from({ length: poolSize }, () => fetchWorker());
    await Promise.all(fetchPool);

    if (cancelRequested) {
      postToUi({ type: 'cancelled' });
      return;
    }
    if (fetchError) {
      throw fetchError;
    }

    for (let ii = 0; ii < sendable.length; ii++) {
      if (cancelRequested) {
        postToUi({ type: 'cancelled' });
        return;
      }
      const info = sendable[ii].info;
      postToUi({
        type: 'phase',
        phase: 'collect',
        current: ii + 1,
        total: sendable.length,
        nodeName: info.nodeName,
      });

      postToUi({
        type: 'image-data',
        data: hashBytes[info.hash],
        hash: info.hash,
        nodeName: info.nodeName,
        frameName: info.frameName,
      });
    }

    postToUi({ type: 'image-export-done' });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    postToUi({ type: 'error', message: errMsg });
  }
};
