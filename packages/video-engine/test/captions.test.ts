import { describe, expect, it } from "vitest";
import { parseVtt } from "../src/captions.js";

describe("parseVtt", () => {
  it("parses cues into timestamped segments", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
Neuroplasticity is the brain's ability to change.

00:00:02.000 --> 00:00:05.000
It happens through learning and sleep.
`;
    const segs = parseVtt(vtt);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.startMs).toBe(0);
    expect(segs[0]!.text).toBe("Neuroplasticity is the brain's ability to change.");
    expect(segs[1]!.startMs).toBe(2000);
    expect(segs[1]!.index).toBe(1);
  });

  it("strips inline timing/style tags", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<00:00:01.500><c>hello</c> <00:00:02.000>world
`;
    const segs = parseVtt(vtt);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hello world");
  });

  it("collapses YouTube rolling-duplicate auto-caption lines", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
the brain

00:00:01.000 --> 00:00:02.000
the brain can

00:00:02.000 --> 00:00:03.000
the brain can rewire

00:00:03.000 --> 00:00:05.000
new sentence entirely
`;
    const segs = parseVtt(vtt);
    // The three rolling lines collapse to the final form; then a distinct line.
    expect(segs).toHaveLength(2);
    expect(segs[0]!.text).toBe("the brain can rewire");
    expect(segs[0]!.endMs).toBe(3000);
    expect(segs[1]!.text).toBe("new sentence entirely");
  });
});
