// Benign documented-API binding experiments only. Never linked into Rio.
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <sys/attr.h>
#include <sys/clonefile.h>
#include <sys/fileport.h>
#include <mach/mach.h>
#include <fcntl.h>
#include <unistd.h>
#include <copyfile.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
static void ok(int v,const char *s){if(!v){perror(s);exit(1);}}
static int make(int d,const char *n,const char *s){int f=openat(d,n,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW,0600);ok(f>=0,n);ok(write(f,s,strlen(s))==(ssize_t)strlen(s),"write fixture");return f;}
static struct stat st(int f){struct stat s;ok(!fstat(f,&s),"fstat");return s;}
static int content(int f,const char *s){char b[128]={0};ssize_t n=pread(f,b,sizeof(b)-1,0);return n==(ssize_t)strlen(s)&&!memcmp(b,s,(size_t)n);}
static int named(int d,const char *n,const char *s){int f=openat(d,n,O_RDONLY|O_NOFOLLOW);if(f<0)return 0;int r=content(f,s);close(f);return r;}
int main(int argc,char **argv){
 ok(argc==3,"pass two disposable binding directories");
 for(int i=1;i<3;i++)ok(!strncmp(argv[i],"/private/tmp/rio-apfs-design-",strlen("/private/tmp/rio-apfs-design-")),"disposable prefix");
 int d=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW),other=open(argv[2],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);ok(d>=0&&other>=0,"open fixtures");
 struct statfs fs;ok(!fstatfs(d,&fs)&&!strcmp(fs.f_fstypename,"apfs")&&(fs.f_flags&MNT_LOCAL),"local APFS");
 int a=make(d,"source","Original A"),b;
 ok(!renameat(d,"source",d,"original-renamed"),"ordinary rename");b=make(d,"source","Replacement B");
 ok(content(a,"Original A")&&named(d,"source","Replacement B"),"fd versus path binding");
 int c=make(d,"candidate","Candidate C");
 ok(!renameatx_np(d,"candidate",d,"source",RENAME_SWAP),"atomic swap");
 ok(named(d,"source","Candidate C")&&named(d,"candidate","Replacement B"),"swap uses current names; preserves both objects");
 int collision=renameatx_np(d,"candidate",d,"source",RENAME_EXCL),collisionError=errno;
 ok(collision==-1&&collisionError==EEXIST&&named(d,"source","Candidate C"),"exclusive rename occupied refusal");
 ok(!renameatx_np(d,"candidate",d,"new-destination",RENAME_EXCL)&&named(d,"new-destination","Replacement B"),"exclusive destination is not expected-source binding");
 ok(!fclonefileat(a,d,"descriptor-clone",0)&&named(d,"descriptor-clone","Original A"),"descriptor clone follows original fd");
 ok(!clonefileat(d,"source",d,"pathname-clone",0)&&named(d,"pathname-clone","Candidate C"),"pathname clone resolves current name");
 errno=0;int cloneCollision=fclonefileat(a,d,"source",0),cloneError=errno;ok(cloneCollision==-1&&cloneError==EEXIST&&named(d,"source","Candidate C"),"clone cannot overwrite occupied destination");
 int fresh=make(d,"descriptor-copy","");ok(!fcopyfile(a,fresh,NULL,COPYFILE_DATA)&&st(fresh).st_size==0,"fcopyfile respects current source EOF offset");ok(lseek(a,0,SEEK_SET)==0&&lseek(fresh,0,SEEK_SET)==0,"explicit rewind");ok(!fcopyfile(a,fresh,NULL,COPYFILE_DATA)&&content(fresh,"Original A"),"descriptor copy follows bound source");
 fileport_t port=FILEPORT_NULL;ok(!fileport_makeport(a,&port),"fileport_makeport");int duplicate=fileport_makefd(port);ok(duplicate>=0&&st(duplicate).st_ino==st(a).st_ino&&content(duplicate,"Original A"),"fileport preserves open-object reference");
 ok(!mach_port_deallocate(mach_task_self(),port),"release fileport");close(duplicate);
 char p1[2048],p2[2048];ok(snprintf(p1,sizeof(p1),"%s/source",argv[1])<(int)sizeof(p1),"path1");ok(snprintf(p2,sizeof(p2),"%s/new-destination",argv[1])<(int)sizeof(p2),"path2");
 errno=0;int ex=exchangedata(p1,p2,FSOPT_NOFOLLOW),exErr=errno;
 // Deprecated but documented; record unsupported status rather than fall back.
 ok(ex==-1&&exErr==ENOTSUP,"APFS exchangedata unsupported");
 errno=0;int crossRename=renameatx_np(d,"descriptor-clone",other,"cross-renamed",RENAME_EXCL),crossRenameError=errno;
 ok(crossRename==-1&&crossRenameError==EXDEV&&named(d,"descriptor-clone","Original A"),"cross-volume rename fails intact");
 errno=0;int crossClone=fclonefileat(a,other,"cross-cloned",0),crossCloneError=errno;ok(crossClone==-1&&crossCloneError==EXDEV,"cross-volume clone fails");
 int symlinkRc=symlinkat("original-renamed",d,"reference");ok(!symlinkRc,"ordinary symlink");errno=0;int s=openat(d,"reference",O_RDONLY|O_NOFOLLOW),symlinkError=errno;ok(s<0&&symlinkError==ELOOP,"nofollow rejects link");
 ok(!linkat(d,"original-renamed",d,"second-name",0)&&st(a).st_nlink==2,"link count evidence");
 ok(!fsync(c)&&!fcntl(c,F_FULLFSYNC)&&!fsync(d)&&!fcntl(d,F_FULLFSYNC),"documented durability requests");
 printf("{\"noowners\":%s,\"fdRetainsOriginal\":true,\"swapUsesCurrentEntries\":true,\"swapPreservesBoth\":true,\"exclusiveRenameCollisionErrno\":%d,\"exclusiveRenameSourceIsPathBound\":true,\"descriptorCloneOriginal\":true,\"pathnameCloneCurrentEntry\":true,\"cloneCollisionErrno\":%d,\"descriptorCopyOriginal\":true,\"fcopyfilePreservesOffsets\":true,\"fileportOriginal\":true,\"exchangedataErrno\":%d,\"crossRenameErrno\":%d,\"crossCloneErrno\":%d,\"nofollowErrno\":%d,\"hardlinkCount\":%u,\"fullfsyncReturnedSuccess\":true}\n",fs.f_flags&MNT_IGNORE_OWNERSHIP?"true":"false",collisionError,cloneError,exErr,crossRenameError,crossCloneError,symlinkError,(unsigned)st(a).st_nlink);
 close(fresh);close(c);close(b);close(a);close(d);close(other);return 0;
}
