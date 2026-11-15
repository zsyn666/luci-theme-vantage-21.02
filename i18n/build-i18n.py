#!/usr/bin/env python3
"""把官方 .po 编译成 LuCI 21.02 可用的前端翻译补丁。

LuCI 21.02 的 `_()` 是：
    function _(s, c) {
        var k = (c != null ? trimws(c) + '\u0001' : '') + trimws(s);
        return (window.TR && TR[sfh(k)]) || s;
    }
即 key = [context + \x01] + source，再对 key 取 sfh() 哈希查 window.TR。

21.02 的 i18n 只加载 base 目录，24.10 的 vantage.zh-cn.lmo 又是新格式，
所以这里把 po 直接编译成一段 JS：用页面自带的 sfh() 算哈希后写进 TR。

同一批 po 里，有些字符串带 msgctxt、有些不带，而前端的调用方式并不严格对应。
因此每条译文同时登记「带上下文的 key」和「纯文本 key」，避免漏译。
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# 少量覆盖：24.10 的 base 目录把 "Signal" 译为「信号强度」，
# 21.02 的 base 目录译作「信号」；仪表盘卡片标题按参考图统一。
OVERRIDES = {
    "Signal": "信号强度",
}


def unquote(s):
    out = []
    i = 0
    mapping = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "0": "\0"}
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append(mapping.get(s[i + 1], s[i + 1]))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def parse_po(path):
    """返回 [(msgctxt or None, msgid, msgstr)]。"""
    entries = []
    ctxt = None          # 已读到、尚未被某条 msgid 认领的 msgctxt
    cur = {"ctxt": None, "id": None, "str": None}
    field = None

    def flush():
        if cur["id"] and cur["str"]:
            entries.append((cur["ctxt"], cur["id"], cur["str"]))
        cur.update({"ctxt": None, "id": None, "str": None})

    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            if line.startswith("#~"):
                continue
            if not line.strip() or line.startswith("#"):
                continue

            if line.startswith("msgctxt "):
                flush()
                ctxt = unquote(line[8:].strip()[1:-1])
                field = "ctxt"
            elif line.startswith("msgid "):
                flush()
                cur["ctxt"] = ctxt
                ctxt = None
                cur["id"] = unquote(line[6:].strip()[1:-1])
                field = "id"
            elif line.startswith("msgstr "):
                cur["str"] = unquote(line[7:].strip()[1:-1])
                field = "str"
            elif line.startswith('"'):
                val = unquote(line.strip()[1:-1])
                if field == "id":
                    cur["id"] = (cur["id"] or "") + val
                elif field == "str":
                    cur["str"] = (cur["str"] or "") + val
                elif field == "ctxt":
                    ctxt = (ctxt or "") + val
        flush()

    return entries


def main():
    sources = [
        ("vantage.po", "luci-app-vantage"),
        ("vantage-theme.po", "luci-theme-vantage"),
    ]

    table = {}       # 精确 key -> 译文
    plain = {}       # 纯文本 key -> 译文（兜底）

    for fn, _label in sources:
        path = os.path.join(HERE, fn)
        if not os.path.exists(path):
            print("跳过 %s（不存在）" % fn, file=sys.stderr)
            continue

        n = 0
        for ctxt, mid, mstr in parse_po(path):
            if not mid:
                continue
            n += 1
            if ctxt:
                table.setdefault(ctxt + "\x01" + mid, mstr)
            else:
                table.setdefault(mid, mstr)
            plain.setdefault(mid, mstr)
        print("%s: %d 条" % (fn, n))

    # 纯文本兜底：前端有时不带 context 调用，但 po 里是带 msgctxt 的条目
    for k, v in plain.items():
        table.setdefault(k, v)

    # 反向兜底：前端大量使用 _('X', 'vantage')，而 po 里不少条目是不带 msgctxt
    # 的纯文本；_() 查的是 "vantage\x01X"，所以要把纯文本条目也登记到该上下文下。
    for ctxt in ('vantage', 'vantage-theme'):
        for k, v in plain.items():
            table.setdefault(ctxt + "\x01" + k, v)

    for k, v in OVERRIDES.items():
        table[k] = v

    payload = json.dumps(table, ensure_ascii=False, separators=(",", ":"))
    js = (
        "/* 由 build-i18n.py 从官方 po 自动生成，勿手改。 */\n"
        "(function () {\n"
        "\tif (typeof window === 'undefined' || typeof window.sfh !== 'function')\n"
        "\t\treturn;\n"
        "\tvar src = " + payload + ";\n"
        "\twindow.TR = window.TR || {};\n"
        "\tfor (var k in src)\n"
        "\t\twindow.TR[window.sfh(k)] = src[k];\n"
        "})();\n"
    )

    out = os.path.join(HERE, "i18n-zh-cn.js")
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(js)
    print("生成 %s: %d 字节 / %d 条" % (out, len(js), len(table)))


if __name__ == "__main__":
    main()
