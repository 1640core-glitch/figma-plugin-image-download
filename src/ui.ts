import JSZip from 'jszip';
import type { PhaseName, PluginToUiMessage, UiToPluginMessage } from './messages';

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Element not found: #' + id);
  return el as T;
}

const exportBtn = getEl<HTMLButtonElement>('export-btn');
const cancelBtn = getEl<HTMLButtonElement>('cancel-btn');
const statusEl = getEl<HTMLElement>('status');
const selectionInfoEl = getEl<HTMLElement>('selection-info');
const progressBar = getEl<HTMLElement>('progress-bar');
const progressBarFill = getEl<HTMLElement>('progress-bar-fill');
const phaseLabelEl = getEl<HTMLElement>('phase-label');
const qualityRow = getEl<HTMLElement>('quality-row');
const qualityInput = getEl<HTMLInputElement>('quality-input');
const qualityDisplay = getEl<HTMLElement>('quality-display');
const dedupCheckbox = getEl<HTMLInputElement>('dedup-checkbox');

function postToPlugin(msg: UiToPluginMessage): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

let statusTimeoutId: number | null = null;
function setStatus(text: string, color: string): void {
  if (statusTimeoutId !== null) {
    clearTimeout(statusTimeoutId);
    statusTimeoutId = null;
  }
  statusEl.textContent = text;
  statusEl.style.color = color;
}
function scheduleStatusClear(ms: number): void {
  if (statusTimeoutId !== null) clearTimeout(statusTimeoutId);
  statusTimeoutId = window.setTimeout(function () {
    statusEl.textContent = '';
    statusEl.style.color = '#aaaaaa';
    statusTimeoutId = null;
  }, ms);
}

function setPhase(phase: PhaseName | null, current: number, total: number): void {
  if (!phase) {
    phaseLabelEl.textContent = '';
    progressBarFill.style.width = '0%';
    return;
  }
  const label = phase === 'collect' ? '収集' : phase === 'convert' ? '変換' : 'zip 圧縮';
  phaseLabelEl.textContent = label + ' (' + current + '/' + total + ')';
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBarFill.style.width = pct + '%';
}

function resetUiToReady(): void {
  exportBtn.disabled = false;
  exportBtn.style.display = 'block';
  cancelBtn.style.display = 'none';
  progressBar.style.display = 'none';
  progressBarFill.style.width = '0%';
  phaseLabelEl.textContent = '';
}

let cancelRequested = false;

function getSelectedFormat(): 'original' | 'png' | 'jpg' {
  const radios = document.querySelectorAll('input[name="format"]') as NodeListOf<HTMLInputElement>;
  for (const radio of radios) {
    if (radio.checked) return radio.value as 'original' | 'png' | 'jpg';
  }
  return 'original';
}

document.querySelectorAll('input[name="format"]').forEach(function (radio) {
  (radio as HTMLInputElement).addEventListener('change', function () {
    qualityRow.style.display = getSelectedFormat() === 'jpg' ? 'flex' : 'none';
  });
});

qualityInput.addEventListener('input', function () {
  qualityDisplay.textContent = qualityInput.value;
});

exportBtn.addEventListener('click', function () {
  exportBtn.disabled = true;
  exportBtn.style.display = 'none';
  cancelBtn.style.display = 'block';
  cancelBtn.disabled = false;
  cancelRequested = false;
  setStatus('画像を収集中...', '#aaaaaa');
  progressBar.style.display = 'block';
  progressBarFill.style.width = '0%';
  phaseLabelEl.textContent = '';
  resetExportState();
  imageTotal = 0;
  currentFormat = getSelectedFormat();
  currentQuality = parseFloat(qualityInput.value);
  postToPlugin({ type: 'export-images', dedup: dedupCheckbox.checked });
});

cancelBtn.addEventListener('click', function () {
  cancelRequested = true;
  cancelBtn.disabled = true;
  setStatus('キャンセル中...', '#aaaaaa');
  postToPlugin({ type: 'cancel' });
});

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// convertImage 並列度上限。Canvas decode/encode の同時実行数を 3〜5 の範囲で 4 に固定。
const CONVERT_CONCURRENCY = 4;

let imageTotal = 0;
let currentFormat: 'original' | 'png' | 'jpg' = 'original';
let currentQuality = 0.8;

// ストリーム処理状態。image-data 受信ごとに dedup→assignFolderName→buildFileName→
// convertImage→addToZip を即時実行し、image-export-done で finalize する。
let zip: JSZip | null = null;
let seenHashes: Set<string> = new Set();
let folderImageCount: Record<string, number> = {};
let totalDigits = 1;
let convertedCount = 0;
let convertError: unknown = null;
let convertPromises: Promise<void>[] = [];
let semaphoreSlots = CONVERT_CONCURRENCY;
let semaphoreWaiters: Array<() => void> = [];
let firstFrameName: string | null = null;

function resetExportState(): void {
  zip = new JSZip();
  seenHashes = new Set();
  folderImageCount = {};
  totalDigits = 1;
  convertedCount = 0;
  convertError = null;
  convertPromises = [];
  semaphoreSlots = CONVERT_CONCURRENCY;
  semaphoreWaiters = [];
  firstFrameName = null;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function buildZipFileName(): string {
  const base = firstFrameName ? sanitizeFolderName(firstFrameName) : 'images';
  const d = new Date();
  const ts =
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '_' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds());
  return base + '_' + ts + '.zip';
}

function detectExtension(data: Uint8Array): string {
  if (
    data.length >= 4 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return '.png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return '.jpg';
  }
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38 &&
    (data[4] === 0x37 || data[4] === 0x39) &&
    data[5] === 0x61
  ) {
    return '.gif';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return '.webp';
  }
  let svgIdx = 0;
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    svgIdx = 3;
  }
  while (
    svgIdx < data.length &&
    (data[svgIdx] === 0x20 ||
      data[svgIdx] === 0x09 ||
      data[svgIdx] === 0x0a ||
      data[svgIdx] === 0x0d)
  ) {
    svgIdx++;
  }
  if (data.length - svgIdx >= 4) {
    const isSvgTag =
      data[svgIdx] === 0x3c &&
      data[svgIdx + 1] === 0x73 &&
      data[svgIdx + 2] === 0x76 &&
      data[svgIdx + 3] === 0x67;
    if (isSvgTag) return '.svg';
    const isXmlDecl =
      data.length - svgIdx >= 5 &&
      data[svgIdx] === 0x3c &&
      data[svgIdx + 1] === 0x3f &&
      data[svgIdx + 2] === 0x78 &&
      data[svgIdx + 3] === 0x6d &&
      data[svgIdx + 4] === 0x6c;
    if (isXmlDecl) {
      const limit = Math.min(data.length, svgIdx + 1024);
      for (let j = svgIdx; j < limit - 3; j++) {
        if (
          data[j] === 0x3c &&
          data[j + 1] === 0x73 &&
          data[j + 2] === 0x76 &&
          data[j + 3] === 0x67
        ) {
          return '.svg';
        }
      }
    }
  }
  return '.png';
}

function sanitizeFolderName(name: string): string {
  let cleaned = '';
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    // Unicode 制御文字除去 (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    cleaned += name.charAt(i);
  }
  // ファイルシステム禁止文字を _ に置換
  cleaned = cleaned.replace(/[\\/:*?"<>|]/g, '_');
  // 先頭末尾の空白・ドットを trim
  cleaned = cleaned.replace(/^[\s.]+|[\s.]+$/g, '');
  // 空フォルダ名フォールバック
  if (cleaned.length === 0) cleaned = 'untitled';
  // Windows 予約名は prefix 付与
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(cleaned)) {
    cleaned = '_' + cleaned;
  }
  // 255 byte 制限 (UTF-8)
  const encoder = new TextEncoder();
  let bytes = encoder.encode(cleaned);
  if (bytes.length > 255) {
    while (bytes.length > 255 && cleaned.length > 0) {
      cleaned = cleaned.slice(0, -1);
      bytes = encoder.encode(cleaned);
    }
    cleaned = cleaned.replace(/[\s.]+$/g, '');
    if (cleaned.length === 0) cleaned = 'untitled';
  }
  return cleaned;
}

async function convertImage(
  data: Uint8Array,
  format: 'original' | 'png' | 'jpg',
  quality: number
): Promise<Uint8Array> {
  if (format === 'original') {
    return data;
  }
  return new Promise(function (resolve, reject) {
    const blob = new Blob([data]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas context unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      canvas.toBlob(
        function (result) {
          if (!result) {
            reject(new Error('Canvas toBlob failed'));
            return;
          }
          result
            .arrayBuffer()
            .then(function (buf) {
              resolve(new Uint8Array(buf));
            })
            .catch(reject);
        },
        mimeType,
        quality
      );
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error('Image load failed'));
    };
    img.src = url;
  });
}

// dedup: 既送信ハッシュは重複扱いでスキップ。dedup 責務は code.ts 側 (#15) に統一されており、
// ui.ts ではフェイルセーフとして同一ハッシュの再投入を防ぐ。
function dedup(hash: string): boolean {
  if (!hash) return true;
  if (seenHashes.has(hash)) return false;
  seenHashes.add(hash);
  return true;
}

function assignFolderName(frameName: string): string {
  const folder = sanitizeFolderName(frameName);
  if (!(folder in folderImageCount)) {
    folderImageCount[folder] = 0;
  }
  folderImageCount[folder]++;
  return folder;
}

function buildFileName(folder: string, raw: Uint8Array): string {
  let ext: string;
  if (currentFormat === 'original') {
    ext = detectExtension(raw);
  } else if (currentFormat === 'png') {
    ext = '.png';
  } else {
    ext = '.jpg';
  }
  const num = String(folderImageCount[folder]).padStart(totalDigits, '0');
  return folder + '/' + folder + '-image_' + num + ext;
}

function addToZip(filePath: string, data: Uint8Array): void {
  if (zip) zip.file(filePath, data);
}

async function acquireSlot(): Promise<void> {
  if (semaphoreSlots > 0) {
    semaphoreSlots--;
    return;
  }
  await new Promise<void>(function (resolve) {
    semaphoreWaiters.push(resolve);
  });
}

function releaseSlot(): void {
  const w = semaphoreWaiters.shift();
  if (w) {
    w();
  } else {
    semaphoreSlots++;
  }
}

function scheduleConvert(raw: Uint8Array, filePath: string): void {
  const p = (async function () {
    await acquireSlot();
    try {
      if (cancelRequested || convertError) return;
      const out = await convertImage(raw, currentFormat, currentQuality);
      if (cancelRequested || convertError) return;
      addToZip(filePath, out);
      convertedCount++;
      setPhase('convert', convertedCount, imageTotal);
    } catch (e) {
      convertError = e;
    } finally {
      releaseSlot();
    }
  })();
  convertPromises.push(p);
}

function handleImageData(msg: Extract<PluginToUiMessage, { type: 'image-data' }>): void {
  if (cancelRequested || convertError) return;
  if (!dedup(msg.hash)) return;
  const raw: Uint8Array =
    msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data);
  if (firstFrameName === null) firstFrameName = msg.frameName;
  const folder = assignFolderName(msg.frameName);
  const filePath = buildFileName(folder, raw);
  scheduleConvert(raw, filePath);
}

async function finalize(): Promise<void> {
  if (imageTotal === 0 && convertPromises.length === 0) {
    setStatus('画像が見つかりませんでした', '#ff8080');
    resetUiToReady();
    return;
  }

  setStatus('画像を変換中...', '#aaaaaa');
  setPhase('convert', convertedCount, imageTotal);

  await Promise.all(convertPromises);

  if (cancelRequested) {
    setStatus('キャンセルされました', '#ff8080');
    resetUiToReady();
    scheduleStatusClear(5000);
    return;
  }
  if (convertError) {
    throw convertError;
  }

  setStatus('ZIPを圧縮中...', '#aaaaaa');
  setPhase('zip', 0, 100);
  const content = await zip!.generateAsync({ type: 'blob' }, function (metadata) {
    setPhase('zip', Math.round(metadata.percent), 100);
  });
  downloadBlob(content, buildZipFileName());

  setStatus(convertedCount + '個の画像をZIPで書き出し完了', '#80ff80');
  resetUiToReady();
  scheduleStatusClear(5000);
}

window.addEventListener('message', function (event: MessageEvent) {
  // origin/source 防御チェック: Figma プラグイン UI は親 window (Figma host) からの postMessage のみ受理する。
  // サンドボックス iframe (srcdoc) では event.origin が 'null' になるため、source の同一性で判定する。
  if (event.source !== window.parent) return;
  const data = event.data as { pluginMessage?: PluginToUiMessage } | null;
  const msg = data && data.pluginMessage;
  if (!msg) return;

  switch (msg.type) {
    case 'selection': {
      if (msg.count === 1) {
        selectionInfoEl.textContent = msg.names[0];
      } else {
        selectionInfoEl.textContent = msg.count + '個のレイヤーを選択中';
      }
      selectionInfoEl.style.color = '#ffffff';
      exportBtn.disabled = false;
      break;
    }
    case 'no-selection':
      selectionInfoEl.textContent = 'レイヤーを選択してください';
      selectionInfoEl.style.color = '#888888';
      exportBtn.disabled = true;
      break;
    case 'phase': {
      setPhase(msg.phase, msg.current, msg.total);
      if (msg.phase === 'collect') {
        const label = msg.nodeName ? '画像取得中: ' + msg.nodeName : '画像を収集中...';
        setStatus(label, '#aaaaaa');
      }
      break;
    }
    case 'cancelled':
      setStatus('キャンセルされました', '#ff8080');
      resetUiToReady();
      resetExportState();
      imageTotal = 0;
      scheduleStatusClear(5000);
      break;
    case 'error':
      setStatus(msg.message, '#ff8080');
      resetUiToReady();
      break;
    case 'image-export-start':
      resetExportState();
      imageTotal = msg.total;
      totalDigits = String(Math.max(imageTotal, 1)).length;
      if (imageTotal === 0) {
        setStatus('画像が見つかりませんでした', '#ff8080');
        resetUiToReady();
      }
      break;
    case 'image-data':
      handleImageData(msg);
      break;
    case 'image-export-done':
      finalize().catch(function (err) {
        setStatus(err instanceof Error ? err.message : String(err), '#ff8080');
        resetUiToReady();
        resetExportState();
      });
      break;
  }
});
