// Qualification child only. Caller supplies a disposable fixture, never a library.
import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { createPublicationAdapter } from "../src/domain/publication.ts";
const [config, candidateFile, manifest, phase] = process.argv.slice(2);
const binding = createRequire(import.meta.url)(
  "../dist/native/testing/publication.node",
);
const kill = () => process.kill(process.pid, "SIGKILL");
const exchange =
  phase === "before"
    ? (h) => binding.exchangeWithInterleave(h, kill)
    : phase === "after"
      ? (h) => binding.exchangeWithAfterInterleave(h, kill)
      : (h) => binding.exchange(h);
const api = createPublicationAdapter(
  Object.defineProperty(Object.create(binding), "exchange", {
    value: exchange,
  }),
);
const opened = api.openPublicationLease({
  ...JSON.parse(config),
  candidate: readFileSync(candidateFile),
});
if (opened.status !== "ready") throw Error(opened.reason);
writeFileSync(manifest, JSON.stringify(opened.lease.record), {
  flag: "wx",
  mode: 0o600,
});
const fd = openSync(manifest, "r");
fsyncSync(fd);
closeSync(fd);
if (phase === "prepared") kill();
const exchanged = opened.lease.exchangeAndObserve();
if (exchanged.status !== "exchanged-expected")
  throw Error(JSON.stringify(exchanged));
if (phase === "synced" && opened.lease.syncPublication().status !== "synced")
  throw Error("Sync failed");
kill();
