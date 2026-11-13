import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import convos  # noqa: E402


def convo(cid, *questions, updated=0):
    h = []
    for q in questions:
        h += [{"role": "user", "text": q}, {"role": "assistant", "text": "ok", "tools": []}]
    return {"id": cid, "started": updated - 10, "updated": updated, "session_id": "s-" + cid, "history": h}


def test_keeps_conversations_newest_first(tmp_path):
    a = convos.Archive(tmp_path / "arch")
    a.save(convo("aaaaaaaaaaaa", "What needs me today?", updated=100))
    a.save(convo("bbbbbbbbbbbb", "Who tagged me?", "And yesterday?", updated=200))
    assert [(c["id"], c["title"], c["count"]) for c in a.list()] == [
        ("bbbbbbbbbbbb", "Who tagged me?", 2), ("aaaaaaaaaaaa", "What needs me today?", 1)]
    assert a.load("aaaaaaaaaaaa")["session_id"] == "s-aaaaaaaaaaaa"
    a.remove("aaaaaaaaaaaa")
    assert [c["id"] for c in a.list()] == ["bbbbbbbbbbbb"]


def test_skips_empty_and_rejects_bad_ids(tmp_path):
    a = convos.Archive(tmp_path)
    a.save(convo("cccccccccccc"))                 # nothing asked: not kept
    assert a.list() == []
    for bad in ("../manager", "current", "", "cccccccccccc"):
        with pytest.raises(KeyError):
            a.load(bad)
    (tmp_path / "dddddddddddd.json").write_text("{half")  # a broken file doesn't break the list
    assert a.list() == []


def test_title_is_first_question_trimmed():
    long = "x " * 100
    assert convos.title_of([{"role": "assistant", "text": "hi"}, {"role": "user", "text": "  a\n b "}]) == "a b"
    assert convos.title_of([{"role": "user", "text": long}]).endswith("…")
    assert convos.title_of([]) == "Untitled conversation"
