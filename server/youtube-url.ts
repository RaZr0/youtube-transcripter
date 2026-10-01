export type ChannelRef =
  | { type: "id"; value: string }
  | { type: "handle"; value: string } // without the leading "@"
  | { type: "username"; value: string } // legacy /user/NAME
  | { type: "custom"; value: string }; // legacy /c/NAME

/** The user typed something that is not a channel URL; safe to show as-is. */
export class ChannelInputError extends Error {}

const CHANNEL_ID = /^UC[\w-]{22}$/;
const HANDLE = /^[\w.\-·]{3,100}$/u;

/**
 * Accepts anything a person is likely to paste for a channel:
 *   https://www.youtube.com/@mkbhd/videos, youtube.com/channel/UC..., /c/Name, /user/Name,
 *   m.youtube.com links, "@mkbhd", or a bare "UC..." channel id.
 */
export function parseChannelInput(raw: string): ChannelRef {
  const input = raw.trim();
  if (!input) throw new ChannelInputError("Please enter a YouTube channel URL");

  if (CHANNEL_ID.test(input)) return { type: "id", value: input };
  if (input.startsWith("@")) return handle(input.slice(1));

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ChannelInputError(`"${input}" is not a valid YouTube channel URL`);
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host !== "youtube.com") throw new ChannelInputError(`"${input}" is not a youtube.com channel URL`);

  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const [first, second] = parts;
  if (!first) throw new ChannelInputError("The URL does not point to a channel");

  if (first.startsWith("@")) return handle(first.slice(1));
  if (first === "channel" && second && CHANNEL_ID.test(second)) return { type: "id", value: second };
  if (first === "user" && second) return { type: "username", value: second };
  if (first === "c" && second) return { type: "custom", value: second };
  if (first === "watch" || first === "shorts" || first === "playlist" || first === "live") {
    throw new ChannelInputError("That is a video or playlist link — please paste the channel URL (e.g. https://www.youtube.com/@name)");
  }
  // youtube.com/SomeName also resolves to legacy custom URLs.
  if (parts.length >= 1 && HANDLE.test(first)) return { type: "custom", value: first };
  throw new ChannelInputError(`Could not find a channel in "${input}"`);
}

function handle(value: string): ChannelRef {
  if (!HANDLE.test(value)) throw new ChannelInputError(`"@${value}" is not a valid channel handle`);
  return { type: "handle", value };
}

/** A canonical URL that third-party APIs accept for this channel reference. */
export function channelRefToUrl(ref: ChannelRef): string {
  switch (ref.type) {
    case "id":
      return `https://www.youtube.com/channel/${ref.value}`;
    case "handle":
      return `https://www.youtube.com/@${ref.value}`;
    case "username":
      return `https://www.youtube.com/user/${ref.value}`;
    case "custom":
      return `https://www.youtube.com/c/${ref.value}`;
  }
}

/** Parses an ISO-8601 duration such as "PT1H2M3S" into seconds. */
export function parseIsoDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return undefined;
  const [, d, h, m, s] = match;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Math.round(Number(s ?? 0));
}
