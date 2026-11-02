// Phase 2C.2 research only; never linked into or packaged with publication.node.
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <grp.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <ctype.h>

static void require(int ok,const char *what){if(!ok){perror(what);exit(1);}}
int main(int argc,char **argv){
  require(argc==7,"actor ROOT MODE WORKSPACE UID GID");
  const char *prefix="/private/tmp/rio-apfs-boundary-";
  require(strncmp(argv[1],prefix,strlen(prefix))==0,"disposable root prefix");
  for(const char *p=argv[1]+strlen(prefix);*p;p++)require(isalnum((unsigned char)*p),"disposable root suffix");
  require(strcmp(argv[2],"on")==0||strcmp(argv[2],"off")==0,"image mode");
  require(strncmp(argv[3],".rio-publication-",17)==0 && !strchr(argv[3],'/'),"workspace component");
  uid_t uid=(uid_t)strtoull(argv[4],NULL,10);gid_t gid=(gid_t)strtoull(argv[5],NULL,10);
  require(uid!=0 && strcmp(argv[6],"replace-slot")==0,"nonroot replacement actor");
  require(geteuid()==0,"administrator-authorized launcher required");
  require(setgroups(0,NULL)==0&&setgid(gid)==0&&setuid(uid)==0,"drop all privileges before fixture I/O");
  require(getuid()==uid&&geteuid()==uid&&getgid()==gid&&getegid()==gid,"verify unprivileged actor");
  char volume[1024],media[1200],work[1500],victim[1200];
  require(snprintf(volume,sizeof(volume),"%s/%s",argv[1],argv[2])<(int)sizeof(volume),"volume path");
  require(snprintf(media,sizeof(media),"%s/Media",volume)<(int)sizeof(media),"media path");
  require(snprintf(work,sizeof(work),"%s/%s",media,argv[3])<(int)sizeof(work),"workspace path");
  require(snprintf(victim,sizeof(victim),"%s/Unrelated",volume)<(int)sizeof(victim),"victim path");
  int w=open(work,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);int err=errno;
  if(w<0){printf("{\"uid\":%u,\"euid\":%u,\"entered\":false,\"errno\":%d,\"replaced\":false}\n",getuid(),geteuid(),err);return 0;}
  struct statfs fs;require(fstatfs(w,&fs)==0 && !strcmp(fs.f_fstypename,"apfs") && (fs.f_flags&MNT_LOCAL),"local APFS only");
  int p=open(media,O_RDONLY|O_DIRECTORY|O_NOFOLLOW),v=open(victim,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  require(p>=0&&v>=0,"fixture parents");struct stat before,foreign,after;
  require(fstatat(w,"slot",&before,AT_SYMLINK_NOFOLLOW)==0&&fstatat(v,"victim",&foreign,AT_SYMLINK_NOFOLLOW)==0,"actor identity evidence");
  require(renameat(w,"slot",p,"parked-slot")==0,"park known slot outside cleanup workspace");
  require(renameat(v,"victim",w,"slot")==0,"move unrelated disposable file to checked name");
  require(fstatat(w,"slot",&after,AT_SYMLINK_NOFOLLOW)==0&&after.st_ino==foreign.st_ino&&after.st_dev==foreign.st_dev,"replacement identity");
  printf("{\"uid\":%u,\"euid\":%u,\"entered\":true,\"replaced\":true,\"checkedInode\":\"%llu\",\"replacementInode\":\"%llu\",\"replacementLinks\":%u}\n",getuid(),geteuid(),(unsigned long long)before.st_ino,(unsigned long long)after.st_ino,(unsigned)after.st_nlink);
  close(v);close(p);close(w);return 0;
}
