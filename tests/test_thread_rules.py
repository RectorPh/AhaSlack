"""The thread rules (static/thread-rules.js), run in Node."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

RULES = Path(__file__).resolve().parent.parent / "static" / "thread-rules.js"
pytestmark = pytest.mark.skipif(not shutil.which("node"), reason="needs Node.js")


def run(msgs, **opts):
    js = f"""
    const r = require({json.dumps(str(RULES))});
    const msgs = {json.dumps(msgs)};
    const o = r.buildThreadsWith(msgs, {{ guesses: {json.dumps(opts.get("guesses", True))}, rules: {json.dumps(opts.get("rules", "v2"))} }});
    console.log(JSON.stringify({{ root: Object.fromEntries(o.rootOf), via: Object.fromEntries(o.via) }}));
    """
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def m(id, who, t, text="", **kw):
    return {"id": id, "ts": t, "date": "2026-11-05 10:00", "text": text, "out": who == "me",
            "sender": {"peer": who, "name": who}, **kw}


def test_reply_chain_and_split_after_a_long_pause():
    r = run([m(1, "a", 0, "deploy xong chưa?"), m(2, "b", 60, "xong rồi", reply_to=1),
             m(3, "c", 4 * 3600, "lại lỗi rồi", reply_to=2), m(4, "a", 4 * 3600 + 30, "để xem", reply_to=3)])
    assert r["root"] == {"2": 1, "4": 3}            # 3 came 4h later: it starts its own thread
    assert r["via"]["2"] == "reply"


def test_lone_reply_to_an_old_unloaded_message_stays_in_channel():
    r = run([m(10, "a", 0, "hello"), m(11, "b", 30, "đây ạ", reply_to=3, thread_top=3)])
    assert "11" not in r["root"] and r["via"]["11"] == "revive"


def test_burst_within_a_minute_but_not_when_talking_to_the_group():
    base = [m(1, "a", 0, "q"), m(2, "b", 10, "trả lời", reply_to=1)]
    assert run(base + [m(3, "b", 40, "thêm ý nữa")])["root"]["3"] == 1
    assert "3" not in run(base + [m(3, "b", 200, "thêm ý nữa")])["root"]           # too late
    assert "3" not in run(base + [m(3, "b", 40, "vô xem thời sự mn")])["root"]     # to everyone
    assert "3" not in run(base + [m(3, "b", 40, "thêm ý nữa")], guesses=False)["root"]


def test_short_answer_from_someone_in_the_thread():
    base = [m(1, "a", 0, "q"), m(2, "b", 10, "anh a check giúp em nhé", reply_to=1)]
    r = run(base + [m(3, "a", 60, "dạ oke")])
    assert r["root"]["3"] == 1 and r["via"]["3"] == "answer"
    assert "3" not in run(base + [m(3, "z", 60, "dạ oke")])["root"]               # not in the thread
    assert "3" not in run(base + [m(3, "a", 60, "ok để anh xem lại toàn bộ luồng rồi báo team sau nhé")])["root"]


def test_classic_rules_are_the_default():
    base = [m(1, "a", 0, "q"), m(2, "b", 10, "trả lời", reply_to=1)]
    r = run(base + [m(3, "b", 100, "mọi người xem thêm")], rules="classic")
    assert r["root"]["3"] == 1 and r["via"]["3"] == "burst"     # 2-minute follow-up, as before
    late = run([m(1, "a", 0, "q"), m(2, "b", 5 * 3600, "lại lỗi", reply_to=1)], rules="classic")
    assert late["root"]["2"] == 1                                # no splitting in classic


def test_local_ai_hint_wins():
    base = [m(1, "a", 0, "q"), m(2, "b", 10, "trả lời", reply_to=1)]
    r = run(base + [m(3, "c", 30, "đúng rồi", thread_hint=1)], rules="classic")
    assert r["root"]["3"] == 1 and r["via"]["3"] == "ai"
    r = run(base + [m(3, "b", 30, "chuyện khác", thread_hint=0)], rules="classic")
    assert "3" not in r["root"] and r["via"]["3"] == "ai-none"  # the AI said no: no 2-minute guess
