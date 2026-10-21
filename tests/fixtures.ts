/** Small PCM WAVs with real RIFF INFO tags; no downloaded or copyrighted music. */
export function wavFixture({
  title = "Evening light",
  artist = "Test artist",
  album = "Test album",
  seconds = 2,
}: {
  title?: string;
  artist?: string;
  album?: string;
  seconds?: number;
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
  const body = Buffer.concat([
    Buffer.from("WAVE"),
    chunk("fmt ", fmt),
    chunk("LIST", info),
    chunk("data", Buffer.alloc(seconds * 16000)),
  ]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
