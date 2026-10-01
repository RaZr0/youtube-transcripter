import type { TranscriptSegment } from "./types.js";

/** A caption format as listed by yt-dlp in `subtitles` / `automatic_captions`. */
export interface CaptionFormat {
  ext: string;
  url: string;
  name?: string;
}

export type CaptionTracks = Record<string, CaptionFormat[]>;

export interface CaptionChoice {
  /** The key in yt-dlp's subtitle dict (e.g. "en", "en-US", "de-orig"). */
  key: string;
  /** Language code with any "-orig" suffix removed. */
  lang: string;
  /** true = YouTube's automatic (speech-recognition) captions. */
  auto: boolean;
  format: CaptionFormat;
}

/** Formats we can parse, best first. json3 keeps auto-captions free of the rolling duplicates VTT has. */
const FORMAT_PREFERENCE = ["json3", "vtt"];

/**
 * Picks the best caption track for a video:
 *   1. human-made captions in the preferred (or the video's original) language,
 *   2. automatic captions in that language — the "-orig" track, not a machine translation,
 *   3. any human-made captions, then automatic captions in the original language.
 */
export function pickCaptionTrack(
  info: { subtitles?: CaptionTracks | null; automatic_captions?: CaptionTracks | null; language?: string | null },
  preferredLang?: string,
): CaptionChoice | null {
  const manual = Object.fromEntries(Object.entries(info.subtitles ?? {}).filter(([key]) => key !== "live_chat"));
  const auto = info.automatic_captions ?? {};
  const original = info.language ?? undefined;

  const candidates: [CaptionTracks, string | undefined, boolean][] = [];
  for (const lang of [preferredLang, original]) {
    if (!lang) continue;
    candidates.push([manual, lang, false]);
    candidates.push([manual, Object.keys(manual).find((k) => k.startsWith(`${lang}-`)), false]);
    candidates.push([auto, `${lang}-orig`, true]);
    candidates.push([auto, lang, true]);
  }
  candidates.push([auto, Object.keys(auto).find((k) => k.endsWith("-orig")), true]);
  candidates.push([manual, Object.keys(manual)[0], false]);
  candidates.push([auto, "en", true]);

  for (const [tracks, key, isAuto] of candidates) {
    if (!key || !tracks[key]) continue;
    const format = FORMAT_PREFERENCE.map((ext) => tracks[key].find((f) => f.ext === ext)).find(Boolean);
    if (format) return { key, lang: key.replace(/-orig$/, ""), auto: isAuto, format };
  }
  return null;
}

/** Languages that have real (not machine-translated) captions. */
export function captionLanguages(info: { subtitles?: CaptionTracks | null; automatic_captions?: CaptionTracks | null }) {
  const langs = new Set(Object.keys(info.subtitles ?? {}).filter((k) => k !== "live_chat"));
  for (const key of Object.keys(info.automatic_captions ?? {})) if (key.endsWith("-orig")) langs.add(key.replace(/-orig$/, ""));
  return [...langs];
}

export function parseCaptions(body: string, ext: string): TranscriptSegment[] {
  return ext === "json3" ? parseJson3(body) : parseVtt(body);
}

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string }[] }[];
}

export function parseJson3(body: string): TranscriptSegment[] {
  const data = JSON.parse(body) as Json3;
  const segments: TranscriptSegment[] = [];
  for (const event of data.events ?? []) {
    if (!event.segs) continue;
    const text = clean(event.segs.map((s) => s.utf8 ?? "").join(""));
    if (!text) continue;
    segments.push({ start: (event.tStartMs ?? 0) / 1000, duration: (event.dDurationMs ?? 0) / 1000, text });
  }
  return segments;
}

/**
 * WebVTT parser. YouTube's automatic captions in VTT repeat the previous line in every cue
 * (a "rolling" display), so lines identical to the previously emitted one are dropped.
 */
export function parseVtt(body: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let last = "";
  for (const block of body.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((l) => l.includes("-->"));
    if (timingIndex === -1) continue;
    const [from, to] = lines[timingIndex].split("-->").map((t) => parseTimestamp(t.trim().split(/\s+/)[0]));
    for (const raw of lines.slice(timingIndex + 1)) {
      const text = clean(decodeEntities(raw.replace(/<[^>]*>/g, "")));
      if (!text || text === last) continue;
      last = text;
      segments.push({ start: from, duration: Math.max(0, to - from), text });
    }
  }
  return segments;
}

function parseTimestamp(value: string): number {
  const parts = value.split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
