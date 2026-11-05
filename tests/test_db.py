import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from db import MentionDB  # noqa: E402


def mk(i, unread=True, chat=1, kind="mention"):
    return {"key": f"{chat}:{i}", "id": i, "chat": {"id": chat}, "kind": kind, "ts": time.time() - i, "unread": unread}


def test_history_is_kept_and_read_state_sticks(tmp_path):
    d = MentionDB(tmp_path / "t.db")
    d.upsert([mk(1), mk(2), mk(3, unread=False), mk(4, chat=2)], read_keys={"1:2"})
    assert d.count() == 4
    assert d.unread_count() == 2
    assert d.unread_count({2}) == 1  # ignored chats don't count
    d.mark(["1:1"])
    d.upsert([mk(1)])  # a re-fetch never turns a seen mention unread again
    assert d.unread_count() == 1


def test_reading_a_chat_reads_its_mentions(tmp_path):
    d = MentionDB(tmp_path / "t.db")
    d.upsert([mk(4, chat=2), mk(9, chat=2)])
    assert d.mark_chat_read(2, 5) == ["2:4"]
    assert d.unread_count() == 1


def test_list_filters_and_pages(tmp_path):
    d = MentionDB(tmp_path / "t.db")
    d.upsert([mk(1), mk(2, unread=False, kind="reply"), mk(3)])
    items, more = d.list(limit=2)
    assert [m["key"] for m in items] == ["1:1", "1:2"] and more
    assert [m["key"] for m in d.list(filter="unread")[0]] == ["1:1", "1:3"]
    assert [m["key"] for m in d.list(filter="reply")[0]] == ["1:2"]
    older, _ = d.list(before=items[-1]["ts"])
    assert [m["key"] for m in older] == ["1:3"]


def test_threads_you_are_in(tmp_path):
    d = MentionDB(tmp_path / "t.db")
    reply = lambda i, out=False: {"id": i, "ts": 1000 + i, "out": out, "text": f"r{i}"}
    d.thread_touch(1, 10, reply=reply(11, out=True), mine=True)        # you reply in thread 10
    d.thread_touch(1, 10, reply=reply(12), unread=True)                # someone answers
    d.thread_touch(1, 10, reply=reply(13), unread=True)
    assert d.thread_root(1, 12) == 10 and d.thread_root(1, 99) == 99  # reply chains resolve to the root
    assert d.thread_has(1, 13) and not d.thread_has(1, 14)
    assert d.thread_unread_count() == 1
    [t], more = d.thread_list()
    assert not more and t["replies"] == 3 and t["unread"] == 2 and t["mine"] == 1 and t["last"]["id"] == 13
    d.thread_set_root(1, 10, {"id": 10, "text": "root"})
    assert d.thread_read(1, 10) and d.thread_unread_count() == 0
    assert d.thread_list()[0][0]["root"]["text"] == "root"
    assert d.thread_unread_count({1}) == 0


def test_thread_read_unread_and_read_all(tmp_path):
    d = MentionDB(tmp_path / "t.db")
    r = lambda i: {"id": i, "ts": 1000 + i, "out": False}
    d.thread_touch(1, 10, reply=r(11), unread=True)
    d.thread_touch(2, 20, reply=r(21), unread=True)
    d.thread_touch(3, 30, reply=r(31), unread=True)
    assert d.thread_read(1, 10) and d.thread_unread_count() == 2
    assert d.thread_mark_unread(1, 10) and d.thread_unread_count() == 3
    assert d.thread_read_all(exclude_chats={3}) == 2   # ignored chats are left alone
    assert d.thread_unread_count() == 1 and d.thread_unread_count({3}) == 0


def test_frecency_prefers_recent_and_frequent(tmp_path, monkeypatch):
    d = MentionDB(tmp_path / "t.db")
    clock = [1_000_000.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    for _ in range(5):                 # chat 1: five sends today
        d.add_visit(1, "send"); clock[0] += 120
    d.add_visit(2, "open")             # chat 2: one look today
    d.add_visit(2, "open")             # ...again within a minute: not counted twice
    clock[0] += 40 * 86400
    d.add_visit(3, "open")             # chat 3: today; chats 1 and 2 are now 40 days old
    f = d.frecency()
    assert f[1] > f[3] > f[2]          # many old sends > one fresh look > one old look
    assert len([r for r in d.conn.execute("SELECT * FROM visits WHERE chat_id = 2")]) == 1


def test_picks_remember_what_you_typed(tmp_path):
    d = MentionDB(tmp_path / "t.db")
    d.add_visit(7, "switch", "Lin")
    d.add_visit(7, "switch", "lin")
    d.add_visit(8, "switch", "lin")
    assert d.picks()[0] == ["lin", 7, 2]
