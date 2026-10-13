/** Original-recording offsets in seconds; edit order is the array order. */
export type ScreeningMediaSegment = {
  startSeconds: number;
  endSeconds: number;
  muted: boolean;
};

/** Provider observations, not interpolated or forced-alignment timestamps. */
export type ScreeningAlignedWord = {
  word: string;
  start: number;
  end: number;
};

export type ScreeningTranscriptToken = {
  text: string;
  startSeconds: number | null;
  endSeconds: number | null;
};

export type ScreeningAlignedTurn = {
  id: string;
  tokens: ScreeningTranscriptToken[];
};

export type ScreeningMediaProcessorStatus = {
  clipping: { available: boolean; missing: string[] };
  alignment: { available: boolean; missing: string[]; model: string };
};
