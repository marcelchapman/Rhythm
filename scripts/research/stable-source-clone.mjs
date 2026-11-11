// Research-only descriptor-bound APFS cloning; no copy fallback.
import { writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
export async function buildCloneHelper(directory) {
  const native = path.join(directory, "clone");
  await writeFile(
    native + ".cc",
    `
#include <sys/clonefile.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <unistd.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
static void die(const char* s) {perror(s);exit(1);}
int main(int argc,char** argv) {
 if(argc==3 && !strcmp(argv[1],"space")) {struct statfs f;if(statfs(argv[2],&f))die("statfs");printf("{\\\"freeBytes\\\":%llu,\\\"blockSize\\\":%u,\\\"flags\\\":%llu,\\\"noowners\\\":%s}\\n",(unsigned long long)f.f_bfree*f.f_bsize,f.f_bsize,(unsigned long long)f.f_flags,(f.f_flags&MNT_IGNORE_OWNERSHIP)?"true":"false");return 0;}
 if(argc!=4)return 2;
 int s=open(argv[1],O_RDONLY|O_NOFOLLOW|O_CLOEXEC),d=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
 if(s<0||d<0)die("open");struct stat before,after,created;if(fstat(s,&before))die("fstat");
 if(!S_ISREG(before.st_mode)||before.st_nlink!=1||strchr(argv[3],'/'))return 3;
 auto t=std::chrono::steady_clock::now();if(fclonefileat(s,d,argv[3],CLONE_NOOWNERCOPY))die("fclonefileat");
 auto ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-t).count();
 if(fstat(s,&after)||fstatat(d,argv[3],&created,AT_SYMLINK_NOFOLLOW))die("fstatat");
 if(before.st_ino!=after.st_ino||before.st_dev!=after.st_dev||before.st_size!=after.st_size||before.st_mtimespec.tv_sec!=after.st_mtimespec.tv_sec||before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec||before.st_ctimespec.tv_sec!=after.st_ctimespec.tv_sec||before.st_ctimespec.tv_nsec!=after.st_ctimespec.tv_nsec||created.st_ino==before.st_ino||!S_ISREG(created.st_mode)||created.st_nlink!=1)return 4;
 printf("{\\\"cloneMs\\\":%.6f,\\\"bytes\\\":%lld,\\\"sourceInode\\\":%llu,\\\"cloneInode\\\":%llu,\\\"blocks512\\\":%lld}\\n",ms,(long long)created.st_size,(unsigned long long)before.st_ino,(unsigned long long)created.st_ino,(long long)created.st_blocks);
 close(s);close(d);
}
`,
  );
  execFileSync("clang++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    native + ".cc",
    "-o",
    native,
  ]);
  return native;
}
