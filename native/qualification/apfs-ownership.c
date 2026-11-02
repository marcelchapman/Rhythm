// Research executable only. Never linked into publication.node or shipped.
// Every path is a caller-created disposable image fixture; no production policy bypass.
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <grp.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <uuid/uuid.h>
#include <sys/wait.h>
#include <ctype.h>
#include <limits.h>

static void require(int ok, const char *name) { if (!ok) { perror(name); exit(1); } }
static struct stat info(int fd) { struct stat s; require(fstat(fd, &s)==0,"fstat"); return s; }
static int same(struct stat a, struct stat b) { return a.st_dev==b.st_dev && a.st_ino==b.st_ino; }
static int file(int root, const char *name, const char *data) {
  int fd=openat(root,name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW,0600);
  require(fd>=0,"create fixture"); require(write(fd,data,strlen(data))==(ssize_t)strlen(data),"write"); return fd;
}
static int readable(int parent) { int fd=openat(parent,"slot",O_RDWR|O_NOFOLLOW); if(fd<0)return 0; close(fd);return 1; }

static int actor(const char *path, uid_t uid, gid_t gid) {
  // Optional administrator-authorized entry: privileges are dropped BEFORE any fixture I/O.
  require(geteuid()==0,"cross-UID probe requires an authorized root launcher");
  require(setgroups(0,NULL)==0 && setgid(gid)==0 && setuid(uid)==0,"drop privileges");
  require(getuid()==uid && geteuid()==uid && uid!=0,"verify unprivileged actor");
  int parent=open(path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  int entered=parent>=0, before=0, cleared=0, after=0, created=0, changed=0;
  unsigned owner=0, mode=0;
  if(entered) {
    struct stat s=info(parent);owner=s.st_uid;mode=s.st_mode&0777;
    before=readable(parent);
    int fd=openat(parent,"foreign",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);
    if(fd>=0) {created=1;close(fd);}
    changed=fchmod(parent,0700)==0;
  }
  acl_t empty=acl_init(0);require(empty!=NULL,"acl_init");
  // Denial of list/search/data access does not itself prove inability to change
  // the leaf directory's security descriptor. Test that authorization separately.
  cleared=acl_set_file(path,ACL_TYPE_EXTENDED,empty)==0;acl_free(empty);
  if(parent<0) parent=open(path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  if(parent>=0) {after=readable(parent);close(parent);}
  printf("{\"path\":\"%s\",\"uid\":%u,\"gid\":%u,\"entered\":%d,\"reportedOwner\":%u,\"mode\":%u,\"readWriteBeforeAclRemoval\":%d,\"createdEntry\":%d,\"chmodAllowed\":%d,\"removedAcl\":%d,\"readWriteAfterAclRemoval\":%d}\n",path,getuid(),getgid(),entered,owner,mode,before,created,changed,cleared,after);
  return 0;
}
int main(int argc,char **argv) {
  if(argc==5 && strcmp(argv[1],"actors")==0) {
    const char *prefix="/private/tmp/rio-apfs-study-";
    require(geteuid()==0 && strncmp(argv[2],prefix,strlen(prefix))==0,"authorized disposable-study launcher only");
    for(const char *p=argv[2]+strlen(prefix);*p;p++)require(isalnum((unsigned char)*p)||*p=='-',"study directory suffix");
    for(int i=0;i<4;i++) {
      char path[PATH_MAX];snprintf(path,sizeof(path),"%s/%s/Raw/%s",argv[2],i<2?"on":"off",i%2?"acl-private":"private");
      pid_t pid=fork();require(pid>=0,"fork actor");
      if(pid==0) return actor(path,(uid_t)strtoul(argv[3],NULL,10),(gid_t)strtoul(argv[4],NULL,10));
      int status;require(waitpid(pid,&status,0)==pid && WIFEXITED(status) && WEXITSTATUS(status)==0,"unprivileged actor completed");
    }
    return 0;
  }
  if(argc==5 && strcmp(argv[1],"actor")==0) return actor(argv[2],(uid_t)strtoul(argv[3],NULL,10),(gid_t)strtoul(argv[4],NULL,10));
  require(argc==2,"pass disposable fixture directory");
  int root=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);require(root>=0,"open fixture directory");
  struct statfs fs;require(fstatfs(root,&fs)==0,"fstatfs");
  require(strcmp(fs.f_fstypename,"apfs")==0 && (fs.f_flags&MNT_LOCAL) && !(fs.f_flags&MNT_RDONLY),"require local writable APFS image");
  int a=file(root,"a","Original"), b=file(root,"b","Candidate");
  struct stat aa=info(a),bb=info(b),x,y;
  require(renameatx_np(root,"a",root,"b",RENAME_SWAP)==0,"RENAME_SWAP");
  require(fstatat(root,"a",&x,AT_SYMLINK_NOFOLLOW)==0 && fstatat(root,"b",&y,AT_SYMLINK_NOFOLLOW)==0,"observe exchange");
  require(same(x,bb)&&same(y,aa),"exchange identities");
  errno=0;require(renameatx_np(root,"a",root,"b",RENAME_EXCL)==-1 && errno==EEXIST,"occupied RENAME_EXCL");
  require(fsync(a)==0 && fsync(b)==0 && fsync(root)==0,"fsync files/directories");
  require(fcntl(a,F_FULLFSYNC)==0 && fcntl(b,F_FULLFSYNC)==0 && fcntl(root,F_FULLFSYNC)==0,"F_FULLFSYNC files/directories");
  require(symlinkat("a",root,"symbolic")==0,"symlink fixture");
  errno=0;int symbolic=openat(root,"symbolic",O_RDONLY|O_NOFOLLOW);
  require(symbolic<0 && errno==ELOOP,"O_NOFOLLOW rejects symlink");
  require(linkat(root,"a",root,"hard",0)==0,"hardlink fixture");
  require(fstatat(root,"a",&x,0)==0 && x.st_nlink==2,"hardlink count");
  require(renameat(root,"b",root,"saved-original")==0,"park original");
  int replacement=file(root,"b","Replacement");require(!same(info(replacement),aa),"stale inode distinguished");
  require(mkdirat(root,"private",0700)==0,"private directory");
  int private=openat(root,"private",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);require(private>=0,"private open");
  int slot=file(private,"slot","Candidate");
  struct stat privacy=info(private);require((privacy.st_mode&0777)==0700,"mode retained");
  // A restrictive ACL can deny data access yet an owner may remove that ACL.
  // This is same-UID measurement; the cross-UID actor is separately labelled.
  acl_t deny=acl_init(1);acl_entry_t ace=NULL;acl_permset_t perms=NULL;uuid_t everyone;
  require(deny!=NULL && acl_create_entry(&deny,&ace)==0,"create deny ACL");
  require(uuid_parse("ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C",everyone)==0,"everyone UUID");
  require(acl_set_tag_type(ace,ACL_EXTENDED_DENY)==0 && acl_set_qualifier(ace,everyone)==0 && acl_get_permset(ace,&perms)==0,"configure deny ACL");
  require(acl_add_perm(perms,ACL_READ_DATA)==0 && acl_add_perm(perms,ACL_WRITE_DATA)==0 && acl_add_perm(perms,ACL_EXECUTE)==0 && acl_add_perm(perms,ACL_READ_SECURITY)==0 && acl_add_perm(perms,ACL_WRITE_SECURITY)==0,"ACL rights");
  int aclInstalled=acl_set_fd_np(slot,deny,ACL_TYPE_EXTENDED)==0;acl_free(deny);
  require(aclInstalled,"install disposable file ACL");
  errno=0;int denied=openat(private,"slot",O_RDWR|O_NOFOLLOW);
  require(denied<0 && errno==EACCES,"ACL denies a new data open");
  acl_t empty=acl_init(0);require(empty!=NULL,"empty ACL");
  int ownerRemovedAcl=acl_set_fd_np(slot,empty,ACL_TYPE_EXTENDED)==0;acl_free(empty);
  printf("{\"filesystem\":\"apfs\",\"flags\":%u,\"noowners\":%s,\"uid\":%u,\"gid\":%u,\"reportedOwner\":%u,\"reportedGroup\":%u,\"mode\":%u,\"atomicExchange\":true,\"noOverwrite\":true,\"inodeIdentity\":true,\"symlinkRefused\":true,\"hardlinkVisible\":true,\"staleIdentityDistinguished\":true,\"fsync\":true,\"fullfsync\":true,\"sameUidCanRemoveDenyAcl\":%s}\n",fs.f_flags,(fs.f_flags&MNT_IGNORE_OWNERSHIP)?"true":"false",geteuid(),getegid(),privacy.st_uid,privacy.st_gid,privacy.st_mode&0777,ownerRemovedAcl?"true":"false");
  close(slot);close(private);close(replacement);close(a);close(b);close(root);return 0;
}
