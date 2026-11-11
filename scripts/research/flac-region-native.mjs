// Builds disposable instrumentation/metadata-prefix variants of Rio's native
// publisher. Neither native/publication.cc nor dist/native is modified.
import { readFile, writeFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const replace = (s, a, b, n = 1) => {
  assert.equal(s.split(a).length - 1, n, `Native lab anchor: ${a}`);
  return s.split(a).join(b);
};
export async function buildResearchNative(repo, directory, prefixOnly) {
  let source = await readFile(path.join(repo, "native/publication.cc"), "utf8");
  source = replace(
    source,
    "namespace {",
    "namespace {\nthread_local size_t researchWritten = 0;",
  );
  source = replace(
    source,
    "  const char* stage;",
    "  const char* stage;\n  size_t researchStart = researchWritten;",
  );
  source = replace(
    source,
    '\\"flushes\\":%zu,',
    '\\"logicalWriteBytes\\":%zu,\\"flushes\\":%zu,',
  );
  source = replace(
    source,
    "bytes,flushes,fsyncMs",
    "bytes,researchWritten-researchStart,flushes,fsyncMs",
  );
  source = replace(
    source,
    'io(n>0,"Writing metadata in place");at+=size_t(n);',
    'io(n>0,"Writing metadata in place");researchWritten+=size_t(n);at+=size_t(n);',
  );
  // writeAll() is used for private candidate and independent rollback files.
  source = replace(
    source,
    'io(n>0,"Writing private artifact"); at+=size_t(n);',
    'io(n>0,"Writing private artifact"); researchWritten+=size_t(n); at+=size_t(n);',
  );
  if (prefixOnly) {
    source = replace(
      source,
      "napi_value writeMetadataInPlace(napi_env e,napi_callback_info info)",
      `
size_t researchAudioOffset(const uint8_t* bytes,size_t size) {
  if(size<42 || memcmp(bytes,"fLaC",4))fail("Research requires native FLAC");
  size_t at=4;
  for(size_t count=0;count<256;count++) {
    if(at+4>size)fail("Research truncated metadata header");
    auto type=bytes[at]&127; auto last=bytes[at]&128;
    size_t length=(size_t(bytes[at+1])<<16)|(size_t(bytes[at+2])<<8)|bytes[at+3];
    if(type>6 || ((count==0)!=(type==0)) || (type==0&&length!=34) || length>size-at-4)fail("Research unsafe metadata boundary");
    at+=4+length;
    if(last) {if(at>=size)fail("Research missing audio");return at;}
  }
  fail("Research metadata block budget exceeded");
}
napi_value writeMetadataInPlace(napi_env e,napi_callback_info info)`,
    );
    source = replace(
      source,
      "    size_t at=0;\n    while(at<candidateSize) {",
      `
    const auto originalOffset=researchAudioOffset(static_cast<uint8_t*>(original),originalSize);
    const auto candidateOffset=researchAudioOffset(static_cast<uint8_t*>(candidate),candidateSize);
    const bool prefix = originalOffset==candidateOffset && originalSize==candidateSize;
    if(prefix && memcmp(static_cast<uint8_t*>(original)+originalOffset,static_cast<uint8_t*>(candidate)+candidateOffset,originalSize-originalOffset))fail("Research suffix changed");
    const size_t writeLimit=prefix?candidateOffset:candidateSize;
    const char* fault=std::getenv("RIO_RESEARCH_FAULT");
    size_t at=0;
    while(at<writeLimit) {`,
    );
    source = replace(
      source,
      "auto length=std::min(size_t(64*1024),candidateSize-at);",
      'auto length=std::min(size_t(64*1024),writeLimit-at);\n      if(fault && std::strcmp(fault,"during-region")==0 && at==0) {size_t changed=0;while(changed<writeLimit && static_cast<uint8_t*>(original)[changed]==static_cast<uint8_t*>(candidate)[changed])changed++;length=std::min(writeLimit,changed+1);}',
    );
    source = replace(
      source,
      "researchWritten+=size_t(n);at+=size_t(n);",
      'researchWritten+=size_t(n);at+=size_t(n);\n      if(fault && std::strcmp(fault,"during-region")==0)fail("Disposable interruption during metadata region");',
    );
    source = replace(
      source,
      'io(ftruncate(l->target.n,off_t(candidateSize))==0,"Truncating metadata target");',
      'if(!prefix)io(ftruncate(l->target.n,off_t(candidateSize))==0,"Truncating metadata target");',
    );
    source = replace(
      source,
      "auto actual=[&]{NativeSpan span(activeTiming? &activeTiming->rereadMs:nullptr); return readFile(l->target.n);}();",
      'if(fault && std::strcmp(fault,"after-write")==0)fail("Disposable interruption after write before verify");\n    auto actual=[&]{NativeSpan span(activeTiming? &activeTiming->rereadMs:nullptr); return readFile(l->target.n);}();',
    );
    // Fault at the atomic exchange boundary in the disposable staged variant.
    source = replace(
      source,
      "  l.exchanged=true;",
      '  l.exchanged=true;\n  if(auto fault=std::getenv("RIO_RESEARCH_FAULT"); fault && std::strcmp(fault,"after-exchange")==0)fail("Disposable interruption after exchange");',
    );
  }
  const filename = path.join(directory, "publication-research.cc"),
    binary = path.join(directory, "publication.node");
  await writeFile(filename, source);
  let header;
  for (const option of [
    path.resolve(path.dirname(process.execPath), "../include/node"),
    "/usr/local/include/node",
    "/usr/include/node",
  ]) {
    try {
      await access(path.join(option, "node_api.h"));
      header = option;
      break;
    } catch {}
  }
  assert(
    header,
    "Existing Node-API headers required; this script does not install them",
  );
  execFileSync(
    process.env.CXX || "c++",
    [
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-DNAPI_VERSION=8",
      `-I${header}`,
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-mmacosx-version-min=13.0",
      "-arch",
      "x86_64",
      filename,
      "-o",
      binary,
    ],
    { stdio: "pipe" },
  );
  return binary;
}
