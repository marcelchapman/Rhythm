/** Main/domain capability selection; never selected by the renderer. */
import path from "node:path";
import { readdirSync } from "node:fs";
import {
  publicationNativeBinding,
  probePublicationSupport,
  type PublicationTarget,
  type PublicationFingerprint,
} from "./publication.js";

interface LocalMetadataBinding {
  metadataSupport(target: PublicationTarget): {
    status: "supported";
    filesystem: "apfs";
    ownershipEnabled: boolean;
  };
  writeMetadataInPlace(
    target: PublicationTarget & { expected: PublicationFingerprint },
    original: Buffer,
    candidate: Buffer,
  ): { status: "written"; identity: PublicationFingerprint };
}
const local = () =>
  publicationNativeBinding() as unknown as LocalMetadataBinding;

export function selectMetadataPublication(target: PublicationTarget) {
  if (process.platform === "darwin") {
    // No private probe files or cleanup on noowners. This only opens/validates.
    const capability = local().metadataSupport(structuredClone(target));
    if (!capability.ownershipEnabled) return "in-place" as const;
    const strong = probePublicationSupport(target);
    if (strong.status === "supported") return "staged" as const;
    // Never hide unfinished artifacts from an unsuccessful strong probe.
    if (
      readdirSync(path.dirname(path.join(target.root, target.relative))).some(
        (n) => n.startsWith(".rio-publication-"),
      )
    )
      throw new Error(
        "Resolve unfinished publication artifacts before editing.",
      );
    local().metadataSupport(structuredClone(target));
    return "in-place" as const;
  }
  const strong = probePublicationSupport(target);
  if (strong.status !== "supported")
    throw new Error(
      `Publication support unavailable: ${strong.reason ?? strong.status}`,
    );
  return "staged" as const;
}

export function publishMetadataInPlace(
  target: PublicationTarget & { expected: PublicationFingerprint },
  original: Uint8Array,
  candidate: Uint8Array,
) {
  return local().writeMetadataInPlace(
    structuredClone(target),
    Buffer.from(original),
    Buffer.from(candidate),
  );
}
