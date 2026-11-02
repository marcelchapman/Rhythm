// Research-only descriptor helpers. Never part of Rio's build or package.
#include <node_api.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstring>
#include <string>
#include <stdexcept>
#include <cerrno>
namespace {
void need(bool v,const char *s){if(!v)throw std::runtime_error(s);}
int integer(napi_env e,napi_value v){int32_t n;need(napi_get_value_int32(e,v,&n)==napi_ok,"fd argument");return n;}
std::string string(napi_env e,napi_value v){char b[4096];size_t n;need(napi_get_value_string_utf8(e,v,b,sizeof(b),&n)==napi_ok&&n<sizeof(b)-1,"text argument");return std::string(b,n);}
napi_value number(napi_env e,int n){napi_value v;napi_create_int32(e,n,&v);return v;}
template<class F>napi_value safe(napi_env e,napi_callback_info i,size_t count,F f){try{napi_value a[2];size_t n=2;need(napi_get_cb_info(e,i,&n,a,nullptr,nullptr)==napi_ok&&n==count,"argument count");return f(a);}catch(const std::exception &x){napi_throw_error(e,nullptr,x.what());return nullptr;}}
void local(int fd){struct statfs s;need(fstatfs(fd,&s)==0&&!strcmp(s.f_fstypename,"apfs")&&(s.f_flags&MNT_LOCAL)&&!(s.f_flags&MNT_RDONLY),"require writable local APFS fixture");}
std::string component(napi_env e,napi_value v){auto s=string(e,v);need(!s.empty()&&s!="."&&s!=".."&&s.find('/')==std::string::npos&&s.find('\0')==std::string::npos,"single component only");return s;}
napi_value directory(napi_env e,napi_callback_info i){return safe(e,i,1,[&](napi_value *a){auto s=string(e,a[0]);need(s.rfind("/private/tmp/rio-apfs-design-",0)==0,"disposable fixture prefix");int fd=open(s.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);need(fd>=0,"open fixture directory");local(fd);return number(e,fd);});}
napi_value create(napi_env e,napi_callback_info i){return safe(e,i,2,[&](napi_value *a){int d=integer(e,a[0]);local(d);auto s=component(e,a[1]);int fd=openat(d,s.c_str(),O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);if(fd<0)throw std::runtime_error(std::string("exclusive create: ")+strerror(errno));return number(e,fd);});}
napi_value read(napi_env e,napi_callback_info i){return safe(e,i,2,[&](napi_value *a){int d=integer(e,a[0]);local(d);auto s=component(e,a[1]);int fd=openat(d,s.c_str(),O_RDONLY|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);if(fd<0)throw std::runtime_error(std::string("read open: ")+strerror(errno));return number(e,fd);});}
napi_value flush(napi_env e,napi_callback_info i){return safe(e,i,1,[&](napi_value *a){int fd=integer(e,a[0]);local(fd);need(fsync(fd)==0&&fcntl(fd,F_FULLFSYNC)==0,"required file/directory flush");return number(e,0);});}
napi_value close(napi_env e,napi_callback_info i){return safe(e,i,1,[&](napi_value *a){need(::close(integer(e,a[0]))==0,"close");return number(e,0);});}
}
NAPI_MODULE_INIT(){napi_property_descriptor p[]={{"directory",nullptr,directory,nullptr,nullptr,nullptr,napi_default,nullptr},{"create",nullptr,create,nullptr,nullptr,nullptr,napi_default,nullptr},{"read",nullptr,read,nullptr,nullptr,nullptr,napi_default,nullptr},{"flush",nullptr,flush,nullptr,nullptr,nullptr,napi_default,nullptr},{"close",nullptr,close,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,5,p);return exports;}
