export type PhaseName = 'collect' | 'convert' | 'zip';

export type PluginToUiMessage =
  | { type: 'selection'; count: number; names: string[] }
  | { type: 'no-selection' }
  | { type: 'phase'; phase: PhaseName; current: number; total: number; nodeName?: string }
  | { type: 'cancelled' }
  | { type: 'error'; message: string }
  | { type: 'image-export-start'; total: number }
  | { type: 'image-data'; data: Uint8Array; hash: string; nodeName: string; frameName: string }
  | { type: 'image-export-done' };

export type UiToPluginMessage =
  | { type: 'export-images'; dedup: boolean }
  | { type: 'cancel' };
