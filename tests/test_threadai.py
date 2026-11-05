import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import threadai  # noqa: E402


def m(id, who, ts, text="", **kw):
    return {"id": id, "ts": ts, "text": text, "out": False, "sender": {"name": who}, **kw}


def test_only_messages_without_reply_while_a_thread_is_open():
    msgs = [m(1, "A", 0, "deploy chưa?"), m(2, "B", 30, "xong rồi", reply_to=1),
            m(3, "A", 60, "ok cảm ơn"), m(4, "C", 2000, "lunch?")]
    c = threadai.candidates(msgs, known={})
    assert [x[0]["id"] for x in c] == [3]                 # 4 comes after the thread went quiet
    _, threads, _ = c[0]
    assert threads[0][0] == 1 and [x["id"] for x in threads[0][1]] == [1, 2]
    assert threadai.candidates(msgs, known={3: 1}) == []  # judged before: not again
    assert 'NEW message from A: "ok cảm ơn"' in threadai._prompt(*c[0])
