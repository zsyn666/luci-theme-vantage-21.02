#!/usr/bin/env python3
"""构建 luci-theme-vantage 的 LuCI 21.02 移植版 ipk（含原版仪表盘）。

包内容：
  主题      /www/luci-static/vantage/*（vantage.css / icons.css / icons/）
            /usr/lib/lua/luci/view/themes/vantage/{header,footer}.htm
            /www/luci-static/resources/menu-vantage.js
  仪表盘    原版 24.10 前端（app/resources/*）原样部署
            兼容层 resources/{view,dom,poll}.js
            挂载页 view/vantage/original.htm
            后端 controller/vantage.lua + model/vantage.lua
            中文语言包 /www/luci-static/vantage/i18n-zh-cn.js
            ACL /usr/share/rpcd/acl.d/luci-app-vantage.json

用法：  python3 build-ipk.py
"""

import io
import os
import tarfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VERSION = '1.0.20-21.02r13'
OUT = os.path.join(HERE, 'dist', 'luci-theme-vantage_%s_all.ipk' % VERSION)


def rd(*parts):
    with open(os.path.join(HERE, *parts), 'rb') as f:
        return f.read()


def addfile(tf, name, data, mode=0o644):
    ti = tarfile.TarInfo(name)
    ti.size = len(data)
    ti.mode = mode
    ti.mtime = int(time.time())
    ti.uid = ti.gid = 0
    ti.uname = ti.gname = 'root'
    tf.addfile(ti, io.BytesIO(data))


def addpath(tf, arc, path):
    if os.path.isdir(path):
        ti = tarfile.TarInfo(arc)
        ti.type = tarfile.DIRTYPE
        ti.mode = 0o755
        ti.mtime = int(time.time())
        ti.uid = ti.gid = 0
        ti.uname = ti.gname = 'root'
        tf.addfile(ti)
        for n in sorted(os.listdir(path)):
            addpath(tf, arc.rstrip('/') + '/' + n, os.path.join(path, n))
    else:
        with open(path, 'rb') as f:
            addfile(tf, arc, f.read())


UCI_DEFAULTS = """#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
new=0
uci -q get luci.themes.Vantage >/dev/null || new=1
uci -q set luci.themes.Vantage=/luci-static/vantage
[ "$new" = "1" ] && uci -q set luci.main.mediaurlbase=/luci-static/vantage
uci -q commit luci
# 清掉可能残留的旧缓存，让新菜单/翻译立即生效
rm -rf /tmp/luci-modulecache /tmp/luci-indexcache*
exit 0
""".encode()

POSTINST = """#!/bin/sh
[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0
[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0
. ${IPKG_INSTROOT}/lib/functions.sh
default_postinst $0 $@
# 不重启 rpcd：那会作废所有已登录会话（ubus session 存在 rpcd 内存里）。
# ACL 对新会话生效；老会话缺 file.read 时由 luci.vantage fileread 兜底。
exit 0
""".encode()

POSTRM = """#!/bin/sh
[ "$1" = "upgrade" ] && exit 0
[ -n "$IPKG_INSTROOT" ] && exit 0
if [ "$(uci -q get luci.main.mediaurlbase)" = "/luci-static/vantage" ]; then
  uci -q get luci.themes.Argon >/dev/null \
    && uci -q set luci.main.mediaurlbase="/luci-static/argon" \
    || uci -q set luci.main.mediaurlbase="/luci-static/bootstrap"
fi
uci -q delete luci.themes.Vantage
uci -q commit luci
rm -rf /tmp/luci-modulecache /tmp/luci-indexcache*
exit 0
""".encode()

CONTROL = (
    'Package: luci-theme-vantage\n'
    'Version: %s\n'
    'Depends: libc, luci-base, rpcd, rpcd-mod-file, rpcd-mod-iwinfo\n'
    'Source: https://github.com/anothaDev/luci-theme-vantage\n'
    'Section: luci\n'
    'Priority: optional\n'
    'Architecture: all\n'
    'Installed-Size: 900\n'
    'Maintainer: ported for LuCI 21.02\n'
    'Description: Vantage theme and dashboard ported to LuCI 21.02. The original\n'
    ' 24.10 frontend runs unmodified on top of a compatibility layer\n'
    ' (view/dom/poll modules, luci.vantage rpc bridge, Lua backend).\n' % VERSION
).encode()


def main():
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as tf:
        # ---------------- 主题静态资源 ----------------
        addpath(tf, './www/luci-static/vantage', os.path.join(HERE, 'assets'))
        for name in ('vantage-21.02.css', 'vantage-dash.css'):
            addfile(tf, './www/luci-static/vantage/' + name, rd(name))
        addfile(tf, './www/luci-static/vantage/dash.js', rd('dash.js'))
        addfile(tf, './www/luci-static/vantage/i18n-zh-cn.js', rd('i18n', 'i18n-zh-cn.js'))

        # ---------------- 原版仪表盘前端（未改动） ----------------
        addpath(tf, './www/luci-static/resources/vantage',
                os.path.join(HERE, 'app', 'resources', 'vantage'))
        addpath(tf, './www/luci-static/resources/view/vantage',
                os.path.join(HERE, 'app', 'resources', 'view', 'vantage'))

        # ---------------- 21.02 兼容层 ----------------
        for name in ('view', 'dom', 'poll'):
            addfile(tf, './www/luci-static/resources/%s.js' % name,
                    rd('shim', name + '.js'))
        addfile(tf, './www/luci-static/resources/menu-vantage.js', rd('menu-vantage.js'))

        # ---------------- 主题模板 ----------------
        addfile(tf, './usr/lib/lua/luci/view/themes/vantage/header.htm', rd('header.htm'))
        addfile(tf, './usr/lib/lua/luci/view/themes/vantage/footer.htm', rd('footer.htm'))

        # ---------------- 页面模板 ----------------
        addfile(tf, './usr/lib/lua/luci/view/vantage/original.htm', rd('original.htm'))
        addfile(tf, './usr/lib/lua/luci/view/vantage/dashboard.htm', rd('dashboard.htm'))

        # ---------------- 后端 ----------------
        addfile(tf, './usr/lib/lua/luci/controller/vantage.lua', rd('controller-vantage.lua'))
        addfile(tf, './usr/lib/lua/luci/model/vantage.lua', rd('model-vantage.lua'))

        # ---------------- ACL ----------------
        addfile(tf, './usr/share/rpcd/acl.d/luci-app-vantage.json',
                rd('acl', 'luci-app-vantage.json'))

        # ---------------- uci-defaults ----------------
        addfile(tf, './etc/uci-defaults/30_luci-theme-vantage', UCI_DEFAULTS, 0o755)

    control = io.BytesIO()
    with tarfile.open(fileobj=control, mode='w:gz') as tf:
        addfile(tf, './control', CONTROL)
        addfile(tf, './conffiles', b'')
        addfile(tf, './postinst', POSTINST, 0o755)
        addfile(tf, './postrm', POSTRM, 0o755)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with tarfile.open(OUT, 'w:gz') as tf:
        addfile(tf, './debian-binary', b'2.0\n')
        addfile(tf, './control.tar.gz', control.getvalue())
        addfile(tf, './data.tar.gz', data.getvalue())

    print('生成:', OUT, os.path.getsize(OUT), '字节')
    with tarfile.open(OUT, 'r:gz') as tf:
        names = [m.name for m in tf.getmembers()]
        blob = tf.extractfile('./data.tar.gz').read()
    print('外层成员:', names)

    inner = tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz')
    files = [m.name for m in inner.getmembers() if m.isfile()]
    print('data 文件数:', len(files))


if __name__ == '__main__':
    main()
