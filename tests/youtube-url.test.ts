import { describe, expect, it } from "vitest";
import { ChannelInputError, channelRefToUrl, parseChannelInput, parseIsoDuration } from "../server/youtube-url.js";

describe("parseChannelInput", () => {
  it.each([
    ["https://www.youtube.com/@mkbhd", { type: "handle", value: "mkbhd" }],
    ["https://www.youtube.com/@mkbhd/videos", { type: "handle", value: "mkbhd" }],
    ["youtube.com/@mkbhd?si=abc", { type: "handle", value: "mkbhd" }],
    ["https://m.youtube.com/@some.name-1", { type: "handle", value: "some.name-1" }],
    ["@mkbhd", { type: "handle", value: "mkbhd" }],
    ["  @mkbhd  ", { type: "handle", value: "mkbhd" }],
    ["https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ", { type: "id", value: "UCBJycsmduvYEL83R_U4JriQ" }],
    ["UCBJycsmduvYEL83R_U4JriQ", { type: "id", value: "UCBJycsmduvYEL83R_U4JriQ" }],
    ["https://www.youtube.com/user/marquesbrownlee", { type: "username", value: "marquesbrownlee" }],
    ["https://www.youtube.com/c/LinusTechTips/featured", { type: "custom", value: "LinusTechTips" }],
    ["https://www.youtube.com/LinusTechTips", { type: "custom", value: "LinusTechTips" }],
  ])("parses %s", (input, expected) => {
    expect(parseChannelInput(input)).toEqual(expected);
  });

  it.each([
    "",
    "https://example.com/@mkbhd",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/abc",
    "https://www.youtube.com/",
    "@a",
  ])("rejects %j", (input) => {
    expect(() => parseChannelInput(input)).toThrow(ChannelInputError);
  });

  it("builds canonical URLs", () => {
    expect(channelRefToUrl({ type: "handle", value: "x_y" })).toBe("https://www.youtube.com/@x_y");
    expect(channelRefToUrl({ type: "id", value: "UC1" })).toBe("https://www.youtube.com/channel/UC1");
  });
});

describe("parseIsoDuration", () => {
  it("parses durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1M")).toBe(86460);
    expect(parseIsoDuration("garbage")).toBeUndefined();
    expect(parseIsoDuration(undefined)).toBeUndefined();
  });
});
