# Maintainer: Asif Arbaj <asifarbaj@gmail.com>
_name=foxkit
pkgname=totoro-foxkit
pkgver=r0
pkgrel=1
pkgdesc="foxkit's native messaging host for Firefox: Play with MPV (the extension is installed in Firefox)"
arch=('any')
url="https://github.com/anisthdev/foxkit"
provides=('foxkit')
conflicts=('foxkit')
replaces=('foxkit')
license=('unknown')
depends=('python' 'yt-dlp' 'mpv')
makedepends=('git')
source=("git+$url.git")
sha256sums=('SKIP')

pkgver() {
    cd "$_name"
    printf "r%s.%s" "$(git rev-list --count HEAD)" "$(git rev-parse --short=7 HEAD)"
}

package() {
    cd "$_name"
    install -Dm755 native/foxkit_host.py "$pkgdir/usr/lib/foxkit/foxkit_host.py"
    # Firefox's system-wide native messaging hosts
    install -d "$pkgdir/usr/lib/mozilla/native-messaging-hosts"
    cat >"$pkgdir/usr/lib/mozilla/native-messaging-hosts/foxkit.json" <<JSON
{
  "name": "foxkit",
  "description": "foxkit native helper",
  "path": "/usr/lib/foxkit/foxkit_host.py",
  "type": "stdio",
  "allowed_extensions": ["foxkit@asif"]
}
JSON
}
