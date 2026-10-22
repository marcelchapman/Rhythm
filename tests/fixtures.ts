/** Small PCM WAVs with real RIFF INFO tags; no downloaded or copyrighted music. */
export function wavFixture({
  title = "Evening light",
  artist = "Test artist",
  album = "Test album",
  seconds = 2,
  bpm,
  comments = "",
}: {
  title?: string;
  artist?: string;
  album?: string;
  seconds?: number;
  bpm?: number;
  comments?: string;
} = {}): Buffer {
  const chunk = (id: string, body: Buffer) => {
    const header = Buffer.alloc(8);
    header.write(id);
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([
      header,
      body,
      body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0),
    ]);
  };
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4);
  fmt.writeUInt32LE(16000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const info = Buffer.concat([
    Buffer.from("INFO"),
    ...Object.entries({
      INAM: title,
      IART: artist,
      IPRD: album,
      IGNR: "Ambient",
      ICRD: "2026",
    }).map(([id, value]) => chunk(id, Buffer.from(`${value}\0`))),
  ]);
  const frames: Buffer[] = [];
  const frame = (id: string, data: Buffer) => {
    const header = Buffer.alloc(10);
    header.write(id);
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  if (bpm !== undefined) frames.push(frame("TBPM", Buffer.from(`\0${bpm}`)));
  if (comments)
    frames.push(
      frame(
        "COMM",
        Buffer.concat([
          Buffer.from([0]),
          Buffer.from("eng\0"),
          Buffer.from(comments, "latin1"),
        ]),
      ),
    );
  const frameData = Buffer.concat(frames);
  const id3Header = Buffer.from([73, 68, 51, 3, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 4; i++)
    id3Header[9 - i] = (frameData.length >> (7 * i)) & 127;
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    chunk("fmt ", fmt),
    chunk("LIST", info),
    ...(frames.length
      ? [chunk("id3 ", Buffer.concat([id3Header, frameData]))]
      : []),
    chunk("data", Buffer.alloc(seconds * 16000)),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
