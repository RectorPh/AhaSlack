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
