// Read-only, descriptor-bound APFS playback snapshots. Invoked only in a worker.
// No publication, SQLite, renderer paths, recursive deletion or copy fallback.
#include <node_api.h>
#include <sys/clonefile.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <cerrno>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <chrono>
// Unconfigured research builds retain the former fail-closed ceiling.
#ifndef RIO_MAX_FLAC_BYTES
#define RIO_MAX_FLAC_BYTES (64ULL * 1024 * 1024)
#endif
namespace {
constexpr size_t limit=RIO_MAX_FLAC_BYTES, chunkLimit=256*1024;
const napi_type_tag tag={0x736f757263657269ULL,0x6f327334636c6f6eULL};
struct Error:std::runtime_error {std::string code;Error(std::string c,std::string m):std::runtime_error(m),code(c){}};
void fail(const char* message,const char* code="ESTALE"){throw Error(code,message);}
void io(bool ok,const char* message){if(!ok){int n=errno;const char* code=n==ENOSPC?"ENOSPC":n==EIO?"EIO":n==EROFS?"EROFS":n==ENOENT?"ENOENT":n==EACCES?"EACCES":n==EXDEV?"EXDEV":n==ENOTSUP?"ENOTSUP":"EIO";throw Error(code,std::string(message)+": "+strerror(n));}}
void js(napi_status s){if(s!=napi_ok)fail("Invalid playback source argument","EINVAL");}
napi_value object(napi_env e){napi_value v;js(napi_create_object(e,&v));return v;}
napi_value number(napi_env e,double n){napi_value v;js(napi_create_double(e,n,&v));return v;}
void put(napi_env e,napi_value v,const char* k,napi_value value){js(napi_set_named_property(e,v,k,value));}
std::string field(napi_env e,napi_value v,const char* key){napi_value a;js(napi_get_named_property(e,v,key,&a));size_t n;js(napi_get_value_string_utf8(e,a,nullptr,0,&n));if(n>8192)fail("Oversized playback path","EINVAL");std::vector<char> b(n+1);js(napi_get_value_string_utf8(e,a,b.data(),b.size(),&n));if(memchr(b.data(),0,n))fail("NUL in playback argument","EINVAL");return {b.data(),n};}
struct Fd {int n=-1;explicit Fd(int f=-1):n(f){}~Fd(){if(n>=0)close(n);}Fd(const Fd&)=delete;Fd& operator=(const Fd&)=delete;Fd(Fd&& f)noexcept:n(f.n){f.n=-1;}Fd& operator=(Fd&& f)noexcept{if(n>=0)close(n);n=f.n;f.n=-1;return *this;}};
struct stat stats(int fd){struct stat s{};io(fstat(fd,&s)==0,"Playback source stat");return s;}
bool identity(const struct stat& a,const struct stat& b){return a.st_dev==b.st_dev&&a.st_ino==b.st_ino&&(a.st_mode&S_IFMT)==(b.st_mode&S_IFMT);}
bool same(const struct stat& a,const struct stat& b){return identity(a,b)&&a.st_size==b.st_size&&a.st_nlink==b.st_nlink&&a.st_mode==b.st_mode&&a.st_uid==b.st_uid&&a.st_gid==b.st_gid&&a.st_mtimespec.tv_sec==b.st_mtimespec.tv_sec&&a.st_mtimespec.tv_nsec==b.st_mtimespec.tv_nsec&&a.st_ctimespec.tv_sec==b.st_ctimespec.tv_sec&&a.st_ctimespec.tv_nsec==b.st_ctimespec.tv_nsec;}
std::vector<std::string> components(const std::string& p){std::vector<std::string> v;size_t at=0;while(at<p.size()){auto end=p.find('/',at);if(end==std::string::npos)end=p.size();auto s=p.substr(at,end-at);if(s.empty()||s=="."||s==".."||s.find('\\')!=std::string::npos)fail("Unsafe playback path","EINVAL");v.push_back(s);at=end+1;}if(v.empty())fail("Empty playback path","EINVAL");return v;}
struct Part {Fd fd;std::string name;struct stat id;Part(int f,std::string n):fd(f),name(std::move(n)),id(stats(f)){}};
struct Lease {
 std::vector<Part> chain;size_t root=0;Fd original,clone;struct stat expected{},snapshot{};std::string leaf;bool closed=false;double cloneMs=0;
 void roots(){if(closed)fail("Playback source closed");for(size_t i=0;i<chain.size();i++){if(!identity(stats(chain[i].fd.n),chain[i].id))fail("Playback ancestor changed");if(i){struct stat named{};io(fstatat(chain[i-1].fd.n,chain[i].name.c_str(),&named,AT_SYMLINK_NOFOLLOW)==0,"Playback ancestor unavailable");if(!identity(named,chain[i].id)||!S_ISDIR(named.st_mode))fail("Playback ancestor replaced");}}struct statfs f{};io(fstatfs(chain[root].fd.n,&f)==0,"Playback volume unavailable");if(strcmp(f.f_fstypename,"apfs")||!(f.f_flags&MNT_LOCAL))fail("Playback clones require local APFS","ENOTSUP");if(f.f_flags&MNT_RDONLY)fail("Playback volume is read only","EROFS");}
 void current(){roots();struct stat named{};io(fstatat(chain.back().fd.n,leaf.c_str(),&named,AT_SYMLINK_NOFOLLOW)==0,"Playback original unavailable");if(!same(stats(original.n),expected)||!same(named,expected))fail("Playback original changed during capture");}
 void ready(){roots();auto s=stats(clone.n);if(!identity(s,snapshot)||!S_ISREG(s.st_mode)||s.st_nlink!=0||s.st_size!=snapshot.st_size||s.st_mtimespec.tv_sec!=snapshot.st_mtimespec.tv_sec||s.st_mtimespec.tv_nsec!=snapshot.st_mtimespec.tv_nsec)fail("Playback snapshot changed");}
 void closeAll(){closed=true;clone=Fd();original=Fd();chain.clear();}
};
// Move-only descriptors close on partial capture failure and worker teardown.
template<class F> napi_value protect(napi_env e,F f){try{return f();}catch(const Error& x){napi_throw_error(e,x.code.c_str(),x.what());return nullptr;}catch(const std::exception& x){napi_throw_error(e,"EIO",x.what());return nullptr;}}
std::vector<napi_value> args(napi_env e,napi_callback_info info,size_t count){std::vector<napi_value> a(count);size_t n=count;js(napi_get_cb_info(e,info,&n,a.data(),nullptr,nullptr));if(n!=count)fail("Wrong playback argument count","EINVAL");return a;}
Lease& held(napi_env e,napi_value v){bool valid=false;js(napi_check_object_type_tag(e,v,&tag,&valid));if(!valid)fail("Invalid playback capability","EINVAL");void* p;js(napi_get_value_external(e,v,&p));return *static_cast<Lease*>(p);}
// Classification only: no file copy, scratch creation, or fallback after capture.
napi_value support(napi_env e,napi_callback_info info){return protect(e,[&]{auto a=args(e,info,1);auto root=field(e,a[0],"root");if(root.size()<2||root[0]!='/')fail("Require absolute managed root","EINVAL");auto parts=components(root.substr(1));if(parts.size()>32)fail("Playback path depth exceeds descriptor budget","ENOTSUP");Fd current(open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC));for(const auto& part:parts){Fd next(openat(current.n,part.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));io(next.n>=0,"Opening playback classification root");current=std::move(next);}auto id=stats(current.n);if(std::to_string(id.st_dev)!=field(e,a[0],"rootDevice")||std::to_string(id.st_ino)!=field(e,a[0],"rootInode"))fail("Playback classification root changed");struct statfs f{};io(fstatfs(current.n,&f)==0,"Classifying playback volume");napi_value result;js(napi_get_boolean(e,strcmp(f.f_fstypename,"apfs")==0&&(f.f_flags&MNT_LOCAL)&&!(f.f_flags&MNT_RDONLY),&result));return result;});}
napi_value capture(napi_env e,napi_callback_info info){return protect(e,[&]{
 auto a=args(e,info,1);auto l=std::make_unique<Lease>();auto root=field(e,a[0],"root");if(root.size()<2||root[0]!='/')fail("Require absolute managed root","EINVAL");
 auto rootParts=components(root.substr(1)),relative=components(field(e,a[0],"relative"));if(rootParts.size()+relative.size()>32)fail("Playback path depth exceeds descriptor budget","ENOTSUP");l->chain.emplace_back(open("/",O_RDONLY|O_DIRECTORY|O_CLOEXEC),"");
 for(const auto& part:rootParts){int f=openat(l->chain.back().fd.n,part.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);io(f>=0,"Opening managed playback root");l->chain.emplace_back(f,part);}
 l->root=l->chain.size()-1;auto rootId=l->chain.back().id;if(std::to_string(rootId.st_dev)!=field(e,a[0],"rootDevice")||std::to_string(rootId.st_ino)!=field(e,a[0],"rootInode"))fail("Managed playback root identity changed");
 for(size_t i=0;i+1<relative.size();i++){int f=openat(l->chain.back().fd.n,relative[i].c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);io(f>=0,"Opening playback parent");l->chain.emplace_back(f,relative[i]);if(l->chain.back().id.st_dev!=rootId.st_dev)fail("Cross-volume playback parent","EXDEV");}
 l->leaf=relative.back();l->original=Fd(openat(l->chain.back().fd.n,l->leaf.c_str(),O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC));io(l->original.n>=0,"Opening playback original");l->expected=stats(l->original.n);auto s=l->expected;
 if(!S_ISREG(s.st_mode))fail("Playback target is not a regular file","ENOTSUP");
 if(s.st_nlink!=1)fail("Playback target has unexpected hard links","EMLINK");
 if(s.st_size<=0||(s.st_flags&(UF_IMMUTABLE|SF_IMMUTABLE|UF_APPEND|SF_APPEND|SF_DATALESS)))fail("Playback target is empty or immutable","ENOTSUP");
 if(uint64_t(s.st_size)>limit)throw Error("EFBIG","FLAC exceeds supported "+std::to_string(limit/(1024*1024))+" MiB file-size limit");
 if(s.st_dev!=rootId.st_dev)fail("Cross-volume playback original","EXDEV");if(std::to_string(s.st_dev)!=field(e,a[0],"device")||std::to_string(s.st_ino)!=field(e,a[0],"inode"))fail("Playback receipt identity changed");
 l->current();struct statfs volume{};io(fstatfs(l->original.n,&volume)==0,"Playback volume unavailable");if(strcmp(volume.f_fstypename,"apfs")||!(volume.f_flags&MNT_LOCAL)||(volume.f_flags&MNT_RDONLY))fail("Playback original is not writable local APFS","ENOTSUP");
 if(uint64_t(volume.f_bavail)*volume.f_bsize<uint64_t(s.st_size)+16*1024*1024)fail("Insufficient playback snapshot space","ENOSPC");
 int rootFd=l->chain[l->root].fd.n;Fd scan(dup(rootFd));io(scan.n>=0,"Opening scratch inventory");DIR* directory=fdopendir(scan.n);io(directory!=nullptr,"Reading scratch inventory");scan.n=-1;bool orphan=false;errno=0;while(auto item=readdir(directory)){if(strncmp(item->d_name,".rio-playback-",14)==0){orphan=true;break;}}int scanError=errno;closedir(directory);if(scanError){errno=scanError;io(false,"Reading scratch inventory");}if(orphan)fail("Unfinished playback scratch state requires review");
 const auto workspace=field(e,a[0],"workspace");if(workspace.size()!=50||workspace.compare(0,14,".rio-playback-")||workspace.find('/')!=std::string::npos||workspace.find('\\')!=std::string::npos)fail("Invalid private playback workspace","EINVAL");
 io(mkdirat(rootFd,workspace.c_str(),0700)==0,"Creating private playback workspace");Fd work(openat(rootFd,workspace.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC));io(work.n>=0,"Opening private playback workspace");const auto workId=stats(work.n);bool named=false;
 auto cleanup=[&]{struct stat child{};if(named&&fstatat(work.n,"audio",&child,AT_SYMLINK_NOFOLLOW)==0&&l->clone.n>=0&&identity(child,stats(l->clone.n)))io(unlinkat(work.n,"audio",0)==0,"Removing owned playback name");struct stat dir{};if(fstatat(rootFd,workspace.c_str(),&dir,AT_SYMLINK_NOFOLLOW)==0&&identity(dir,workId))io(unlinkat(rootFd,workspace.c_str(),AT_REMOVEDIR)==0,"Removing empty playback workspace");};
 try {auto started=std::chrono::steady_clock::now();io(fclonefileat(l->original.n,work.n,"audio",CLONE_NOOWNERCOPY)==0,"Cloning playback source");named=true;l->clone=Fd(openat(work.n,"audio",O_RDONLY|O_NOFOLLOW|O_CLOEXEC));io(l->clone.n>=0,"Opening cloned playback object");l->snapshot=stats(l->clone.n);if(!S_ISREG(l->snapshot.st_mode)||l->snapshot.st_nlink!=1||l->snapshot.st_size!=s.st_size||l->snapshot.st_dev!=s.st_dev||l->snapshot.st_ino==s.st_ino)fail("Invalid playback clone identity");l->current();cleanup();named=false;l->cloneMs=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();l->ready();}
 catch(...){try{cleanup();}catch(...){}throw;}
 auto result=object(e);napi_value handle;js(napi_create_external(e,l.get(),[](napi_env,void* p,void*){delete static_cast<Lease*>(p);},nullptr,&handle));l.release();js(napi_type_tag_object(e,handle,&tag));put(e,result,"handle",handle);auto& lease=held(e,handle);put(e,result,"size",number(e,double(lease.snapshot.st_size)));put(e,result,"cloneMs",number(e,lease.cloneMs));return result;
 });}
napi_value check(napi_env e,napi_callback_info info){return protect(e,[&]{auto a=args(e,info,2);auto& l=held(e,a[0]);bool original;js(napi_get_value_bool(e,a[1],&original));l.ready();if(original)l.current();return number(e,double(l.snapshot.st_size));});}
napi_value read(napi_env e,napi_callback_info info){return protect(e,[&]{auto a=args(e,info,3);auto& l=held(e,a[0]);int64_t at,n;js(napi_get_value_int64(e,a[1],&at));js(napi_get_value_int64(e,a[2],&n));if(at<0||n<0||n>int64_t(chunkLimit)||at>l.snapshot.st_size||n>l.snapshot.st_size-at)fail("Invalid playback read range","EINVAL");l.ready();napi_value bytes;void* memory;js(napi_create_buffer(e,size_t(n),&memory,&bytes));size_t done=0;while(done<size_t(n)){auto got=pread(l.clone.n,static_cast<char*>(memory)+done,size_t(n)-done,off_t(at+done));if(got<0&&errno==EINTR)continue;io(got>=0,"Reading playback snapshot");if(!got)fail("Truncated playback snapshot","EIO");done+=size_t(got);}l.ready();return bytes;});}
napi_value close(napi_env e,napi_callback_info info){return protect(e,[&]{auto a=args(e,info,1);held(e,a[0]).closeAll();napi_value v;js(napi_get_undefined(e,&v));return v;});}
}
NAPI_MODULE_INIT(){napi_property_descriptor d[]={{"support",nullptr,support,nullptr,nullptr,nullptr,napi_default,nullptr},{"capture",nullptr,capture,nullptr,nullptr,nullptr,napi_default,nullptr},{"check",nullptr,check,nullptr,nullptr,nullptr,napi_default,nullptr},{"read",nullptr,read,nullptr,nullptr,nullptr,napi_default,nullptr},{"close",nullptr,close,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,5,d);return exports;}
