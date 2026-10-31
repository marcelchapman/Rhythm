// Isolated, unprivileged publication capabilities. No SQLite, tag writer or IPC.
// Exchange is NOT an expected-inode CAS. Displaced objects must be inspected.
#include <node_api.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <cstring>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <set>
#include <fstream>
#include <sstream>
#ifdef __APPLE__
#include <sys/mount.h>
#include <sys/acl.h>
#include <stdio.h>
#else
#include <sys/vfs.h>
#include <sys/statvfs.h>
#include <sys/xattr.h>
#include <sys/syscall.h>
#include <linux/openat2.h>
#include <linux/fs.h>
#endif

namespace {
constexpr size_t limit = 64 * 1024 * 1024;
constexpr char workspacePrefix[] = ".rio-publication-";
const napi_type_tag leaseTag = {0xc4ab0e8c9de04751ULL, 0x902674a962fdbe40ULL};
struct Failure : std::runtime_error {
  std::string category;
  int number;
  Failure(std::string kind, std::string message, int n = 0)
    : std::runtime_error(message + (n ? ": " + std::string(strerror(n)) : "")), category(kind), number(n) {}
};
[[noreturn]] void fail(const std::string& message, std::string kind = "conflict") {
  throw Failure(kind, message);
}
void io(bool ok, const std::string& message) {
  if (!ok) {int n=errno; throw Failure((n==ENOSYS || n==ENOTSUP || n==EOPNOTSUPP || n==EXDEV)?"unsupported":"io", message, n);}
}
void js(napi_status status) { if (status != napi_ok) fail("Invalid native arguments", "invalid-input"); }
napi_value obj(napi_env e) { napi_value v; js(napi_create_object(e, &v)); return v; }
napi_value text(napi_env e, const std::string& s) { napi_value v; js(napi_create_string_utf8(e,s.data(),s.size(),&v)); return v; }
napi_value boolean(napi_env e, bool b) { napi_value v; js(napi_get_boolean(e,b,&v)); return v; }
void put(napi_env e, napi_value o, const char* key, napi_value value) { js(napi_set_named_property(e,o,key,value)); }
void put(napi_env e, napi_value o, const char* key, const std::string& value) { put(e,o,key,text(e,value)); }
void put(napi_env e, napi_value o, const char* key, const char* value) { put(e,o,key,std::string(value)); }
napi_value get(napi_env e, napi_value o, const char* key) { napi_value v; js(napi_get_named_property(e,o,key,&v)); return v; }
std::string str(napi_env e, napi_value v) {
  size_t n; js(napi_get_value_string_utf8(e,v,nullptr,0,&n));
  if(n > 8192) fail("Native string exceeds limit", "invalid-input");
  std::vector<char> b(n+1); js(napi_get_value_string_utf8(e,v,b.data(),b.size(),&n));
  if(memchr(b.data(),0,n)) fail("Embedded NUL", "invalid-input");
  return std::string(b.data(),n);
}
std::string field(napi_env e, napi_value o, const char* key) {return str(e,get(e,o,key));}
std::string num(uint64_t n) {return std::to_string(n);}
int64_t mtime(const struct stat& s) {
#ifdef __APPLE__
  return int64_t(s.st_mtimespec.tv_sec)*1000000000 + s.st_mtimespec.tv_nsec;
#else
  return int64_t(s.st_mtim.tv_sec)*1000000000 + s.st_mtim.tv_nsec;
#endif
}
int64_t ctime(const struct stat& s) {
#ifdef __APPLE__
  return int64_t(s.st_ctimespec.tv_sec)*1000000000 + s.st_ctimespec.tv_nsec;
#else
  return int64_t(s.st_ctim.tv_sec)*1000000000 + s.st_ctim.tv_nsec;
#endif
}
struct Fd {
  int n = -1;
  explicit Fd(int f=-1):n(f){}
  ~Fd(){if(n>=0) close(n);}
  Fd(const Fd&)=delete; Fd& operator=(const Fd&)=delete;
  Fd(Fd&& other) noexcept:n(other.n){other.n=-1;}
  Fd& operator=(Fd&& other) noexcept {if(n>=0)close(n); n=other.n; other.n=-1; return *this;}
};
struct stat stats(int fd) {struct stat s{}; io(fstat(fd,&s)==0,"fstat"); return s;}
bool identity(const struct stat& a,const struct stat& b) {return a.st_dev==b.st_dev && a.st_ino==b.st_ino && (a.st_mode&S_IFMT)==(b.st_mode&S_IFMT);}
bool unchanged(const struct stat& a,const struct stat& b,bool checkCtime=true) {
  return identity(a,b) && a.st_size==b.st_size && a.st_nlink==b.st_nlink &&
    a.st_mode==b.st_mode && a.st_uid==b.st_uid && a.st_gid==b.st_gid &&
    mtime(a)==mtime(b) && (!checkCtime || ctime(a)==ctime(b));
}
void regular(const struct stat& s) {
  if(!S_ISREG(s.st_mode) || s.st_nlink!=1 || s.st_size<0 || uint64_t(s.st_size)>limit)
    fail("Require a bounded regular file with exactly one link");
  if(s.st_uid!=geteuid())fail("File ownership is not qualified", "unsupported");
#ifdef __APPLE__
  if(s.st_flags & (UF_IMMUTABLE|SF_IMMUTABLE|SF_DATALESS)) fail("Immutable or dataless files are unsupported", "unsupported");
#endif
}
napi_value fingerprint(napi_env e,const struct stat& s) {
  auto o=obj(e);
  put(e,o,"device",num(s.st_dev)); put(e,o,"inode",num(s.st_ino));
  put(e,o,"size",num(s.st_size)); put(e,o,"links",num(s.st_nlink));
  put(e,o,"mode",num(s.st_mode)); put(e,o,"uid",num(s.st_uid)); put(e,o,"gid",num(s.st_gid));
  put(e,o,"mtimeNs",std::to_string(mtime(s))); put(e,o,"ctimeNs",std::to_string(ctime(s)));
  put(e,o,"type",S_ISREG(s.st_mode)?"file":S_ISDIR(s.st_mode)?"directory":S_ISLNK(s.st_mode)?"symlink":"other");
  return o;
}
bool matches(napi_env e,napi_value expected,const struct stat& s,bool full) {
  auto f=fingerprint(e,s);
  for(auto key: full ? std::vector<const char*>{"device","inode","size","links","mode","uid","gid","mtimeNs","ctimeNs","type"} : std::vector<const char*>{"device","inode","type"})
    if(field(e,expected,key)!=field(e,f,key)) return false;
  return true;
}
std::vector<std::string> parts(const std::string& p,bool absolute=false) {
  if(p.empty() || (p[0]=='/')!=absolute || p.find('\\')!=std::string::npos) fail("Invalid publication path", "invalid-input");
  std::vector<std::string> out;
  size_t at=absolute?1:0;
  while(at<p.size()) {
    auto end=p.find('/',at); if(end==std::string::npos) end=p.size();
    auto part=p.substr(at,end-at);
    if(part.empty()||part=="."||part==".."||part.size()>255) fail("Unsafe path component", "invalid-input");
    out.push_back(part); at=end+1;
  }
  if(out.empty() || p.back()=='/') fail("Empty or root-only path", "invalid-input");
  return out;
}
int relativeOpen(int parent,const std::string& name,int flags,bool bounded) {
#ifdef __linux__
  struct open_how how{};
  how.flags=uint64_t(flags|O_CLOEXEC|O_NOFOLLOW);
  how.resolve=RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|(bounded?RESOLVE_NO_XDEV:0);
  return int(syscall(SYS_openat2,parent,name.c_str(),&how,sizeof(how)));
#else
  (void)bounded;
  return openat(parent,name.c_str(),flags|O_CLOEXEC|O_NOFOLLOW);
#endif
}
int exchange(int a,const char* x,int b,const char* y) {
#ifdef __APPLE__
  return renameatx_np(a,x,b,y,RENAME_SWAP);
#else
  return int(syscall(SYS_renameat2,a,x,b,y,RENAME_EXCHANGE));
#endif
}
int noReplace(int a,const char* x,int b,const char* y) {
#ifdef __APPLE__
  return renameatx_np(a,x,b,y,RENAME_EXCL);
#else
  return int(syscall(SYS_renameat2,a,x,b,y,RENAME_NOREPLACE));
#endif
}
std::string flush(int fd) {
#ifdef __APPLE__
  // Strict capability: report failure, never silently fall back to a weaker barrier.
  io(fsync(fd)==0,"fsync");
  io(fcntl(fd,F_FULLFSYNC)==0,"F_FULLFSYNC unavailable");
  return "fullfsync";
#else
  io(fsync(fd)==0,"fsync"); return "fsync";
#endif
}
std::string mountId(int fd) {
#ifdef __linux__
  std::ifstream input("/proc/self/fdinfo/"+std::to_string(fd));
  std::string line;
  while(std::getline(input,line)) if(line.rfind("mnt_id:",0)==0) {
    std::istringstream s(line.substr(7)); std::string id; s>>id; return id;
  }
  fail("Mount identity unavailable", "unsupported");
#else
  return num(stats(fd).st_dev);
#endif
}
std::string filesystem(int fd) {
  struct statfs s{}; io(fstatfs(fd,&s)==0,"fstatfs");
#ifdef __APPLE__
  if(std::string(s.f_fstypename)!="apfs" || !(s.f_flags&MNT_LOCAL) || (s.f_flags&(MNT_IGNORE_OWNERSHIP|MNT_RDONLY)))
    fail("Require local writable APFS with ownership enabled", "unsupported");
  return "apfs";
#else
  auto id=mountId(fd); std::ifstream input("/proc/self/mountinfo"); std::string line;
  while(std::getline(input,line)) {
    std::istringstream fields(line); std::string entry; fields>>entry;
    auto separator=line.find(" - ");
    if(entry==id && separator!=std::string::npos) {
      std::istringstream tail(line.substr(separator+3)); std::string type; tail>>type;
      if(type!="ext4" || (s.f_flags&ST_RDONLY)) fail("Require writable local ext4", "unsupported");
      return type;
    }
  }
  fail("Filesystem mount classification unavailable", "unsupported");
#endif
}
std::vector<uint8_t> readFile(int fd) {
  auto before=stats(fd); regular(before);
  std::vector<uint8_t> bytes(size_t(before.st_size)); size_t at=0;
  while(at<bytes.size()) {
    auto n=pread(fd,bytes.data()+at,bytes.size()-at,off_t(at));
    if(n<0 && errno==EINTR) continue;
    io(n>0,"Reading publication file"); at+=size_t(n);
  }
  if(!unchanged(before,stats(fd))) fail("File changed during read");
  return bytes;
}
void writeAll(int fd,const uint8_t* bytes,size_t length) {
  size_t at=0;
  while(at<length) {auto n=write(fd,bytes+at,length-at); if(n<0 && errno==EINTR)continue; io(n>0,"Writing private artifact"); at+=size_t(n);}
}
struct Anchor {Fd fd; std::string name; struct stat identity;};
struct Lease {
  std::vector<Anchor> chain;
  size_t rootIndex=0;
  std::string leaf, workspace, mount, fs;
  Fd target, work, slot, rollback;
  struct stat expected{}, workIdentity{}, slotIdentity{}, rollbackIdentity{};
  std::vector<uint8_t> original;
  bool alive=true, prepared=false, attempted=false, exchanged=false, cleaned=false;
  int parent() const {return chain.back().fd.n;}
};
void validateChain(Lease& l) {
  if(!l.alive) fail("Publication lease is closed", "invalid-input");
  for(size_t i=0;i<l.chain.size();i++) {
    auto current=stats(l.chain[i].fd.n);
    if(!identity(l.chain[i].identity,current)) fail("Directory handle identity changed");
    if(i) {
      struct stat entry{};
      io(fstatat(l.chain[i-1].fd.n,l.chain[i].name.c_str(),&entry,AT_SYMLINK_NOFOLLOW)==0,"Directory ancestry unavailable");
      if(!identity(entry,current) || !S_ISDIR(entry.st_mode)) fail("Root or parent directory was substituted");
    }
  }
  if(mountId(l.parent())!=l.mount) fail("Publication mount changed");
}
void workspaceCheck(Lease& l) {
  validateChain(l);
  if(l.work.n<0 || l.cleaned) fail("No active private workspace");
  struct stat entry{}; io(fstatat(l.parent(),l.workspace.c_str(),&entry,AT_SYMLINK_NOFOLLOW)==0,"Workspace unavailable");
  auto actual=stats(l.work.n);
  if(!identity(entry,l.workIdentity)||!identity(actual,l.workIdentity)||!S_ISDIR(actual.st_mode)||
     actual.st_uid!=geteuid() || (actual.st_mode&0777)!=0700)
    fail("Private workspace identity or permissions changed");
#ifdef __APPLE__
  acl_t acl=acl_get_fd_np(l.work.n,ACL_TYPE_EXTENDED);
  if(!acl) {
    int error=errno;
    if(error!=ENOENT)throw Failure("unsupported","Workspace ACL inspection failed",error);
    // Do not infer ACL absence from ENOENT. Positively establish an empty ACL
    // on this identity-checked, adapter-owned directory, through its descriptor.
    // This NEVER changes a target file or an arbitrary existing directory.
    acl_t empty=acl_init(0); io(empty!=nullptr,"Allocating empty workspace ACL");
    int rc=acl_set_fd_np(l.work.n,empty,ACL_TYPE_EXTENDED), saved=errno;
    acl_free(empty);
    if(rc!=0)throw Failure("unsupported","Cannot establish private workspace ACL",saved);
  } else {
    acl_entry_t entryAcl; errno=0;
    int rc=acl_get_entry(acl,ACL_FIRST_ENTRY,&entryAcl), error=errno;
    acl_free(acl);
    if(rc==0)fail("Extended workspace ACL is unqualified", "unsupported");
    if(error!=EINVAL)throw Failure("unsupported","Workspace ACL inspection failed",error);
  }
#else
  for(const char* name:{"system.posix_acl_access","system.posix_acl_default"}) {
    errno=0; auto size=fgetxattr(l.work.n,name,nullptr,0);
    if(size>=0)fail("Extended workspace ACL is unqualified", "unsupported");
    if(errno!=ENODATA)throw Failure("unsupported","Workspace ACL inspection failed",errno);
  }
#endif
}
void sameFilesystem(Lease& l,int fd) {
  if(stats(fd).st_dev!=l.expected.st_dev || mountId(fd)!=l.mount) fail("Cross-filesystem entry", "unsupported");
}
Fd openLeaf(Lease& l,int parent,const std::string& name) {
  Fd fd(relativeOpen(parent,name,O_RDONLY|O_NONBLOCK,true));
  io(fd.n>=0,"Opening publication entry");
  sameFilesystem(l,fd.n);
  regular(stats(fd.n)); return fd;
}
void currentExpected(Lease& l) {
  validateChain(l);
  auto fd=openLeaf(l,l.parent(),l.leaf);
  if(!unchanged(l.expected,stats(fd.n))) fail("Target fingerprint changed");
}
void privateExpected(Lease& l,const char* name,const struct stat& expected) {
  auto fd=openLeaf(l,l.work.n,name);
  if(!unchanged(expected,stats(fd.n))) fail(std::string("Private artifact changed: ")+name);
}
std::unique_ptr<Lease> anchor(napi_env e,napi_value config) {
  auto l=std::make_unique<Lease>();
  auto root=field(e,config,"root"), relative=field(e,config,"relative");
  auto absolute=parts(root,true), local=parts(relative);
  l->chain.push_back({Fd(open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC)),"",{}});
  io(l->chain[0].fd.n>=0,"Opening filesystem root"); l->chain[0].identity=stats(l->chain[0].fd.n);
  for(const auto& part:absolute) {
    Fd next(relativeOpen(l->parent(),part,O_RDONLY|O_DIRECTORY,false));
    io(next.n>=0,"Opening root ancestry without symlinks");
    auto s=stats(next.n); l->chain.push_back({std::move(next),part,s});
  }
  l->rootIndex=l->chain.size()-1;
  if(!matches(e,get(e,config,"rootIdentity"),l->chain.back().identity,false)) fail("Registered root identity changed");
  l->fs=filesystem(l->parent()); l->mount=mountId(l->parent());
  auto device=stats(l->parent()).st_dev;
  for(size_t i=0;i+1<local.size();i++) {
    Fd next(relativeOpen(l->parent(),local[i],O_RDONLY|O_DIRECTORY,true));
    io(next.n>=0,"Opening managed parent"); auto s=stats(next.n);
    if(s.st_dev!=device || mountId(next.n)!=l->mount) fail("Cross-filesystem parent", "unsupported");
    l->chain.push_back({std::move(next),local[i],s});
  }
  l->leaf=local.back(); validateChain(*l); return l;
}
napi_value bytes(napi_env e,const std::vector<uint8_t>& data) {
  napi_value v; js(napi_create_buffer_copy(e,data.size(),data.data(),nullptr,&v)); return v;
}
napi_value entry(napi_env e,Lease& l,int parent,const std::string& name) {
  auto o=obj(e); struct stat s{};
  if(fstatat(parent,name.c_str(),&s,AT_SYMLINK_NOFOLLOW)!=0) {
    put(e,o,"error",strerror(errno)); return o;
  }
  put(e,o,"identity",fingerprint(e,s));
  try {auto fd=openLeaf(l,parent,name); put(e,o,"data",bytes(e,readFile(fd.n))); put(e,o,"identity",fingerprint(e,stats(fd.n)));}
  catch(const Failure& f){put(e,o,"error",f.what());}
  return o;
}
napi_value inspection(napi_env e,Lease& l) {
  auto o=obj(e); bool valid=true;
  try {workspaceCheck(l);} catch(const Failure& f){valid=false; put(e,o,"boundaryError",f.what());}
  put(e,o,"boundaryValid",boolean(e,valid));
  put(e,o,"target",entry(e,l,l.parent(),l.leaf));
  if(l.work.n>=0) {
    put(e,o,"slot",entry(e,l,l.work.n,"slot"));
    put(e,o,"rollback",entry(e,l,l.work.n,"rollback"));
    put(e,o,"workspaceIdentity",fingerprint(e,stats(l.work.n)));
    put(e,o,"workspace",l.workspace);
    put(e,o,"parentIdentity",fingerprint(e,stats(l.parent())));
  }
  return o;
}
napi_value result(napi_env e,const char* state,const std::string& reason="") {
  auto o=obj(e); put(e,o,"status",state); if(!reason.empty())put(e,o,"reason",reason); return o;
}
void finalize(napi_env,void* data,void*) {delete static_cast<Lease*>(data);}
napi_value handle(napi_env e,std::unique_ptr<Lease> l) {
  auto o=obj(e); js(napi_type_tag_object(e,o,&leaseTag));
  js(napi_wrap(e,o,l.get(),finalize,nullptr,nullptr)); l.release(); return o;
}
Lease& lease(napi_env e,napi_value v) {
  bool valid=false; js(napi_check_object_type_tag(e,v,&leaseTag,&valid));
  if(!valid) fail("Invalid publication capability", "invalid-input");
  void* p; js(napi_unwrap(e,v,&p)); auto& l=*static_cast<Lease*>(p);
  if(!l.alive) { fail("Closed publication capability", "invalid-input"); }
  return l;
}
std::vector<napi_value> args(napi_env e,napi_callback_info info,size_t count) {
  size_t n=count; std::vector<napi_value> a(count); js(napi_get_cb_info(e,info,&n,a.data(),nullptr,nullptr));
  if(n!=count) { fail("Incorrect publication arguments", "invalid-input"); }
  return a;
}
template<class F> napi_value protect(napi_env e,F fn) {
  try {return fn();}
  catch(const Failure& f) {
    bool pending=false; napi_is_exception_pending(e,&pending); if(pending)return nullptr;
    napi_value error; napi_create_error(e,nullptr,text(e,f.what()),&error);
    put(e,error,"code",f.category); put(e,error,"errno",std::to_string(f.number)); napi_throw(e,error); return nullptr;
  } catch(const std::exception& f){napi_throw_error(e,"native-failure",f.what()); return nullptr;}
}
napi_value openLease(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,1); auto l=anchor(e,a[0]);
  l->target=Fd(relativeOpen(l->parent(),l->leaf,O_RDONLY|O_NONBLOCK,true)); io(l->target.n>=0,"Opening target");
  l->expected=stats(l->target.n); regular(l->expected);
  if(mountId(l->target.n)!=l->mount || l->expected.st_dev!=l->chain[l->rootIndex].identity.st_dev) fail("Cross-filesystem target", "unsupported");
  if(!matches(e,get(e,a[0],"expected"),l->expected,true))fail("Target does not match expected fingerprint");
  l->original=readFile(l->target.n);
  auto o=obj(e); put(e,o,"original",bytes(e,l->original)); put(e,o,"handle",handle(e,std::move(l))); return o;
});}
void createWorkspace(Lease& l,const std::string& name) {
  if(name.rfind(workspacePrefix,0)!=0 || name.size()!=sizeof(workspacePrefix)-1+36 || name.find_first_not_of(".rio-publication-abcdef0123456789")!=std::string::npos)
    fail("Invalid private operation name", "invalid-input");
  io(mkdirat(l.parent(),name.c_str(),0700)==0,"Exclusive workspace creation"); l.workspace=name;
  l.work=Fd(relativeOpen(l.parent(),name,O_RDONLY|O_DIRECTORY,true)); io(l.work.n>=0,"Opening private workspace");
  l.workIdentity=stats(l.work.n); workspaceCheck(l); flush(l.parent());
}
void capabilityProbe(Lease& l) {
  Fd a(openat(l.work.n,"probe-a",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600));
  Fd b(openat(l.work.n,"probe-b",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600));
  io(a.n>=0 && b.n>=0,"Creating capability probe artifacts"); auto aa=stats(a.n), bb=stats(b.n);
  io(exchange(l.work.n,"probe-a",l.work.n,"probe-b")==0,"Atomic exchange unsupported");
  struct stat x{},y{};
  io(fstatat(l.work.n,"probe-a",&x,AT_SYMLINK_NOFOLLOW)==0 && fstatat(l.work.n,"probe-b",&y,AT_SYMLINK_NOFOLLOW)==0,"Probe inspection");
  if(!identity(x,bb)||!identity(y,aa))fail("Unexpected capability probe result", "unsupported");
  errno=0; int rc=noReplace(l.work.n,"probe-a",l.work.n,"probe-b");
  if(rc==0 || errno!=EEXIST)fail("No-overwrite rename unsupported", "unsupported");
  flush(a.n); flush(b.n); flush(l.work.n);
  // Probe artifacts are removed only after checking their post-exchange identities.
  io(fstatat(l.work.n,"probe-a",&x,AT_SYMLINK_NOFOLLOW)==0 && fstatat(l.work.n,"probe-b",&y,AT_SYMLINK_NOFOLLOW)==0,"Probe cleanup inspection");
  if(!identity(x,bb)||!identity(y,aa))fail("Probe artifacts were substituted");
  workspaceCheck(l); io(unlinkat(l.work.n,"probe-a",0)==0,"Removing owned probe"); io(unlinkat(l.work.n,"probe-b",0)==0,"Removing owned probe"); flush(l.work.n);
}
napi_value prepare(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,3); auto& l=lease(e,a[0]); if(l.work.n>=0)fail("Lease already prepared"); currentExpected(l);
  void* data; size_t length; js(napi_get_buffer_info(e,a[2],&data,&length)); if(length>limit)fail("Candidate exceeds 64 MiB", "invalid-input");
  createWorkspace(l,str(e,a[1])); capabilityProbe(l);
  l.slot=Fd(openat(l.work.n,"slot",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600)); io(l.slot.n>=0,"Creating candidate");
  writeAll(l.slot.n,static_cast<uint8_t*>(data),length); flush(l.slot.n); l.slotIdentity=stats(l.slot.n);
  l.rollback=Fd(openat(l.work.n,"rollback",O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600)); io(l.rollback.n>=0,"Creating independent rollback");
  writeAll(l.rollback.n,l.original.data(),l.original.size()); flush(l.rollback.n); l.rollbackIdentity=stats(l.rollback.n);
  if(l.slotIdentity.st_dev!=l.expected.st_dev || l.rollbackIdentity.st_dev!=l.expected.st_dev || mountId(l.slot.n)!=l.mount || mountId(l.rollback.n)!=l.mount)
    fail("Cross-filesystem artifacts", "unsupported");
  flush(l.work.n); flush(l.parent()); currentExpected(l); l.prepared=true;
  auto o=inspection(e,l); put(e,o,"workspace",l.workspace); put(e,o,"filesystem",l.fs);
  put(e,o,"parentIdentity",fingerprint(e,stats(l.parent()))); return o;
});}
napi_value probe(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,2); auto l=anchor(e,a[0]); createWorkspace(*l,str(e,a[1]));
  try {capabilityProbe(*l); workspaceCheck(*l); io(unlinkat(l->parent(),l->workspace.c_str(),AT_REMOVEDIR)==0,"Removing empty probe workspace"); flush(l->parent());}
  catch(...) { // Empty-only removal; unfamiliar contents are never recursively removed.
    unlinkat(l->parent(),l->workspace.c_str(),AT_REMOVEDIR); throw;
  }
  auto o=result(e,"supported"); put(e,o,"filesystem",l->fs);
#ifdef __APPLE__
  put(e,o,"barrier","fullfsync");
#else
  put(e,o,"barrier","fsync");
#endif
  return o;
});}
napi_value inspect(napi_env e,napi_callback_info info) {return protect(e,[&]{auto a=args(e,info,1); return inspection(e,lease(e,a[0]));});}
napi_value reopen(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,1); auto l=anchor(e,a[0]);
  if(!matches(e,get(e,a[0],"parentIdentity"),stats(l->parent()),false))fail("Recorded parent changed");
  l->workspace=field(e,a[0],"workspace");
  auto names=parts(l->workspace); if(names.size()!=1 || l->workspace.rfind(workspacePrefix,0)!=0)fail("Unsafe recorded workspace", "invalid-input");
  l->work=Fd(relativeOpen(l->parent(),l->workspace,O_RDONLY|O_DIRECTORY,true)); io(l->work.n>=0,"Opening recorded workspace"); l->workIdentity=stats(l->work.n);
  if(!matches(e,get(e,a[0],"workspaceIdentity"),l->workIdentity,false)) { fail("Recorded workspace changed"); }
  workspaceCheck(*l);
  l->expected.st_dev=l->chain[l->rootIndex].identity.st_dev;
  // Recovery leases cannot exchange/cleanup. Workspace privacy may be reasserted.
  return handle(e,std::move(l));
});}
// A separate, cleanup-only recovery capability; ordinary reopen remains read-only.
napi_value reopenCleanup(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,2); auto disposition=str(e,a[1]);
  if(disposition!="abort" && disposition!="committed")fail("Invalid cleanup disposition", "invalid-input");
  auto l=anchor(e,a[0]);
  if(!matches(e,get(e,a[0],"parentIdentity"),stats(l->parent()),false))fail("Recorded parent changed");
  l->workspace=field(e,a[0],"workspace"); auto names=parts(l->workspace);
  if(names.size()!=1 || l->workspace.rfind(workspacePrefix,0)!=0)fail("Unsafe recorded workspace", "invalid-input");
  l->work=Fd(relativeOpen(l->parent(),l->workspace,O_RDONLY|O_DIRECTORY,true)); io(l->work.n>=0,"Opening recorded workspace");
  l->workIdentity=stats(l->work.n);
  if(!matches(e,get(e,a[0],"workspaceIdentity"),l->workIdentity,false))fail("Recorded workspace changed");
  l->expected.st_dev=l->chain[l->rootIndex].identity.st_dev; workspaceCheck(*l);
  l->target=openLeaf(*l,l->parent(),l->leaf); l->slot=openLeaf(*l,l->work.n,"slot"); l->rollback=openLeaf(*l,l->work.n,"rollback");
  bool committed=disposition=="committed";
  auto original=stats(committed?l->slot.n:l->target.n), candidate=stats(committed?l->target.n:l->slot.n), rollback=stats(l->rollback.n);
  if(!matches(e,get(e,a[0],"expected"),original,false) || !matches(e,get(e,a[0],"candidateIdentity"),candidate,false) || !matches(e,get(e,a[0],"rollbackIdentity"),rollback,false))fail("Recorded cleanup layout changed");
  l->expected=original; l->slotIdentity=candidate; l->rollbackIdentity=rollback;
  l->prepared=true; l->attempted=true; l->exchanged=committed;
  return handle(e,std::move(l));
});}
enum class Hook {None,Before,After};
napi_value exchangeImpl(napi_env e,napi_callback_info info,Hook hook) {return protect(e,[&]{
  auto a=args(e,info,hook==Hook::None?1:2); auto& l=lease(e,a[0]);
  if(!l.prepared || l.attempted)return result(e,"no-change","Lease is not prepared or exchange was already attempted");
  try {workspaceCheck(l); currentExpected(l); privateExpected(l,"slot",l.slotIdentity); privateExpected(l,"rollback",l.rollbackIdentity);}
  catch(const Failure& f){return result(e,"no-change",f.what());}
  l.attempted=true;
#ifdef RIO_PUBLICATION_TESTING
  auto callback=[&]{napi_value ignored, receiver; js(napi_get_undefined(e,&receiver)); js(napi_call_function(e,receiver,a[1],0,nullptr,&ignored));};
  if(hook==Hook::Before)callback();
#endif
  int rc=exchange(l.parent(),l.leaf.c_str(),l.work.n,"slot"), error=errno;
  if(rc!=0) {
    // Most local errors imply no change; EIO/EINTR remain explicitly uncertain.
    auto o=result(e,(error==EIO||error==EINTR)?"recovery-required":"no-change",strerror(error));
    put(e,o,"inspection",inspection(e,l)); return o;
  }
  l.exchanged=true;
#ifdef RIO_PUBLICATION_TESTING
  if(hook==Hook::After)callback();
#endif
  try {
    workspaceCheck(l);
    auto displaced=openLeaf(l,l.work.n,"slot"), published=openLeaf(l,l.parent(),l.leaf);
    bool expected=unchanged(l.expected,stats(displaced.n),false) && unchanged(l.slotIdentity,stats(published.n),false);
    auto o=result(e,expected?"exchanged-expected":"exchanged-conflict",expected?"":"Unexpected displaced or published object");
    put(e,o,"inspection",inspection(e,l)); return o;
  } catch(const Failure& f){auto o=result(e,"exchanged-conflict",f.what()); put(e,o,"inspection",inspection(e,l)); return o;}
});}
napi_value exchangeCall(napi_env e,napi_callback_info i){return exchangeImpl(e,i,Hook::None);}
napi_value syncImpl(napi_env e,napi_callback_info info,bool fault) {return protect(e,[&]{
  auto a=args(e,info,1); auto& l=lease(e,a[0]);
  try {
    workspaceCheck(l);
    if(fault)flush(-1);
    auto target=openLeaf(l,l.parent(),l.leaf), slot=openLeaf(l,l.work.n,"slot"), rollback=openLeaf(l,l.work.n,"rollback");
    auto barrier=flush(target.n); flush(slot.n); flush(rollback.n); flush(l.work.n); flush(l.parent());
    auto o=result(e,"synced"); put(e,o,"barrier",barrier); return o;
  } catch(const Failure& f){return result(e,"sync-failed",f.what());}
});}
napi_value syncCall(napi_env e,napi_callback_info i){return syncImpl(e,i,false);}
napi_value cleanup(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,3); auto& l=lease(e,a[0]);
  if(!l.prepared || l.cleaned)return result(e,"no-change","Lease is not an active prepared operation");
  bool removed=false;
  try {
    workspaceCheck(l); auto proof=a[1]; auto disposition=str(e,a[2]);
    if(disposition!="abort" && disposition!="committed")fail("Invalid cleanup disposition");
    auto target=openLeaf(l,l.parent(),l.leaf), slot=openLeaf(l,l.work.n,"slot"), rollback=openLeaf(l,l.work.n,"rollback");
    if(!matches(e,get(e,proof,"target"),stats(target.n),true)||!matches(e,get(e,proof,"slot"),stats(slot.n),true)||!matches(e,get(e,proof,"rollback"),stats(rollback.n),true))fail("Cleanup evidence became stale");
    if(!identity(stats(rollback.n),l.rollbackIdentity) || !identity(stats(target.n),disposition=="abort"?l.expected:l.slotIdentity) || !identity(stats(slot.n),disposition=="abort"?l.slotIdentity:l.expected))fail("Cleanup refuses unexpected object identities");
    Fd scanFd(dup(l.work.n)); io(scanFd.n>=0,"Duplicating workspace descriptor");
    DIR* directory=fdopendir(scanFd.n); io(directory!=nullptr,"Inspecting private directory"); scanFd.n=-1;
    rewinddir(directory);
    std::set<std::string> names; errno=0;
    while(auto entry=readdir(directory)){std::string n(entry->d_name); if(n!="." && n!="..")names.insert(n);}
    int readError=errno; closedir(directory); if(readError)throw Failure("io","Reading private directory",readError);
    if(names!=std::set<std::string>{"slot","rollback"})fail("Unknown workspace content; cleanup refused");
    // Only these two positively identified entries. No recursion or public unlink.
    privateExpected(l,"slot",stats(slot.n)); workspaceCheck(l); io(unlinkat(l.work.n,"slot",0)==0,"Removing verified slot"); removed=true;
    privateExpected(l,"rollback",stats(rollback.n)); workspaceCheck(l); io(unlinkat(l.work.n,"rollback",0)==0,"Removing verified rollback");
    flush(l.work.n); workspaceCheck(l); io(unlinkat(l.parent(),l.workspace.c_str(),AT_REMOVEDIR)==0,"Removing empty owned workspace");
    l.cleaned=true; flush(l.parent()); return result(e,"cleaned");
  } catch(const Failure& f){return result(e,removed?"cleanup-incomplete":"cleanup-refused",f.what());}
});}
napi_value closeLease(napi_env e,napi_callback_info info) {return protect(e,[&]{
  auto a=args(e,info,1); auto& l=lease(e,a[0]); l.alive=false; l.chain.clear(); l.target=Fd();l.work=Fd();l.slot=Fd();l.rollback=Fd(); l.original.clear(); return result(e,"closed");
});}
#ifdef RIO_PUBLICATION_TESTING
napi_value before(napi_env e,napi_callback_info i){return exchangeImpl(e,i,Hook::Before);}
napi_value after(napi_env e,napi_callback_info i){return exchangeImpl(e,i,Hook::After);}
napi_value syncFault(napi_env e,napi_callback_info i){return syncImpl(e,i,true);}
napi_value foreignFilesystem(napi_env e,napi_callback_info info){return protect(e,[&]{
  auto a=args(e,info,2); auto& l=lease(e,a[0]); int32_t fd; js(napi_get_value_int32(e,a[1],&fd)); sameFilesystem(l,fd); return result(e,"same-filesystem");
});}
#ifdef __linux__
napi_value injectAcl(napi_env e,napi_callback_info info){return protect(e,[&]{
  auto a=args(e,info,1); auto& l=lease(e,a[0]); workspaceCheck(l);
  // A named entry for the current UID only; no access granted to another user.
  std::vector<uint8_t> data={2,0,0,0};
  for(auto row:std::vector<std::vector<uint32_t>>{{1,7,0xffffffff},{2,7,uint32_t(geteuid())},{4,0,0xffffffff},{16,0,0xffffffff},{32,0,0xffffffff}}) {
    for(size_t i=0;i<row.size();i++)for(size_t byte=0;byte<(i==2?4:2);byte++)data.push_back(uint8_t(row[i]>>(byte*8)));
  }
  io(fsetxattr(l.work.n,"system.posix_acl_access",data.data(),data.size(),0)==0,"Installing qualification ACL");
  return result(e,"injected");
});}
#endif
#endif
} // namespace
NAPI_MODULE_INIT() {
  napi_property_descriptor methods[]={
    {"open",nullptr,openLease,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"prepare",nullptr,prepare,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"probe",nullptr,probe,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"inspect",nullptr,inspect,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"reopen",nullptr,reopen,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"reopenCleanup",nullptr,reopenCleanup,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"exchange",nullptr,exchangeCall,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"sync",nullptr,syncCall,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"cleanup",nullptr,cleanup,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"close",nullptr,closeLease,nullptr,nullptr,nullptr,napi_default,nullptr},
#ifdef RIO_PUBLICATION_TESTING
    {"exchangeWithInterleave",nullptr,before,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"exchangeWithAfterInterleave",nullptr,after,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"syncWithFailure",nullptr,syncFault,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"checkFilesystem",nullptr,foreignFilesystem,nullptr,nullptr,nullptr,napi_default,nullptr},
#ifdef __linux__
    {"injectWorkspaceAcl",nullptr,injectAcl,nullptr,nullptr,nullptr,napi_default,nullptr},
#endif
#endif
  };
  napi_define_properties(env,exports,sizeof(methods)/sizeof(methods[0]),methods); return exports;
}
